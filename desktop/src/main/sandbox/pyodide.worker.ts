/**
 * Pyodide sandbox worker — runs Python OFF the main process thread.
 *
 * Heavy computations used to freeze the whole app (Pyodide executed on the
 * Electron main thread). This worker owns the Pyodide instance; the engine
 * proxy (pyodide-engine.ts) talks to it over messages. Deliberately free of
 * electron imports so it can run (and be tested) under plain Node.
 *
 * Protocol:
 *   in : { type:"run", id, code, memDir, workDir, cacheDir }
 *        { type:"mirror", memDir, name, bytes: ArrayBuffer }
 *   out: { type:"result", id, ok, stdout, stderr, error?,
 *          files: { name, bytes: ArrayBuffer }[] }   (bytes transferred)
 */

import { parentPort } from "worker_threads";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative, sep } from "path";
import v8 from "v8";

// Python-side SYNC networking (urllib3/requests) needs WebAssembly JSPI,
// which must be enabled at process start — setting it here didn't take even
// on Node 24 (verified). Kept as best-effort for future runtimes; the
// SUPPORTED path is async pyfetch (works today; the RunPython prompt teaches
// it), and content transformation is the model's own job anyway.
try {
  v8.setFlagsFromString("--experimental-wasm-stack-switching");
  v8.setFlagsFromString("--experimental-wasm-jspi");
} catch {
  /* flag unavailable — pyfetch guidance still applies */
}

const MAX_STREAM_CHARS = 60_000;

interface RunMsg {
  type: "run";
  id: number;
  code: string;
  /** In-memory working dir for the chat (e.g. /sessions/<id>). */
  memDir: string;
  /** Real per-chat working TREE on the host (subfolders preserved) — seeded in
   * recursively and produced files written back out here. */
  workDir: string;
  /** Host dir for the Pyodide package cache. */
  cacheDir: string;
}

interface MirrorMsg {
  type: "mirror";
  memDir: string;
  name: string;
  bytes: ArrayBuffer;
}

interface WipeMsg {
  type: "wipe";
  memDir: string;
}

interface PyFS {
  readdir: (p: string) => string[];
  stat: (p: string) => { mode: number; size: number; mtime: Date | number };
  isFile: (mode: number) => boolean;
  readFile: (p: string) => Uint8Array;
  writeFile: (p: string, data: Uint8Array) => void;
}

interface Py {
  setStdout: (o: { batched: (s: string) => void }) => void;
  setStderr: (o: { batched: (s: string) => void }) => void;
  runPython: (c: string) => unknown;
  runPythonAsync: (c: string) => Promise<unknown>;
  loadPackagesFromImports: (c: string) => Promise<unknown>;
  FS: PyFS;
}

let pyodide: Py | null = null;
let loading: Promise<Py> | null = null;

async function getPy(cacheDir: string): Promise<Py> {
  if (pyodide) return pyodide;
  if (!loading) {
    loading = import("pyodide").then(async (m) => {
      pyodide = (await m.loadPyodide({
        packageCacheDir: cacheDir,
      })) as unknown as Py;
      return pyodide;
    });
  }
  return loading;
}

const clip = (s: string): string =>
  s.length > MAX_STREAM_CHARS ? s.slice(0, MAX_STREAM_CHARS) + "\n…(truncated)" : s;

// Import-name → PyPI-name for packages whose module ≠ distribution name.
const PIP_NAME: Record<string, string> = {
  docx: "python-docx",
  pptx: "python-pptx",
  PIL: "pillow",
  cv2: "opencv-python",
  sklearn: "scikit-learn",
  bs4: "beautifulsoup4",
  yaml: "pyyaml",
  dateutil: "python-dateutil",
  fitz: "pymupdf",
  Crypto: "pycryptodome",
};

/**
 * Run code; on ModuleNotFoundError auto-install the missing package via
 * micropip and retry (micropip installs live in THIS interpreter only, so a
 * fresh worker "forgets" e.g. python-docx — that made the model wrongly
 * conclude that binary formats don't work in the sandbox at all).
 * Returns "" on success, the error text otherwise.
 */
async function execWithAutoInstall(
  py: Py,
  code: string,
  note: (s: string) => void,
): Promise<string> {
  const tried = new Set<string>();
  for (;;) {
    try {
      await py.runPythonAsync(code);
      return "";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m =
        /ModuleNotFoundError: No module named ['"]([A-Za-z0-9_.]+)['"]/.exec(
          msg,
        );
      const mod = m?.[1]?.split(".")[0];
      if (!mod || tried.has(mod) || tried.size >= 3) return msg;
      tried.add(mod);
      const pipName = PIP_NAME[mod] ?? mod;
      note(`[sandbox] installing ${pipName} via micropip…`);
      try {
        await py.loadPackagesFromImports("import micropip");
        await py.runPythonAsync(
          `import micropip; await micropip.install(${JSON.stringify(pipName)})`,
        );
      } catch (ie) {
        return (
          msg +
          `\n[sandbox] auto-install of ${pipName} failed: ${
            ie instanceof Error ? ie.message : String(ie)
          }`
        );
      }
    }
  }
}

