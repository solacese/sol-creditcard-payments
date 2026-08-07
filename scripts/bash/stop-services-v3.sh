#!/usr/bin/env bash
# Stop all Payment Core Java microservices (v3) with a single command.
# Prefers the pidfile written by start-services-v3.sh; falls back to
# matching any leftover payment-core java process by jar path.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PIDFILE="$ROOT/scripts/.running-pids-v3"

stopped=0
if [[ -f "$PIDFILE" ]]; then
  while read -r pid app; do
    [[ -z "${pid:-}" ]] && continue
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "stopped $app (pid $pid)"
      stopped=$((stopped + 1))
    fi
  done < "$PIDFILE"
  rm -f "$PIDFILE"
fi

if [[ "$stopped" -eq 0 ]]; then
  echo "no pidfile entries running — checking for leftover processes…"
  if pkill -f 'payment-core[\\/].*[\\/]target[\\/].*\.jar' 2>/dev/null; then
    echo "stopped leftover Payment Core processes."
  else
    echo "no Payment Core services were running."
  fi
else
  echo "stopped $stopped service(s)."
fi
