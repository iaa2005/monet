/**
 * The notebook editor — an .ipynb as the document it is.
 *
 * Before this, opening a notebook showed its JSON: prose escaped into one
 * line, code as a string full of `\n`, and the outputs — the only part that
 * says whether the thing ran — as unreadable base64. Everything the file is
 * FOR was the part you could not see.
 *
 * Three decisions worth knowing:
 *
 * **Highlighted while you type.** Every cell draws its code through the same
 * highlighter the chat uses, with a transparent textarea sitting exactly on
 * top: the caret and selection are the real ones, the colours are behind it.
 * The alternative — a Monaco per cell — costs an editor instance per cell in
 * a document that routinely has forty.
 *
 * **Markdown is prose until you touch it.** A markdown cell renders; double
 * click (or the pencil) turns it back into source, which is Jupyter's own
 * idiom and the reason a notebook reads like a document at all.
 *
 * **Outputs are shown, not described.** Images, SVG, HTML tables and stream
 * text all render; a traceback comes out ANSI-free. The one thing this
 * editor cannot do is RUN a cell — there is no kernel here — so an edited
 * cell keeps the output it had and says so rather than pretending.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Code2,
  Eraser,
  FileText,
  Pencil,
  Plus,
  Save,
  Trash2,
} from "@/components/icons/hg";
import { cn } from "@/lib/utils";
import { linesFor, useIsDark } from "@/components/chat/highlight";
import { MarkdownViewer } from "@/components/chat/MarkdownViewer";
import {
  cellText,
  clearOutputs,
  deleteCell,
  hasRenderableOutput,
  insertCell,
  moveCell,
  notebookLanguage,
  outputHtml,
  outputImage,
  outputSvg,
  outputText,
  parseNotebook,
  serializeNotebook,
  setCellSource,
  setCellType,
  type CellType,
  type Notebook,
  type NotebookCell,
  type NotebookOutput,
} from "@/lib/notebook";

/** Shared metrics: the highlighted layer and the textarea must agree on
 * every one of these or the caret drifts from the glyphs. */
const CODE_BOX =
  "whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.55] p-3 m-0";

/**
 * The token COLOURS live under `.diff-hl .token.*` in globals.css — the class
 * the chat's code blocks and the diff view both wear. Tokenizing without it
 * produces correctly-classed spans that no rule ever matches, which is
 * exactly as grey as no highlighting at all.
 */
const HL_SCOPE = "diff-hl";

