/**
 * Documentation loader.
 *
 * The pages are plain Markdown files with YAML frontmatter, one per topic,
 * grouped by folder. Nothing about them is app-specific: the same tree can be
 * pointed at Docusaurus, VitePress or Nextra to publish a public site, which is
 * why the structure lives in the files themselves (folder = section, `order` =
 * position) rather than in a hand-maintained list here.
 *
 * They are bundled at build time with `?raw`, so the viewer needs no IPC and no
 * filesystem access and works identically in a packaged build.
 */

const files = import.meta.glob("./content/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface DocPage {
  /** URL-ish id: "getting-started/quickstart". */
  slug: string;
  title: string;
  description: string;
  /** Section folder name, e.g. "getting-started". */
  section: string;
  /** Sort key within the section. */
  order: number;
  /** Markdown body, frontmatter stripped. */
  body: string;
}

export interface DocSection {
  /** Folder name. */
  id: string;
  /** Display name, from _section.md or the folder name. */
  title: string;
  order: number;
  pages: DocPage[];
}

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: m[2] };
}

/** Title-case a folder name when no explicit section title is given. */
function humanise(id: string): string {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function build(): DocSection[] {
  const sections = new Map<string, DocSection>();

  for (const [path, raw] of Object.entries(files)) {
    // "./content/getting-started/01-quickstart.md"
    const rel = path.replace("./content/", "").replace(/\.md$/, "");
    const parts = rel.split("/");
    const sectionId = parts.length > 1 ? parts[0] : "";
    const fileName = parts[parts.length - 1];
    const { meta, body } = parseFrontmatter(raw);

    if (!sections.has(sectionId))
      sections.set(sectionId, {
        id: sectionId,
        title: humanise(sectionId),
        order: 999,
        pages: [],
      });
    const section = sections.get(sectionId)!;

    // `_section.md` carries the group's own title/order and is not a page.
    if (fileName === "_section") {
      section.title = meta.title || section.title;
      section.order = Number(meta.order ?? 999);
      continue;
    }

    // A numeric filename prefix keeps files ordered on disk too, but it must
    // not leak into the slug — a published site would inherit "01-" in its URLs.
    const slugFile = fileName.replace(/^\d+[-_]/, "");
    section.pages.push({
      slug: sectionId ? `${sectionId}/${slugFile}` : slugFile,
      title: meta.title || humanise(slugFile),
      description: meta.description || "",
      section: sectionId,
      order: Number(meta.order ?? 999),
      body,
    });
  }

  const out = [...sections.values()];
  for (const s of out) s.pages.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export const DOC_SECTIONS: DocSection[] = build();

export const ALL_DOC_PAGES: DocPage[] = DOC_SECTIONS.flatMap((s) => s.pages);

export function findDocPage(slug: string): DocPage | undefined {
  return ALL_DOC_PAGES.find((p) => p.slug === slug);
}

/** Plain-text search across titles, descriptions and bodies. */
export function searchDocs(query: string): DocPage[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return ALL_DOC_PAGES.map((p) => {
    const inTitle = p.title.toLowerCase().includes(q);
    const inDesc = p.description.toLowerCase().includes(q);
    const inBody = p.body.toLowerCase().includes(q);
    // Title matches first: searching "memory" should land on the Memory page,
    // not on the first page that happens to mention the word.
    const score = inTitle ? 0 : inDesc ? 1 : inBody ? 2 : 3;
    return { p, score };
  })
    .filter((r) => r.score < 3)
    .sort((a, b) => a.score - b.score)
    .map((r) => r.p);
}
