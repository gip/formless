#!/usr/bin/env bash
# Exercises microphone capture, Web Speech recognition, and audio output inside the app.
#
# Must launch through LaunchServices (`open`), not by running the binary: macOS attributes a
# terminal-launched process's privacy requests to the *terminal*, so a terminal run neither
# prompts correctly nor reports the app's real authorization state.
set -euo pipefail

cd "$(dirname "$0")/.."
APP="build/WebMCP Browser.app"
PORT="${PORT:-8765}"
REPORTS="$(mktemp -d)"
trap 'rm -rf "$REPORTS"; [ -n "${SERVER:-}" ] && kill "$SERVER" 2>/dev/null || true' EXIT

[ -d "$APP" ] || { echo "error: $APP not built. Run: make app"; exit 1; }

# getUserMedia needs a secure context, and localhost qualifies where file:// may not.
python3 -m http.server "$PORT" --directory Tests >/dev/null 2>&1 &
SERVER=$!
for _ in $(seq 1 20); do
  curl -fs -o /dev/null "http://localhost:$PORT/media.html" && break
  perl -e 'select(undef,undef,undef,0.25)'
done

status=0
for tool in media.capabilities media.microphone media.speech media.beep; do
  report="$REPORTS/$tool.json"
  open "$APP" --args --selfcheck "http://localhost:$PORT/media.html" \
    --invoke "$tool" --settle 2 --out "$report"
  for _ in $(seq 1 60); do
    [ -f "$report" ] && break
    perl -e 'select(undef,undef,undef,0.5)'
  done
  if [ ! -f "$report" ]; then
    echo "FAIL $tool: no report (a permission prompt may be waiting on screen)"
    status=1
    continue
  fi
  python3 - "$tool" "$report" <<'PY' || status=1
import json, sys
tool, path = sys.argv[1], sys.argv[2]
report = json.load(open(path))
result = json.loads(report["invokeResult"])["result"]
ok = report["invokeOK"] and result.get("ok", True) and not result.get("timedOut")
print(("PASS " if ok else "FAIL ") + tool + ": " + json.dumps(result))
if not ok:
    print("     tcc:", report["systemPermissions"], "delegates:", report["permissionDelegateCalls"])
    print("     If microphone is notDetermined, run: make permissions")
sys.exit(0 if ok else 1)
PY
done
exit $status
