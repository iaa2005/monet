/**
 * The OCR engine — main's side of the model process.
 *
 * Owns one child (see ocr.child.ts), keeps it warm between pages, and
 * serialises work: a scan is minutes of GPU or CPU, and two at once on the
 * same device is slower than one after the other.
 *
 * Progress matters more here than in most subsystems. A page takes long
 * enough that a silent UI reads as a hang, so tokens are forwarded as they
 * are generated and the caller decides what to show.
 */

import { fork, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { ocrModel, type OcrModelInfo } from "./catalog.js";
import { isInstalled, modelDir } from "./install.js";
import { getOcrConfig, ocrModelsDir } from "./settings.js";

interface ChildReply {
  id?: number;
  type: "loaded" | "delta" | "done" | "error" | "note";
  text?: string;
  tokens?: number;
  device?: string;
  error?: string;
}

let child: ChildProcess | null = null;
let nextId = 1;
let loadedDevice = "";
/** Jobs waiting for a reply, by request id. */
const pending = new Map<number, (r: ChildReply) => void>();
/** Per-job token callbacks, so several queued pages each get their own. */
const streams = new Map<number, (text: string, tokens: number) => void>();
/** The tail of the queue: every scan chains onto it. */
let queue: Promise<unknown> = Promise.resolve();

function failAllPending(message: string): void {
  for (const [, resolve] of pending)
    resolve({ type: "error", error: message });
  pending.clear();
  streams.clear();
}

function getChild(): ChildProcess {
  if (child && child.connected) return child;
  // Beside this module, whatever built it: out/main in the app, out/probe
  // under the end-to-end probe. `__dirname` is the one form both give.
  const script = join(__dirname, "ocr-child.js");
  child = fork(script, [], {
    // In a packaged app `process.execPath` IS the app: this makes it behave
    // as a plain Node process rather than launching a second window.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.on("message", (msg: ChildReply) => {
    if (msg.type === "note") return;
    if (msg.type === "delta") {
      if (msg.id !== undefined)
        streams.get(msg.id)?.(msg.text ?? "", msg.tokens ?? 0);
      return;
    }
    if (msg.id === undefined) return;
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    streams.delete(msg.id);
    resolve(msg);
  });
  let stderrTail = "";
  child.stderr?.on("data", (b: Buffer) => {
    stderrTail = (stderrTail + b.toString()).slice(-800);
  });
  child.on("error", (err) => {
    failAllPending(`OCR process failed: ${err.message}`);
    child = null;
    loadedDevice = "";
  });
  child.on("exit", (code, signal) => {
    const why = stderrTail.trim().split(/\r?\n/).pop() ?? "";
    failAllPending(`OCR process exited (${signal ?? code})${why ? `: ${why}` : ""}`);
    child = null;
    loadedDevice = "";
  });
  return child;
}

function ask(
  msg: Record<string, unknown>,
  onStream?: (text: string, tokens: number) => void,
): Promise<ChildReply> {
  const id = nextId++;
  const c = getChild();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    if (onStream) streams.set(id, onStream);
    c.send({ ...msg, id });
  });
}

export function disposeOcrEngine(): void {
  if (!child) return;
  child.kill();
  child = null;
  loadedDevice = "";
  failAllPending("OCR engine stopped");
}

/** What the engine would use right now, and whether it can. */
export async function ocrReadiness(): Promise<{
  ready: boolean;
  model?: OcrModelInfo;
  reason?: string;
}> {
  const cfg = getOcrConfig();
  const model = ocrModel(cfg.modelId);
  if (!model) return { ready: false, reason: `Unknown model ${cfg.modelId}` };
  if (!(await isInstalled(model, cfg.dtype)))
    return {
      ready: false,
      model,
      reason: `${model.label} (${cfg.dtype}) is not installed — Settings → OCR Scanner.`,
    };
  if (!existsSync(modelDir(model)))
    return { ready: false, model, reason: "Model folder is missing." };
  return { ready: true, model };
}

export interface ScanPageResult {
  text: string;
  tokens: number;
  device: string;
  error?: string;
}

/**
 * One page image → its Markdown.
 *
 * The model is loaded on first use and kept; `onToken` is called as text
 * arrives so a caller can show a page filling in rather than a spinner.
 */
export async function scanPage(
  imagePath: string,
  onToken?: (text: string, tokens: number) => void,
): Promise<ScanPageResult> {
  const run = async (): Promise<ScanPageResult> => {
    const state = await ocrReadiness();
    if (!state.ready || !state.model)
      return { text: "", tokens: 0, device: "", error: state.reason };
    const cfg = getOcrConfig();
    const model = state.model;

    if (!loadedDevice) {
      const loadedReply = await ask({
        type: "load",
        modelsDir: ocrModelsDir(),
        repo: model.repo,
        dtype: cfg.dtype,
        components: model.components,
        device: cfg.device,
      });
      if (loadedReply.type !== "loaded")
        return {
          text: "",
          tokens: 0,
          device: "",
          error: loadedReply.error ?? "could not load the OCR model",
        };
      loadedDevice = loadedReply.device ?? "cpu";
    }

    const reply = await ask(
      {
        type: "scan",
        imagePath,
        prompt: model.prompt,
        maxTokens: cfg.maxTokensPerPage,
      },
      onToken,
    );
    if (reply.type !== "done")
      return { text: "", tokens: 0, device: loadedDevice, error: reply.error };
    return {
      text: reply.text ?? "",
      tokens: reply.tokens ?? 0,
      device: loadedDevice,
    };
  };

  const job = queue.then(run, run);
  queue = job.catch(() => {});
  return job;
}

/** Stop the page being generated right now. The queue behind it stays. */
export function cancelScan(): void {
  child?.send({ type: "cancel" });
}
