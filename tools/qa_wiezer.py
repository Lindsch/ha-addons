#!/usr/bin/env python3
"""Consistency sweep for the Wiezer add-on. Run before every release:

    python3 tools/qa_wiezer.py

Checks versions, translation keys, error codes and file permissions.
Exits with status 1 if anything is wrong.
"""

import json
import os
import re
import stat
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "wiezer")
problems = []
warnings = []


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


# --- versions
config_version = re.search(r'^version:\s*"?([\d.]+)"?', read("config.yaml"), re.M).group(1)
server_version = re.search(r'^VERSION = "([\d.]+)"', read("app/server.py"), re.M).group(1)
md_version = re.search(r"^## ([\d.]+)", read("CHANGELOG.md"), re.M).group(1)
json_version = json.loads(read("app/static/changelog.json"))[0]["version"]
versions = {"config.yaml": config_version, "server.py": server_version,
            "CHANGELOG.md": md_version, "changelog.json": json_version}
if len(set(versions.values())) != 1:
    problems.append(f"Version mismatch: {versions}")

entry = json.loads(read("app/static/changelog.json"))[0]
if not entry.get("en") or not entry.get("de") or len(entry["en"]) != len(entry["de"]):
    problems.append("changelog.json: newest entry needs the same number of English and German lines")

# --- translations
en = json.loads(read("app/static/i18n/en.json"))
de = json.loads(read("app/static/i18n/de.json"))
for key in sorted(set(en) ^ set(de)):
    problems.append(f"Key only in {'en' if key in en else 'de'}.json: {key}")
for lang, strings in (("en", en), ("de", de)):
    for key, value in strings.items():
        if not isinstance(value, str) or not value.strip():
            problems.append(f"{lang}.json: empty value for {key}")
    for key in strings:
        placeholders_en = set(re.findall(r"\{(\w+)\}", en.get(key, "")))
        placeholders = set(re.findall(r"\{(\w+)\}", strings[key]))
        if placeholders != placeholders_en:
            problems.append(f"{lang}.json: placeholders of {key} differ from en.json")

js = read("app/static/app.js")
prefixes = sorted({k.split(".")[0] for k in en})
key_re = re.compile(r"'((?:%s)\.[a-z0-9_.]+)'" % "|".join(prefixes))
used = {k for k in key_re.findall(js) if not k.endswith((".json", ".js", ".css"))}  # skip file names

# key families built at runtime
server = read("app/server.py")
builtins = re.findall(r'^\s+\("(\w+)", \d+, \d\),', server, re.M)
error_codes = re.search(r"const ERROR_CODES = \[([^\]]+)\]", js).group(1)
error_codes = re.findall(r"'(\w+)'", error_codes)
for b in builtins:
    used.update({f"unit.{b}.one", f"unit.{b}.other"})
for code in error_codes:
    used.add(f"error.{code}")

for key in sorted(used):
    if key not in en:
        problems.append(f"Missing translation key: {key}")
for key in sorted(set(en) - used):
    warnings.append(f"Unused translation key: {key}")

# server error codes must be known to the client
for code in set(re.findall(r'ApiError\("(\w+)"', server)):
    if code not in error_codes:
        problems.append(f"Server error code not handled by the client: {code}")

# --- static files referenced by index.html exist
html = read("app/static/index.html")
for ref in re.findall(r'(?:href|src)="([^"]+)"', html):
    if not os.path.isfile(os.path.join(ROOT, "app/static", ref)):
        problems.append(f"index.html references missing file: {ref}")

# --- s6 scripts must be executable
for script in ("run", "finish"):
    path = os.path.join(ROOT, "rootfs/etc/s6-overlay/s6-rc.d/wiezer", script)
    if not os.stat(path).st_mode & stat.S_IXUSR:
        problems.append(f"Not executable: {path}")

for w in warnings:
    print("warning:", w)
for p in problems:
    print("PROBLEM:", p)
print(f"Wiezer {config_version}: {len(problems)} problem(s), {len(warnings)} warning(s), "
      f"{len(used)} keys used, {len(en)} keys defined")
sys.exit(1 if problems else 0)
