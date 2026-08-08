/**
 * Does pinning an OpenRouter provider company actually work?
 *
 * Not a question a unit test can answer: the app can send a perfect `provider`
 * object and OpenRouter can still route wherever it likes. The only proof is
 * the reply, which carries a top-level `provider` naming the company that
 * served it — "Novita", "Baidu", "OpenAI".
 *
 * So this asks for two DIFFERENT companies and checks the answers differ and
 * match. One pin proves nothing: it might be where the request was going
 * anyway.
 *
 * Runs under electron because the key is encrypted with safeStorage, whose
 * key lives in the app's userData — pointed there before any decrypt, or every
 * decrypt hands back its own ciphertext.
 *
 * Costs about a hundredth of a cent: 8 output tokens per call on a $0.2/Mtok
 * model.
 *
 *   npm run smoke:orrouting
 */
const { app, safeStorage } = require("electron");
const { existsSync, readFileSync } = require("fs");
const { join, resolve } = require("path");

app.setPath("userData", join(process.env.APPDATA || "", "claude-code-desktop"));

/** The model has to have several companies serving it, or there is nothing to
 * pin. 32 endpoints at the time of writing. */
const MODEL = process.env.OR_MODEL || "z-ai/glm-5.2";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

function dataDir() {
  for (const d of [process.env.MONET_DATA_DIR, resolve("..", ".monet-prod"), resolve("..", ".monet")]) {
    if (d && existsSync(join(d, "providers", "providers.json"))) return d;
  }
  return null;
}

function key(dir) {
  const raw = JSON.parse(readFileSync(join(dir, "providers", "providers.json"), "utf-8"));
  const list = Array.isArray(raw) ? raw : raw.providers;
  const or = (list || []).find((p) => p.kind === "openrouter" && p.apiKey);
  if (!or) return null;
  try {
    return safeStorage.decryptString(Buffer.from(or.apiKey, "base64"));
  } catch {
    return null;
  }
}

async function ask(k, body) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "Say OK" }],
      ...body,
    }),
  });
  let json = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    /* not json */
  }
  return { status: res.status, json };
}

/** Which companies serve this model right now — the public catalogue, no key. */
async function candidates() {
  const res = await fetch(`https://openrouter.ai/api/v1/models/${MODEL}/endpoints`);
  if (!res.ok) return [];
  const data = (await res.json()).data ?? {};
  const seen = new Map();
  for (const e of data.endpoints ?? []) {
    // The slug for `only` is the tag's first segment ("novita/fp8" → "novita").
    const slug = String(e.tag || "").split("/")[0];
    if (slug && !seen.has(slug)) seen.set(slug, e.provider_name);
  }
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

app.whenReady().then(async () => {
  const dir = dataDir();
  if (!dir) {
    console.log("SKIP  no providers.json — configure OpenRouter in the app first");
    app.exit(0);
    return;
  }
  const k = key(dir);
  if (!k) {
    console.log("SKIP  no OpenRouter key, or it cannot be decrypted here");
    app.exit(0);
    return;
  }

  const list = await candidates();
  check(`${MODEL} is served by several companies`, list.length >= 2, list.slice(0, 4));
  if (list.length < 2) {
    app.exit(1);
    return;
  }

  const base = await ask(k, {});
  check("a plain request answers, and NAMES the company that served it",
    base.status === 200 && typeof base.json?.provider === "string", {
      status: base.status,
      provider: base.json?.provider,
    });

  // Two pins, and neither may be the one the request would have taken anyway.
  const picks = list.slice(0, 4).filter((p) => p.name !== base.json?.provider).slice(0, 2);
  const served = [];
  for (const p of picks) {
    const r = await ask(k, { provider: { only: [p.slug], allow_fallbacks: false } });
    served.push({ asked: p.name, got: r.json?.provider, status: r.status });
    check(
      `only:["${p.slug}"] IS SERVED BY ${p.name}`,
      r.status === 200 && r.json?.provider === p.name,
      { status: r.status, provider: r.json?.provider, error: r.json?.error?.message },
    );
  }
  check(
    "AND TWO DIFFERENT PINS GIVE TWO DIFFERENT COMPANIES",
    served.length === 2 && served[0].got !== served[1].got,
    served,
  );

  // A pin that cannot be honoured must fail loudly, not quietly elsewhere.
  const bogus = await ask(k, {
    provider: { only: ["totally-not-a-provider"], allow_fallbacks: false },
  });
  check(
    "an impossible pin is a 404, not a silent reroute",
    bogus.status === 404 && /No allowed providers/i.test(bogus.json?.error?.message ?? ""),
    { status: bogus.status, message: bogus.json?.error?.message },
  );
  const avail = bogus.json?.error?.metadata?.available_providers;
  check(
    "…and the error lists the slugs that WOULD work",
    Array.isArray(avail) && avail.length > 2 && avail.includes(picks[0].slug),
    Array.isArray(avail) ? avail.slice(0, 5) : avail,
  );

  // ignore is the mirror image: whoever served the plain request must not.
  const ignored = await ask(k, {
    provider: { ignore: [list.find((p) => p.name === base.json?.provider)?.slug ?? list[0].slug] },
  });
  check(
    "ignore sends the work somewhere else",
    ignored.status === 200 && ignored.json?.provider !== base.json?.provider,
    { was: base.json?.provider, now: ignored.json?.provider },
  );

  // The two knobs are NOT independent, which is why the UI offers one choice
  // of three rather than two switches. Measured, then pinned.
  const onlyBogusWithFallbacks = await ask(k, {
    provider: { only: ["totally-not-a-provider"], allow_fallbacks: true },
  });
  check(
    "ONLY IS A HARD FILTER — fallbacks cannot escape it",
    onlyBogusWithFallbacks.status === 404,
    { status: onlyBogusWithFallbacks.status },
  );
  const orderBogusWithFallbacks = await ask(k, {
    provider: { order: ["totally-not-a-provider"], allow_fallbacks: true },
  });
  check(
    "…while ORDER is only a hint: an unknown slug is served by someone else, silently",
    orderBogusWithFallbacks.status === 200 &&
      typeof orderBogusWithFallbacks.json?.provider === "string",
    { status: orderBogusWithFallbacks.status, provider: orderBogusWithFallbacks.json?.provider },
  );
  const orderNoFallbacks = await ask(k, {
    provider: { order: [picks[0].slug], allow_fallbacks: false },
  });
  check(
    "and order + no fallbacks behaves as a limit, which is why it is one control",
    orderNoFallbacks.status === 200 && orderNoFallbacks.json?.provider === picks[0].name,
    { provider: orderNoFallbacks.json?.provider },
  );

  // The tier cannot be verified from a reply, and pretending otherwise would
  // be the lie this probe exists to prevent.
  const flex = await ask(k, { service_tier: "flex" });
  console.log(
    `NOTE  service_tier is echoed as ${JSON.stringify(flex.json?.service_tier)} ` +
      `(HTTP ${flex.status}) — the API does not confirm the tier, so only the bill does`,
  );

  const spent = [base, ...(await Promise.resolve(served)), flex]
    .map((r) => r?.json?.usage?.cost ?? 0)
    .reduce((a, b) => a + b, 0);
  console.log(`      spent about $${spent.toFixed(6)} on this run`);
  console.log(failures ? `\n${failures} FAILED` : "\nthe pins are real");
  app.exit(failures ? 1 : 0);
});
