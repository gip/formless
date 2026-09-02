#!/usr/bin/env bash
# Regression test for the WebKit process-reuse leak: a page that allocates a large heap (a
# WebContainer host, for instance) stops booting after a few same-process loads. Every
# user-initiated load must therefore start a fresh web content process.
#
# Usage: Tests/reload-check.sh [url]   (default: http://localhost:3000, i.e. `pnpm dev`)
set -euo pipefail

cd "$(dirname "$0")/.."
APP="build/WebMCP Browser.app"
URL="${1:-http://localhost:3000}"
RELOADS="${RELOADS:-8}"
REPORT="$(mktemp -d)/reload.json"
trap 'rm -rf "$(dirname "$REPORT")"' EXIT

[ -d "$APP" ] || { echo "error: $APP not built. Run: make app"; exit 1; }
curl -fs -o /dev/null "$URL" || { echo "error: nothing serving $URL (start it, e.g. pnpm dev)"; exit 1; }

# -n forces a new instance: plain `open` just activates a running one and drops these args.
open -n "$APP" --args --selfcheck "$URL" --settle 1 \
  --reloads "$RELOADS" --ready-timeout 45 --console --out "$REPORT"

for _ in $(seq 1 600); do
  [ -f "$REPORT" ] && break
  perl -e 'select(undef,undef,undef,0.5)'
done
[ -f "$REPORT" ] || { echo "FAIL: no report; the app hung"; exit 1; }

python3 - "$REPORT" "$RELOADS" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
expected = int(sys.argv[2]) + 1
timings = report.get("readyTimings", [])
ready = [t for t in timings if t["ready"]]
errors = [m for m in report.get("console", []) if m["level"] in ("error", "uncaught", "rejection")]
for t in timings:
    if not t["ready"]:
        print(f"  FAILED {t['step']}: {t['phase']}")
for m in errors[:5]:
    print(f"  console {m['level']}: {m['text'][:160]}")
print(f"{len(ready)}/{len(timings)} loads reached a ready runtime "
      f"(max {max((t['seconds'] for t in ready), default=0):.1f}s)")
ok = len(timings) == expected and not errors and len(ready) == expected
print("PASS reload-check" if ok else "FAIL reload-check")
sys.exit(0 if ok else 1)
PY
