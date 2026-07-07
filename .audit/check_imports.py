import os
import sys
from collections import defaultdict

PROJECT = r"C:\Users\alexivanov\.agents\claude-code"
AUDIT = os.path.join(PROJECT, ".audit")

if not os.path.exists(os.path.join(AUDIT, "all_imports.txt")):
    print("ERROR: all_imports.txt not found!")
    sys.exit(1)

# Read all source|import pairs
pairs = []
with open(os.path.join(AUDIT, "all_imports.txt"), "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if "|" in line:
            source, imp = line.split("|", 1)
            pairs.append((source, imp))

print(f"Total unique import pairs: {len(pairs)}")

# BUILD EXISTING FILES SET
existing_files = set()
existing_dirs = set()
file_count = 0
for root, dirs, files in os.walk(PROJECT):
    dirs[:] = [d for d in dirs if not d.startswith(".")]
    if "node_modules" in root.replace("\\", "/"):
        continue
    rel_root = os.path.relpath(root, PROJECT).replace("\\", "/")
    if rel_root != ".":
        existing_dirs.add(rel_root)
    for fname in files:
        if fname.startswith("."):
            continue
        rel = os.path.relpath(os.path.join(root, fname), PROJECT).replace("\\", "/")
        existing_files.add(rel)
        file_count += 1

print(f"Existing source files: {file_count}")
print(f"Existing dirs: {len(existing_dirs)}")


def resolve_import(source_file, import_path):
    source_dir = os.path.dirname(source_file)

    if import_path.startswith("src/"):
        resolved = import_path
    elif import_path.startswith("./") or import_path.startswith("../"):
        resolved = os.path.normpath(os.path.join(source_dir, import_path)).replace(
            "\\", "/"
        )
    else:
        return None

    if resolved.startswith(".."):
        return None

    # Exact match
    if resolved in existing_files:
        return resolved, True

    # Try extensions
    for ext in [".ts", ".tsx", ".js", ".jsx"]:
        if resolved + ext in existing_files:
            return resolved + ext, True

    # Try index
    for idx in ["/index.ts", "/index.tsx", "/index.js"]:
        if resolved + idx in existing_files:
            return resolved + idx, True

    # Not found
    return resolved, False


missing_files = defaultdict(set)
processed = 0

for source, imp in pairs:
    result = resolve_import(source, imp)
    if result is None:
        continue
    resolved, exists = result
    if not exists:
        if not any(resolved.endswith(ext) for ext in [".ts", ".tsx", ".js", ".jsx"]):
            resolved = resolved + ".ts"
        missing_files[resolved].add(source)
    processed += 1
    if processed % 5000 == 0:
        print(f"  Processed {processed}/{len(pairs)}...")

print(f"Missing imports (unique targets): {len(missing_files)}")

# Group
critical, important, minor = [], [], []
for target, importers in sorted(missing_files.items()):
    count = len(importers)
    if count > 10:
        critical.append((target, count, importers))
    elif count >= 3:
        important.append((target, count, importers))
    else:
        minor.append((target, count, importers))

critical.sort(key=lambda x: -x[1])
important.sort(key=lambda x: -x[1])
minor.sort(key=lambda x: -x[1])

# Write report
rpt_path = os.path.join(AUDIT, "missing_imports_report.txt")
with open(rpt_path, "w", encoding="utf-8") as rpt:

    def w(s):
        rpt.write(s + "\n")

    w("=" * 80)
    w("🔴 КРИТИЧЕСКИЕ (импортируются >10 файлами):")
    w("=" * 80)
    for target, count, importers in critical:
        w(f"\n📁 {target}")
        w(f"   Импортируют: {count} файлов")
        for imp in sorted(importers)[:10]:
            w(f"     ← {imp}")
        if len(importers) > 10:
            w(f"     ... и еще {len(importers) - 10}")

    w("\n" + "=" * 80)
    w("🟠 ВАЖНЫЕ (импортируются 3-10 файлами):")
    w("=" * 80)
    for target, count, importers in important:
        w(f"\n📁 {target}")
        w(f"   Импортируют: {count} файлов")
        for imp in sorted(importers):
            w(f"     ← {imp}")

    w("\n" + "=" * 80)
    w(f"🟡 МЕЛКИЕ (импортируются 1-2 файлами): {len(minor)} файлов")
    w("=" * 80)
    for target, count, importers in minor:
        w(f"\n📁 {target}")
        w(f"   Импортируют: {count} файлов")
        for imp in sorted(importers):
            w(f"     ← {imp}")

    w("\n\n" + "=" * 80)
    w("ИТОГО:")
    w(f"  🔴 Критические: {len(critical)}")
    w(f"  🟠 Важные: {len(important)}")
    w(f"  🟡 Мелкие: {len(minor)}")
    w(f"  Всего отсутствующих: {len(missing_files)}")

# Summary to stdout
print(f"\n🔴 КРИТИЧЕСКИЕ: {len(critical)}")
for target, count, _ in critical:
    print(f"  [{count:3d}] {target}")

print(f"\n🟠 ВАЖНЫЕ: {len(important)}")
for target, count, _ in important:
    print(f"  [{count:3d}] {target}")

# Save JSON for further analysis
import json

data = {
    "critical": [
        {"file": t, "count": c, "importers": sorted(list(i))} for t, c, i in critical
    ],
    "important": [
        {"file": t, "count": c, "importers": sorted(list(i))} for t, c, i in important
    ],
    "minor": [
        {"file": t, "count": c, "importers": sorted(list(i))} for t, c, i in minor
    ],
}
with open(os.path.join(AUDIT, "missing_imports.json"), "w", encoding="utf-8") as jf:
    json.dump(data, jf, indent=2, ensure_ascii=False)

print(f"\nFull report: .audit/missing_imports_report.txt")
print(f"JSON data: .audit/missing_imports.json")
print(f"Total missing: {len(missing_files)}")
