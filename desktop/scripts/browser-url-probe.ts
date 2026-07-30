/**
 * The three pure rules the Browser panel rests on.
 *
 * Address bar: `localhost:3000` is the case that breaks the obvious
 * implementation. It is not a parseable URL — `localhost:` reads as the scheme —
 * and the safe-looking default of prefixing https:// sends a dev server a TLS
 * handshake it does not answer. That is a blank panel with no error worth
 * reading, which is why it is asserted here rather than left to a code review.
 *
 * Partition: it decides which logins survive between runs. Two workspaces
 * sharing a partition share their cookies; a partition that changes with the
 * spelling of the path signs you out for no visible reason. Windows makes both
 * easy — `D:\Proj` and `d:/proj/` are the same folder.
 *
 * Dev-server ports: a project that pins one is exactly the case where the
 * defaults list guesses wrong.
 */

import { normalizeUrl, displayHost } from "../src/renderer/components/browser/url-input";
import { partitionFor, workspaceKey } from "../src/main/browser/session";
import { portsFromScripts } from "../src/main/browser/dev-servers";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

// ── 1. Local hosts get http, never https ──────────────────────────────
{
  const locals = [
    "localhost:3000",
    "localhost",
    "127.0.0.1:8080",
    "127.0.0.1",
    "[::1]:5173",
    "app.localhost:4000",
    "0.0.0.0:8000",
  ];
  for (const input of locals) {
    const out = normalizeUrl(input);
    check(
      `local "${input}" → http`,
      out === `http://${input}`,
      out,
    );
  }
  // With a path, the host part is still what decides the scheme.
  check(
    "local with path keeps http",
    normalizeUrl("localhost:17173/docs") === "http://localhost:17173/docs",
    normalizeUrl("localhost:17173/docs"),
  );
}

// ── 2. Public hosts get https, schemes pass through ───────────────────
{
  check(
    "bare domain → https",
    normalizeUrl("example.com") === "https://example.com",
  );
  check(
    "domain with port and path → https",
    normalizeUrl("sub.example.com:8443/a?b=1") ===
      "https://sub.example.com:8443/a?b=1",
  );
  check("http:// passes through", normalizeUrl("http://x.dev") === "http://x.dev");
  check(
    "file:// passes through",
    normalizeUrl("file:///C:/tmp/a.html") === "file:///C:/tmp/a.html",
  );
  check("about:blank passes through", normalizeUrl("about:blank") === "about:blank");
}

// ── 3. Anything unaddressable becomes a search, not a bad navigation ──
{
  const search = normalizeUrl("how do i center a div");
  check(
    "prose becomes a search",
    !!search?.startsWith("https://duckduckgo.com/?q="),
    search,
  );
  check(
    "search query is encoded",
    search === "https://duckduckgo.com/?q=how%20do%20i%20center%20a%20div",
    search,
  );
  // A bare word could be a search or an intranet host. It has no dot and no
  // port, so it is not addressable — a search is the honest answer.
  check(
    "bare word becomes a search",
    !!normalizeUrl("wiki")?.startsWith("https://duckduckgo.com/"),
    normalizeUrl("wiki"),
  );
  // But host:port IS addressable, and must not be searched for.
  check(
    "host:port is not a search",
    normalizeUrl("buildbox:8080") === "http://buildbox:8080",
    normalizeUrl("buildbox:8080"),
  );
  check("empty input → null", normalizeUrl("   ") === null);
}

// ── 4. displayHost strips the noise, keeps the identity ───────────────
{
  check(
    "displayHost drops the scheme",
    displayHost("https://example.com/a/b?c=1") === "example.com",
    displayHost("https://example.com/a/b?c=1"),
  );
  check(
    "displayHost keeps the port",
    displayHost("http://localhost:3000/x") === "localhost:3000",
    displayHost("http://localhost:3000/x"),
  );
  check("displayHost survives junk", displayHost("not a url") === "not a url");
}

// ── 5. The partition names the FOLDER, not its spelling ───────────────
{
  const spellings = [
    "D:\\Projects\\claude-code",
    "D:/Projects/claude-code",
    "d:\\projects\\claude-code",
    "D:\\Projects\\claude-code\\",
  ];
  const keys = new Set(spellings.map(workspaceKey));
  check(
    "one folder, one key across spellings",
    keys.size === 1,
    [...keys].join(" "),
  );

  const a = partitionFor({ mode: "shared", workspace: "D:/a" });
  const b = partitionFor({ mode: "shared", workspace: "D:/b" });
  check("different folders, different partitions", a !== b, `${a} vs ${b}`);
  check("shared partition persists", a.startsWith("persist:"), a);

  // "Don't keep" must NOT be a persist: partition — that is the entire
  // difference between the setting doing something and doing nothing.
  const none = partitionFor({ mode: "none", workspace: "D:/a" });
  check("none is in-memory", !none.startsWith("persist:"), none);

  const chat1 = partitionFor({
    mode: "perChat",
    workspace: "D:/a",
    sessionId: "s1",
  });
  const chat2 = partitionFor({
    mode: "perChat",
    workspace: "D:/a",
    sessionId: "s2",
  });
  check("per-chat partitions differ", chat1 !== chat2, `${chat1} vs ${chat2}`);
  check(
    "per-chat is not the shared one",
    chat1 !== a,
    `${chat1} vs ${a}`,
  );
  // An unsaved chat has no id. Falling back to the shared store would leak
  // that browsing into every later chat in the project.
  check(
    "per-chat without a chat is ephemeral",
    !partitionFor({ mode: "perChat", workspace: "D:/a" }).startsWith("persist:"),
    partitionFor({ mode: "perChat", workspace: "D:/a" }),
  );
}

// ── 6. A pinned port beats the defaults list ──────────────────────────
{
  const pkg = JSON.stringify({
    scripts: {
      dev: "vite --port 4321",
      start: "PORT=8788 node server.js",
      serve: "http-server -p 9001",
      build: "tsc && vite build",
      test: "vitest run --reporter=dot",
    },
  });
  const ports = portsFromScripts(pkg).sort((x, y) => x - y);
  check(
    "reads --port, PORT= and -p",
    ports.join(",") === "4321,8788,9001",
    ports.join(","),
  );
  check("no scripts, no ports", portsFromScripts("{}").length === 0);
  check("junk json does not throw", portsFromScripts("not json").length === 0);
}

console.log(failures === 0 ? "\nbrowser url probe OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
