/**
 * Obsidian .canvas — reading the JSON so both processes can show it.
 *
 * A canvas is a JSON Canvas document (jsoncanvas.org): nodes of four kinds
 * (text / file / link / group) plus edges. The app does not draw the board —
 * what it needs is the CONTENT: which notes the canvas references (for the
 * vault graph and backlinks), what its cards say (for search), and a
 * readable rendering for the viewer and for VaultRead.
 *
 * Shared because main indexes canvases and the renderer previews them, and
 * two parsers of one format is how the two drift apart.
 */

export interface CanvasNode {
  id?: string;
  type?: string;
  /** type:"text" — the card's markdown. */
  text?: string;
  /** type:"file" — vault-relative path of the embedded note/image. */
  file?: string;
  /** type:"link" — external URL. */
  url?: string;
  /** type:"group" — the group's caption. */
  label?: string;
}

export interface ParsedCanvas {
  texts: string[];
  /** Note NAMES referenced by file nodes (extension dropped, .md only). */
  noteRefs: string[];
  /** Non-note file references (images and the like). */
  fileRefs: string[];
  urls: string[];
  groups: string[];
  nodeCount: number;
  edgeCount: number;
}

export function parseCanvas(raw: string): ParsedCanvas | null {
  let doc: { nodes?: CanvasNode[]; edges?: unknown[] };
  try {
    doc = JSON.parse(raw) as typeof doc;
  } catch {
    return null;
  }
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const out: ParsedCanvas = {
    texts: [],
    noteRefs: [],
    fileRefs: [],
    urls: [],
    groups: [],
    nodeCount: nodes.length,
    edgeCount: Array.isArray(doc.edges) ? doc.edges.length : 0,
  };
  for (const n of nodes) {
    if (typeof n.text === "string" && n.text.trim()) out.texts.push(n.text.trim());
    if (typeof n.label === "string" && n.label.trim()) out.groups.push(n.label.trim());
    if (typeof n.url === "string" && n.url.trim()) out.urls.push(n.url.trim());
    if (typeof n.file === "string" && n.file.trim()) {
      const f = n.file.trim().replace(/\\/g, "/");
      if (/\.md$/i.test(f)) {
        const base = f.split("/").pop() ?? f;
        out.noteRefs.push(base.replace(/\.md$/i, ""));
      } else out.fileRefs.push(f);
    }
  }
  return out;
}

/** A canvas as readable markdown — for the viewer and for VaultRead. */
export function canvasToMarkdown(name: string, raw: string): string {
  const c = parseCanvas(raw);
  if (!c)
    return `# ${name}\n\n*(unreadable .canvas — not valid JSON Canvas)*`;
  const parts: string[] = [
    `# ${name} (canvas)`,
    `*${c.nodeCount} node(s), ${c.edgeCount} connection(s)*`,
  ];
  if (c.groups.length) parts.push(`## Groups\n${c.groups.map((g) => `- ${g}`).join("\n")}`);
  if (c.noteRefs.length)
    parts.push(`## Notes on the board\n${c.noteRefs.map((r) => `- [[${r}]]`).join("\n")}`);
  if (c.fileRefs.length)
    parts.push(`## Files on the board\n${c.fileRefs.map((f) => `- ${f}`).join("\n")}`);
  if (c.urls.length) parts.push(`## Links\n${c.urls.map((u) => `- <${u}>`).join("\n")}`);
  if (c.texts.length)
    parts.push(`## Cards\n${c.texts.map((t) => `> ${t.replace(/\n/g, "\n> ")}`).join("\n\n")}`);
  return parts.join("\n\n");
}