/** Recursively snapshot the in-memory tree, keyed by POSIX relpath from root. */
function snapshotDir(py: Py, root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    let names: string[] = [];
    try {
      names = py.FS.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === "." || n === "..") continue;
      const full = `${dir}/${n}`;
      try {
        const st = py.FS.stat(full);
        if (py.FS.isFile(st.mode)) {
          const rel = full.slice(root.length + 1);
          map.set(rel, `${st.size}:${Number(new Date(st.mtime as Date))}`);
        } else {
          walk(full); // directory
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(root);
  return map;
}

/** Ensure every parent dir of an in-memory file path exists. */
function ensureMemDirs(py: Py, memPath: string): void {
  const slash = memPath.lastIndexOf("/");
  if (slash <= 0) return;
  py.runPython(
    `import os; os.makedirs(${JSON.stringify(memPath.slice(0, slash))}, exist_ok=True)`,
  );
}

/**
 * Seed the in-memory tree from the chat's real work folder, recursively,
 * subfolders preserved. Never overwrites a file already in memory.
 *
 * One source. There was a second — the flat artifacts folder, seeded by
 * newest-per-name — for chats written before this walked subdirectories. It
 * also quietly poured every file ever attached to the chat into the Python
 * sandbox's root, which is not what anyone asked for: an attachment that
 * belongs in the sandbox is copied there when it is sent (see
 * copyBufferIntoSandbox), and this walk finds it in place.
 */
function seedFromDisk(py: Py, workDir: string, memDir: string): void {
  const put = (rel: string, full: string): void => {
    const target = `${memDir}/${rel}`;
    try {
      py.FS.stat(target);
      return; // already present in memory — don't clobber
    } catch {
      /* not present — seed it */
    }
    try {
      if (statSync(full).size > 30 * 1024 * 1024) return;
      ensureMemDirs(py, target);
      py.FS.writeFile(target, readFileSync(full));
    } catch {
      /* skip unreadable */
    }
  };

  const walkHost = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walkHost(full);
      else if (st.isFile()) put(relative(workDir, full).split(sep).join("/"), full);
    }
  };
  walkHost(workDir);
}

async function run(msg: RunMsg): Promise<void> {
  let py: Py;
  try {
    py = await getPy(msg.cacheDir);
  } catch (err) {
    parentPort!.postMessage({
      type: "result",
      id: msg.id,
      ok: false,
      stdout: "",
      stderr: "",
      files: [],
      error: `Pyodide failed to load: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  let out = "";
  let errText = "";
  py.setStdout({ batched: (s: string) => (out += s + "\n") });
  py.setStderr({ batched: (s: string) => (errText += s + "\n") });

  py.runPython(
    [
      "import os",
      `os.makedirs(${JSON.stringify(msg.memDir)}, exist_ok=True)`,
      `os.chdir(${JSON.stringify(msg.memDir)})`,
      "os.environ.setdefault('MPLBACKEND', 'Agg')",
    ].join("\n"),
  );
  seedFromDisk(py, msg.workDir, msg.memDir);

  const before = snapshotDir(py, msg.memDir);

  try {
    await py.loadPackagesFromImports(msg.code);
  } catch {
    /* a missing package surfaces as an ImportError when the code runs */
  }
  const failure = await execWithAutoInstall(py, msg.code, (s) => {
    out += s + "\n";
  });
  if (failure) errText += failure + "\n";

  const after = snapshotDir(py, msg.memDir);
  const files: { name: string; bytes: ArrayBuffer }[] = [];
  const transfers: ArrayBuffer[] = [];
  for (const [name, sig] of after) {
    if (before.get(name) === sig) continue;
    try {
      const bytes = py.FS.readFile(`${msg.memDir}/${name}`);
      // Persist back into the real work tree (subfolders preserved) so the file
      // survives a worker restart and shows up in the Home Files tree.
      try {
        const dest = join(msg.workDir, name);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
      } catch {
        /* disk write best-effort — the transferred copy still reaches the UI */
      }
      const copy = bytes.slice();
      files.push({ name, bytes: copy.buffer as ArrayBuffer });
      transfers.push(copy.buffer as ArrayBuffer);
    } catch {
      /* skip unreadable */
    }
  }

  parentPort!.postMessage(
    {
      type: "result",
      id: msg.id,
      ok: errText.trim().length === 0,
      stdout: clip(out),
      stderr: clip(errText),
      files,
    },
    transfers,
  );
}

parentPort!.on("message", (msg: RunMsg | MirrorMsg | WipeMsg) => {
  if (msg.type === "mirror") {
    if (!pyodide) return; // cold worker: the seeder will pick it up from disk
    try {
      const target = `${msg.memDir}/${msg.name}`;
      // makedirs the file's PARENT (msg.name may be a nested path like a/b.txt).
      ensureMemDirs(pyodide, target);
      pyodide.runPython(
        `import os; os.makedirs(${JSON.stringify(msg.memDir)}, exist_ok=True)`,
      );
      pyodide.FS.writeFile(target, new Uint8Array(msg.bytes));
    } catch {
      /* best-effort */
    }
    return;
  }
  if (msg.type === "wipe") {
    // Incognito hygiene: drop the session's in-memory files entirely.
    if (!pyodide) return;
    try {
      pyodide.runPython(
        `import shutil; shutil.rmtree(${JSON.stringify(msg.memDir)}, ignore_errors=True)`,
      );
    } catch {
      /* best-effort */
    }
    return;
  }
  void run(msg);
});
