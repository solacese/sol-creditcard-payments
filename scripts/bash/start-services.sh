#!/usr/bin/env bash
# Launch all nine Java payment microservices, each in the background, with a
# single command. Run from the repo root (or anywhere — CONFIG_PATH
# resolution walks up). Ctrl-C stops every one of them; alternatively, run
# scripts/stop-services.sh from another shell.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CORE="$ROOT/payment-core"
PIDFILE="$ROOT/scripts/.running-pids"

# Synchronous processing chain, then the fan-out consumers of sale/cleared/>.
apps=(payment-initiator validator authorizer fraud-clearing error-handler settlement upsell insights risk-audit)
pids=()
: > "$PIDFILE"

cleanup() {
  echo; echo "stopping services…"
  kill "${pids[@]}" 2>/dev/null || true
  rm -f "$PIDFILE"
}
trap cleanup INT TERM

for app in "${apps[@]}"; do
  jar="$CORE/$app/target/$app.jar"
  if [[ ! -f "$jar" ]]; then
    echo "missing $jar — run 'cd payment-core && mvn clean package' first" >&2
    exit 1
  fi
  echo "starting $app…"
  java -jar "$jar" &
  pid=$!
  pids+=("$pid")
  echo "$pid $app" >> "$PIDFILE"
  sleep 1
done

echo "all ${#apps[@]} services running (pids: ${pids[*]})."
echo "Ctrl-C to stop, or run scripts/stop-services.sh from another shell."
wait
