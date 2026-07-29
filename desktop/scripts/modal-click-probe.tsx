/**
 * Clicks the REAL CatalogBrowser and checks the click does not escape it.
 *
 * The reported bug: opening the model catalog from the provider editor and
 * clicking anything — a row, the search box, the Add button — dismissed the
 * whole editor. The catalog is rendered INSIDE the editor's backdrop, and that
 * backdrop closed on any click that bubbled up to it.
 *
 * A screenshot cannot show this, and reading the JSX only shows that a handler
 * is present, not that it fires first. So this mounts the component in a real
 * DOM and dispatches real clicks, with a spy standing in for the parent
 * backdrop's onClose.
 *
 * Run under Electron: it needs a DOM, and Electron is already a dependency.
 */

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { CatalogBrowser } from '../src/renderer/components/providers/CatalogBrowser'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

declare const window: Window & typeof globalThis & { electronAPI?: unknown }

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// Stub the bridge the catalog reads on mount.
window.electronAPI = {
  providers: {
    catalogProviders: async () => ({
      ok: true,
      ageMs: 0,
      providers: [
        { id: 'openai', label: 'OpenAI', modelCount: 2, envVars: [] },
      ],
    }),
    catalogModels: async () => ({
      ok: true,
      models: [
        {
          id: 'gpt-4o',
          label: 'GPT-4o',
          modalities: ['text', 'image'],
          contextLength: 128000,
          supportsEffort: false,
          toolCall: true,
          openWeights: false,
        },
      ],
    }),
  },
}

/**
 * The fix has two independent halves and each must hold on its own:
 *
 *   - the CHILD stops its clicks, so it is safe inside ANY parent, including
 *     one written the old way;
 *   - the PARENT ignores bubbled clicks, so a future child that forgets does
 *     not take the editor down with it.
 *
 * Testing only against the fixed parent would let the child's half rot
 * unnoticed, so `legacyParent` reproduces the original hazard deliberately.
 */
async function main(): Promise<void> {
  let parentClosed = 0
  let catalogClosed = 0
  const added: unknown[] = []

  const host = document.createElement('div')
  document.body.appendChild(host)

  const backdrop = document.createElement('div')
  backdrop.id = 'parent-backdrop'
  backdrop.addEventListener('click', (e) => {
    // What ProviderSettings now does: only its OWN clicks close it.
    if (e.target === e.currentTarget) parentClosed++
  })
  host.appendChild(backdrop)

  // The hazard as it was: closes on ANY click that reaches it.
  let legacyClosed = 0
  const legacyParent = document.createElement('div')
  legacyParent.addEventListener('click', () => legacyClosed++)
  backdrop.appendChild(legacyParent)

  const mount = document.createElement('div')
  legacyParent.appendChild(mount)

  const root = createRoot(mount)
  await act(async () => {
    root.render(
      createElement(CatalogBrowser, {
        kind: 'openai',
        baseURL: 'https://api.openai.com/v1',
        existingNames: new Set<string>(),
        onAdd: (m: unknown) => added.push(m),
        onClose: () => catalogClosed++,
      }),
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200))
  })

  const q = (sel: string): HTMLElement | null =>
    mount.querySelector<HTMLElement>(sel)

  const click = async (el: Element | null): Promise<void> => {
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 30))
    })
  }

  check('the catalog rendered', mount.textContent?.includes('Model catalog') === true)
  check('and listed a model from the stub', mount.textContent?.includes('gpt-4o') === true, mount.textContent?.slice(0, 120))

  // The reported symptom, three ways. `legacyClosed` is the half that proves
  // the CHILD holds the line: it counts clicks that escaped the catalog into a
  // parent written the old way.
  await click(q('input'))
  check('clicking the search box does not reach the editor', legacyClosed === 0, legacyClosed)
  check('nor its backdrop', parentClosed === 0, parentClosed)

  await click(q('select'))
  check('clicking the provider select does not reach the editor', legacyClosed === 0, legacyClosed)

  const addBtn = [...mount.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Add'),
  )
  await click(addBtn ?? null)
  check('clicking Add does not reach the editor', legacyClosed === 0, legacyClosed)
  check('and Add actually adds the model', added.length === 1, added.length)

  // The catalog's own backdrop must still close the catalog, and only it.
  const ownBackdrop = mount.firstElementChild
  await click(ownBackdrop)
  check('clicking the catalog backdrop closes the catalog', catalogClosed === 1, catalogClosed)
  check('and still does not close the editor', parentClosed === 0, parentClosed)

  // A click that really is on the parent backdrop still closes the editor —
  // the fix must not disable click-outside entirely.
  await click(backdrop)
  check('a click on the editor backdrop itself still closes it', parentClosed === 1, parentClosed)

  console.log(failures === 0 ? '\nALL MODAL CLICK CHECKS PASSED' : `\n${failures} FAILED`)
}

void main()
  .catch((err) => {
    console.log('FAIL  probe crashed —', err instanceof Error ? err.message : String(err))
    failures++
  })
  .then(() => {
    ;(window as unknown as { __done?: number }).__done = failures
  })
