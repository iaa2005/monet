/**
 * A better-sqlite3 that answers nothing, for probes that run under plain Node.
 *
 * The real module is a native binary built for Electron's ABI (see
 * scripts/rebuild-native.mjs) and cannot be loaded by `node`. Bundling does
 * not help: the require is a bare one, left alone on purpose by
 * vendor-require-plugin, and resolved at run time by the banner's
 * createRequire. So it is intercepted here instead.
 *
 * Used as a preload — `node -r scripts/node-sqlite-stub.cjs …` — which is why
 * it installs the hook itself rather than exporting one: by the time a probe
 * could call an install function, the module it needs to intercept has
 * already been required.
 *
 * Every method answers "nothing is there". A probe that actually depends on
 * stored rows must not use this; it wants the Electron-side plan-probe.cjs.
 */
const Module = require("module");

class Stmt {
  run() {
    return { changes: 0, lastInsertRowid: 0 };
  }
  get() {
    return undefined;
  }
  all() {
    return [];
  }
  iterate() {
    return [][Symbol.iterator]();
  }
  pluck() {
    return this;
  }
  raw() {
    return this;
  }
}

class Database {
  prepare() {
    return new Stmt();
  }
  exec() {
    return this;
  }
  pragma() {
    return [];
  }
  transaction(fn) {
    return (...args) => fn(...args);
  }
  close() {}
}

module.exports = Database;
module.exports.default = Database;

// Resolve the bare specifier to THIS file, which is already in the cache
// because Node preloaded it — so the require returns the exports above.
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "better-sqlite3") return __filename;
  return original.call(this, request, ...rest);
};
