/**
 * stdio for an Electron process, which is not the same thing as stdio for a
 * Node process.
 *
 * Two facts, both established by running it rather than by reading docs:
 *
 *  1. `process.stdin` in the Electron main process is a Readable that reports
 *     `readable: true` and then immediately emits `end` — no data, ever.
 *     Reading file descriptor 0 directly works fine. Verified on Windows with
 *     batched writes and a message split across two chunks.
 *  2. `process.stdout` works, and that is the problem: this app logs to it
 *     from all over the main process (`[mcp] …`, `[routines] …`,
 *     `[podman] …`). One such line in the middle of a JSON-RPC stream and the
 *     editor's parser is done. Everything gets moved to stderr.
 */

import { createReadStream } from "fs";
import { Readable, Writable } from "stream";

/**
 * Send every console channel to stderr, and hand back the one writer allowed
 * to touch stdout.
 *
 * Call this BEFORE anything else in the process gets a chance to log —
 * importing a module is enough to trigger a line on some paths.
 */
export function claimStdout(): (chunk: string) => void {
  const write = process.stdout.write.bind(process.stdout);

  const toStderr =
    (level: string) =>
    (...args: unknown[]): void => {
      try {
        process.stderr.write(
          `[${level}] ${args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")}\n`,
        );
      } catch {
        /* never let logging break the protocol */
      }
    };

  console.log = toStderr("log");
  console.info = toStderr("info");
  console.warn = toStderr("warn");
  console.error = toStderr("error");
  console.debug = toStderr("debug");

  // Anything that grabbed the real function earlier still writes; anything
  // that calls it from here on does not.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    process.stderr.write(
      typeof chunk === "string" || chunk instanceof Uint8Array
        ? chunk
        : String(chunk),
      ...(rest as []),
    );
    return true;
  }) as typeof process.stdout.write;

  return (chunk: string) => {
    write(chunk);
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * The pair of Web streams the ACP SDK wants.
 *
 * Input comes from fd 0 rather than `process.stdin` — see the note above.
 * Output goes through the writer claimStdout() returned, so nothing else in
 * the process can interleave with it.
 */
export function acpStreams(writeOut: (chunk: string) => void): {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
} {
  const input = Readable.toWeb(
    createReadStream("", { fd: 0 }),
  ) as ReadableStream<Uint8Array>;

  const output = Writable.toWeb(
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        writeOut(chunk.toString("utf8"));
        cb();
      },
    }),
  ) as WritableStream<Uint8Array>;

  return { input, output };
}
