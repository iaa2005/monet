/**
 * Settings → Editor — pick the code-highlighting palette, see it at once.
 *
 * The picker itself lives in CodeThemePicker.tsx: first-run setup offers the
 * same choice, and two widgets for one setting is how they drift apart.
 */

import { CodeThemePicker } from "./CodeThemePicker";
import { SectionTitle } from "@/components/settings/SectionTitle";

export function EditorSettings(): JSX.Element {
  return (
    <div className="space-y-5">
      <section>
        <SectionTitle>Editor</SectionTitle>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Syntax highlighting for code everywhere it appears — chat blocks,
          diffs, notebooks and the file editor. Light and dark are separate
          choices; the app&apos;s theme toggle decides which one you see.
        </p>
      </section>
      <CodeThemePicker />
    </div>
  );
}