function CellSource({
  text,
  language,
  editable,
  onChange,
  onFocus,
}: {
  text: string;
  language: string;
  editable: boolean;
  onChange: (next: string) => void;
  onFocus?: () => void;
}): JSX.Element {
  const dark = useIsDark();
  const lines = useMemo(
    () => linesFor(text, language),
    // The theme decides the token colours, so a switch has to redraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, language, dark],
  );

  return (
    <div className="relative min-h-[1.5rem]">
      <pre aria-hidden className={cn(HL_SCOPE, CODE_BOX, "min-h-[1.5rem]")}>
        {lines.map((line, i) => (
          <span key={i}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
      {editable && (
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          spellCheck={false}
          className={cn(
            CODE_BOX,
            "absolute inset-0 size-full resize-none overflow-hidden border-0 bg-transparent text-transparent caret-foreground outline-none",
          )}
        />
      )}
    </div>
  );
}

function OutputView({ out }: { out: NotebookOutput }): JSX.Element | null {
  const img = outputImage(out);
  const svg = outputSvg(out);
  const html = outputHtml(out);
  const text = outputText(out);
  const isError = out.output_type === "error";
  const isStderr = out.output_type === "stream" && out.name === "stderr";

  if (!hasRenderableOutput(out)) return null;
  return (
    <div className="border-t border-border/60 px-3 py-2">
      {img && (
        <img
          src={`data:${img.mediaType};base64,${img.base64}`}
          alt=""
          className="max-w-full rounded"
        />
      )}
      {!img && svg && (
        <div
          className="max-w-full overflow-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {!img && !svg && html && (
        <div
          className="overflow-auto text-[13px] [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-0.5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {!img && !svg && !html && text && (
        <pre
          className={cn(
            "m-0 whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.5]",
            isError || isStderr ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

function CellCard({
  cell,
  index,
  language,
  canEdit,
  editing,
  onEdit,
  onChange,
  onType,
  onMove,
  onDelete,
  onInsert,
}: {
  cell: NotebookCell;
  index: number;
  language: string;
  /** Home reads notebooks; only Code edits them. */
  canEdit: boolean;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onChange: (text: string) => void;
  onType: (type: CellType) => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
  onInsert: (type: CellType) => void;
}): JSX.Element {
  const text = cellText(cell);
  const isCode = cell.cell_type === "code";
  const outputs = cell.outputs ?? [];
  const count = cell.execution_count;

  return (
    <div className="group/cell relative">
      <div
        className={cn(
          "overflow-hidden rounded-lg border transition-colors",
          editing ? "border-brand/50" : "border-border",
        )}
      >
        <div className="flex items-stretch">
          {/* The execution count, Jupyter's own gutter: [ ] never run, [3]
              the third thing this kernel did, [*] still running. */}
          <div className="w-12 shrink-0 select-none border-r border-border/60 pt-3 text-right font-mono text-[11px] text-muted-foreground">
            {isCode ? <span className="pr-2">[{count ?? " "}]</span> : null}
          </div>

          <div
            className="min-w-0 flex-1"
            onDoubleClick={() => !editing && onEdit(true)}
          >
            {cell.cell_type === "markdown" && !editing ? (
              <div className="px-3 py-1">
                {text.trim() ? (
                  <MarkdownViewer content={text} />
                ) : (
                  <p className="py-2 text-xs italic text-muted-foreground">
                    Empty markdown cell — double click to write.
                  </p>
                )}
              </div>
            ) : (
              <CellSource
                text={text}
                language={isCode ? language : "markdown"}
                editable={canEdit}
                onChange={onChange}
                onFocus={() => onEdit(true)}
              />
            )}
          </div>
        </div>

        {outputs.length > 0 && (
          <div className="bg-black/[0.02] dark:bg-white/[0.03]">
            {outputs.map((o, i) => (
              <OutputView key={i} out={o} />
            ))}
          </div>
        )}
      </div>

      {/* Per-cell controls: out of the way until the pointer is on the cell,
          and absent entirely where nothing can be changed. */}
      <div
        className={cn(
          "absolute -top-3 right-2 flex items-center gap-0.5 rounded-md border border-border bg-card px-1 py-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover/cell:opacity-100",
          !canEdit && "hidden",
        )}
      >
        <button
          type="button"
          title={isCode ? "Turn into markdown" : "Turn into code"}
          onClick={() => onType(isCode ? "markdown" : "code")}
          className="rounded p-1 text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          {isCode ? <FileText className="size-3.5" /> : <Code2 className="size-3.5" />}
        </button>
        {cell.cell_type === "markdown" && (
          <button
            type="button"
            title={editing ? "Render" : "Edit source"}
            onClick={() => onEdit(!editing)}
            className="rounded p-1 text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <Pencil className={cn("size-3.5", editing && "text-brand")} />
          </button>
        )}
        <button
          type="button"
          title="Move up"
          onClick={() => onMove(-1)}
          className="rounded p-1 text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          <ChevronUp className="size-3.5" />
        </button>
        <button
          type="button"
          title="Move down"
          onClick={() => onMove(1)}
          className="rounded p-1 text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          <ChevronDown className="size-3.5" />
        </button>
        <button
          type="button"
          title="Delete cell"
          onClick={onDelete}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {/* Insert between cells — the hover strip Jupyter puts under each cell. */}
      <div
        className={cn(
          "flex h-6 items-center justify-center opacity-0 transition-opacity hover:opacity-100 group-hover/cell:opacity-100",
          !canEdit && "hidden",
        )}
      >
        <div className="flex items-center gap-1 rounded-md border border-border bg-card px-1 py-0.5">
          <button
            type="button"
            onClick={() => onInsert("code")}
            title="Insert code cell below"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <Plus className="size-3" />
            Code
          </button>
          <button
            type="button"
            onClick={() => onInsert("markdown")}
            title="Insert markdown cell below"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <Plus className="size-3" />
            Text
          </button>
        </div>
      </div>
      <span className="sr-only">cell {index + 1}</span>
    </div>
  );
}

export function NotebookViewer({
  text,
  canEdit,
  onSave,
  onDirtyChange,
}: {
  /** The .ipynb file's contents. */
  text: string;
  /** Home is a reader: its chats work in a sandbox, not in the project. */
  canEdit: boolean;
  onSave?: (serialized: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element {
  const parsed = useMemo(() => parseNotebook(text), [text]);
  const [nb, setNb] = useState<Notebook | null>(parsed);
  const [dirty, setDirty] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  // A new file (or one changed on disk) replaces the buffer — unless the
  // user is mid-edit, in which case their typing is the newer truth.
  useEffect(() => {
    if (!dirty) {
      setNb(parsed);
      setEditingIndex(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed]);

  const mutate = useCallback(
    (next: Notebook): void => {
      setNb(next);
      setDirty(true);
      onDirtyChange?.(true);
    },
    [onDirtyChange],
  );

  const save = useCallback((): void => {
    if (!nb || !onSave) return;
    onSave(serializeNotebook(nb));
    setDirty(false);
    onDirtyChange?.(false);
  }, [nb, onSave, onDirtyChange]);

  // Ctrl/⌘+S, scoped to this card: a notebook is edited like a file, so it
  // saves like one.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !canEdit) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [canEdit, save]);

  if (!nb)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This file is not a readable notebook — its JSON has no `cells` array.
      </div>
    );

  const language = notebookLanguage(nb);
  const kernel =
    ((nb.metadata?.["kernelspec"] as { display_name?: string } | undefined)
      ?.display_name ?? language) || "";

  return (
    <div ref={hostRef} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>{nb.cells.length} cells</span>
        {kernel && <span>· {kernel}</span>}
        {!canEdit && <span>· read-only</span>}
        <div className="ml-auto flex items-center gap-1">
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => mutate(clearOutputs(nb))}
                title="Clear all outputs"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
              >
                <Eraser className="size-3.5" />
                Clear outputs
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!dirty}
                title={dirty ? "Save — Ctrl+S" : "Saved"}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-black/[0.06] hover:text-foreground disabled:opacity-40 dark:hover:bg-white/[0.08]"
              >
                <Save className={cn("size-3.5", dirty && "text-brand")} />
                {dirty ? "Save" : "Saved"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <div className="mx-auto flex max-w-4xl flex-col gap-1">
          {nb.cells.map((cell, i) => (
            <CellCard
              key={(cell.id as string) ?? `cell-${i}`}
              cell={cell}
              index={i}
              language={language}
              canEdit={canEdit}
              editing={canEdit && editingIndex === i}
              onEdit={(on) => canEdit && setEditingIndex(on ? i : null)}
              onChange={(next) => mutate(setCellSource(nb, i, next))}
              onType={(t) => mutate(setCellType(nb, i, t))}
              onMove={(d) => {
                mutate(moveCell(nb, i, d));
                setEditingIndex(null);
              }}
              onDelete={() => {
                mutate(deleteCell(nb, i));
                setEditingIndex(null);
              }}
              onInsert={(t) => {
                mutate(insertCell(nb, i + 1, t));
                setEditingIndex(i + 1);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
