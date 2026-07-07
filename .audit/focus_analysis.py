import json
import os
import sys

# Fix encoding on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AUDIT = r"C:\Users\alexivanov\.agents\claude-code\.audit"
with open(os.path.join(AUDIT, "missing_imports.json"), "r", encoding="utf-8") as f:
    data = json.load(f)

all_missing = {}
for cat in ["critical", "important", "minor"]:
    for item in data[cat]:
        all_missing[item["file"]] = item


def analyze_category(patterns):
    results = []
    for path, item in all_missing.items():
        for pat in patterns:
            if pat in path:
                cat = (
                    "CRIT"
                    if item["count"] > 10
                    else ("IMP" if item["count"] >= 3 else "MIN")
                )
                results.append((cat, path, item["count"], item["importers"]))
                break
    results.sort(key=lambda x: -x[2])
    return results


# 1. TOOLS
print("=" * 90)
print("1. FILES FOR tools/")
print("=" * 90)
tools = analyze_category(["tools/", "Tool.js", "Task.js"])
for cat, path, count, importers in tools:
    print(f"\n  [{cat}] [{count}] {path}")
    for imp in importers[:5]:
        print(f"        <-- {imp}")
    if len(importers) > 5:
        print(f"        ... +{len(importers) - 5} more")

# 2. SERVICES/API
print("\n" + "=" * 90)
print("2. FILES FOR services/api/")
print("=" * 90)
api = analyze_category(["services/api/"])
for cat, path, count, importers in api:
    print(f"\n  [{cat}] [{count}] {path}")
    for imp in importers:
        print(f"        <-- {imp}")

# 3. QUERYENGINE CONTEXT
print("\n" + "=" * 90)
print("3. FILES IMPORTED BY QueryEngine.ts")
print("=" * 90)
qe_imports = []
for path, item in all_missing.items():
    if "QueryEngine.ts" in item["importers"]:
        cat = "CRIT" if item["count"] > 10 else ("IMP" if item["count"] >= 3 else "MIN")
        qe_imports.append((cat, path, item["count"]))
qe_imports.sort(key=lambda x: -x[2])
for cat, path, count in qe_imports:
    print(f"  [{cat}] [{count}] {path}")

# 4. COMPONENTS
print("\n" + "=" * 90)
print("4. FILES IN components/ (top 40)")
print("=" * 90)
comps = analyze_category(["components/"])
for i, (cat, path, count, importers) in enumerate(comps):
    if i >= 40:
        print(f"\n  ... +{len(comps) - 40} more components")
        break
    print(f"\n  [{cat}] [{count}] {path}")
    if count <= 2:
        for imp in importers:
            print(f"        <-- {imp}")

# 5. TOP 20 WITH HEURISTICS
print("\n" + "=" * 90)
print("5. TOP 20 MISSING: PRESUMED EXPORTS + REASON")
print("=" * 90)

top = sorted(all_missing.items(), key=lambda x: -x[1]["count"])[:20]

heuristics = {
    "ink.js": (
        "React rendering (ink terminal UI framework)",
        "feature() flag - desktop-only code",
    ),
    "utils/debug.js": (
        "debug() output utility",
        "feature() - debug stripped in production",
    ),
    "utils/errors.js": ("error classes/handling", "feature() - custom errors removed"),
    "bootstrap/state.js": (
        "global app state / initialization",
        "module not in sourcemap (bootstrap)",
    ),
    "utils/log.js": ("logging utility", "feature() - prod logging removed"),
    "utils/envUtils.js": (
        "env utilities (getEnv, isProduction)",
        "feature() - dev-only utils",
    ),
    "utils/slowOperations.js": (
        "slow operation warnings",
        "feature() - dev monitoring",
    ),
    "Tool.js": ("base Tool class", "feature() - tool system partially removed"),
    "commands.js": ("CLI command registry", "feature() - commands stripped"),
    "services/analytics/index.js": (
        "analytics (Amplitude/Mixpanel)",
        "feature() - telemetry removed",
    ),
    "utils/config.js": ("configuration/settings reader", "feature() - settings module"),
    "types/message.js": ("chat message types", "feature() - migrated to new types"),
    "utils/settings/settings.js": (
        "user settings manager",
        "feature() - core settings",
    ),
    "state/AppState.js": ("Zustand/Redux global state", "not in sourcemap"),
    "utils/messages.js": ("message formatting utils", "feature() - removed"),
    "services/analytics/growthbook.js": (
        "GrowthBook feature flags",
        "feature() - removed",
    ),
    "utils/format.js": ("string/date/number formatting", "feature() - base util"),
    "src/services/analytics/index.js": (
        "analytics (src/ alias)",
        "feature() - duplicate path",
    ),
    "utils/lazySchema.js": ("lazy JSON schema loading", "not in sourcemap"),
    "keybindings/useKeybinding.js": ("keybinding hook", "feature() - hook removed"),
}

for path, item in top:
    count = item["count"]
    cat = "CRIT" if count > 10 else ("IMP" if count >= 3 else "MIN")
    hint, reason = heuristics.get(path, ("unknown", "unknown"))
    print(f"\n  [{cat}] [{count}] {path}")
    print(f"     Export: {hint}")
    print(f"     Reason: {reason}")

# SUMMARY
print("\n" + "=" * 90)
print("SUMMARY")
print("=" * 90)
cats = {
    "CRIT": sum(1 for v in all_missing.values() if v["count"] > 10),
    "IMP": sum(1 for v in all_missing.values() if 3 <= v["count"] <= 10),
    "MIN": sum(1 for v in all_missing.values() if v["count"] <= 2),
}
print(f"  CRITICAL (>10 importers):  {cats['CRIT']}")
print(f"  IMPORTANT (3-10):          {cats['IMP']}")
print(f"  MINOR (1-2):               {cats['MIN']}")
print(f"  TOTAL MISSING:             {len(all_missing)}")

nm_count = sum(1 for p in all_missing if "node_modules" in p)
src_count = sum(1 for p in all_missing if p.startswith("src/"))
js_count = sum(1 for p in all_missing if p.endswith(".js"))
ts_count = sum(1 for p in all_missing if p.endswith(".ts"))
tsx_count = sum(1 for p in all_missing if p.endswith(".tsx"))
dts_count = sum(1 for p in all_missing if p.endswith(".d.ts"))

print(f"\n  node_modules imports:      {nm_count}")
print(f"  src/ prefix dupes:         {src_count}")
print(f"  .js extension:             {js_count}")
print(f"  .ts extension:             {ts_count}")
print(f"  .tsx extension:            {tsx_count}")
print(f"  .d.ts extension:           {dts_count}")

print(f"\n  ACTIONABLE (not node_modules): {len(all_missing) - nm_count}")
