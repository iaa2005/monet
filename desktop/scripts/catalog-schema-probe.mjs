/**
 * The published catalogs against their published schemas — both fetched live.
 *
 * This is what makes the schemas in monet-directory load-bearing rather than
 * decorative. A catalog is edited by hand and merged without CI; the failure it
 * produces is silent by design, because the app drops rows it cannot use rather
 * than showing a source that breaks on click. Silent is right for a user and
 * wrong for whoever made the typo.
 *
 * Deliberately checks the LIVE files, not fixtures: a fixture would pass while
 * the file everyone actually downloads was broken.
 *
 * Note it does NOT replace the app's parsing. The app reads these over the
 * network and cannot take a schema's word for the data when the schema comes
 * from the same repository. This checks the publisher's side; skill-catalog and
 * mcp-catalog probes check the consumer's.
 */

// ajv arrives transitively rather than as a declared dependency — if that ever
// changes this probe stops running, which is loud enough to notice.
import Ajv from "ajv";

const RAW = "https://raw.githubusercontent.com/iaa2005/monet-directory/main";
const PAIRS = [
  ["skill-sources.json", "skill-sources.schema.json"],
  ["mcp-sources.json", "mcp-sources.schema.json"],
  ["directory-config.json", "directory-config.schema.json"],
];

/** The catalogs are arrays; the tuning file is an object. */
const IS_ARRAY = new Set(["skill-sources.json", "mcp-sources.json"]);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const get = async (path) => {
  const res = await fetch(`${RAW}/${path}`, {
    headers: { "User-Agent": "monet-desktop" },
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
};

const ajv = new Ajv({ allErrors: true });

for (const [dataFile, schemaFile] of PAIRS) {
  console.log(`\n# ${dataFile}`);
  let data, schema;
  try {
    [data, schema] = await Promise.all([get(dataFile), get(schemaFile)]);
  } catch (err) {
    check(`both files are published`, false, String(err.message));
    continue;
  }
  check("both files are published", true);
  if (IS_ARRAY.has(dataFile)) {
    check("the catalog is an array", Array.isArray(data), Array.isArray(data) ? "array" : typeof data);
    check("it is not empty", Array.isArray(data) && data.length > 0, data?.length);
  } else {
    check("the file is an object", !!data && typeof data === "object" && !Array.isArray(data));
  }

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    check("the schema itself compiles", false, String(err.message));
    continue;
  }
  check("the schema itself compiles", true);

  const ok = validate(data);
  check(
    "the live catalog validates against it",
    ok,
    ok
      ? Array.isArray(data)
        ? `${data.length} entries`
        : `${Object.keys(data).length} fields`
      : ajv.errorsText(validate.errors, { separator: "; " }),
  );

  // Ids are what the app dedupes and matches on, so a duplicate silently hides
  // an entry rather than erroring.
  if (IS_ARRAY.has(dataFile) && Array.isArray(data)) {
    const ids = data.map((e) => e?.id);
    check("every entry has an id", ids.every(Boolean), JSON.stringify(ids));
    check("and ids are unique", new Set(ids).size === ids.length, JSON.stringify(ids));
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nALL CATALOG-SCHEMA CHECKS PASSED");
process.exit(failures ? 1 : 0);
