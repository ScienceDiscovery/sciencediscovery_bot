#!/usr/bin/env bash
# One-command lifecycle for the local webhook bot (host mode; see docker-compose.yml for containers).
#   ./run.sh start|stop|restart|status|logs|test|replay [args]
# Environment (all optional): SDBOT_WEBHOOK_HOST/PORT (127.0.0.1:8791), SDBOT_ADMIN_HOST/PORT (127.0.0.1:8792),
#   SDBOT_DATA_DIR, SDBOT_REPOS, SDBOT_ADMIN_TOKEN,
#   SDBOT_GITHUB_WEBHOOK_SECRET, SDBOT_GITCODE_WEBHOOK_SECRET (or SDBOT_WEBHOOK_SECRET for both)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${SDBOT_RUN_DIR:-$HERE/.run}"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
WEBHOOK_PORT="${SDBOT_WEBHOOK_PORT:-${SDBOT_PORT:-8791}}"
ADMIN_PORT="${SDBOT_ADMIN_PORT:-8792}"
mkdir -p "$RUN_DIR"

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

case "${1:-start}" in
  start)
    if is_running; then
      echo "already running (pid $(cat "$PID_FILE")): webhook :$WEBHOOK_PORT  admin http://127.0.0.1:$ADMIN_PORT/"
      exit 0
    fi
    nohup python3 "$HERE/server.py" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    sleep 1
    if is_running; then
      echo "started pid $(cat "$PID_FILE"): webhook http://127.0.0.1:$WEBHOOK_PORT/webhook  admin http://127.0.0.1:$ADMIN_PORT/  (log: $LOG_FILE)"
    else
      echo "failed to start; last log lines:" >&2
      tail -n 20 "$LOG_FILE" >&2
      exit 1
    fi
    ;;
  stop)
    if is_running; then
      kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE" && echo "stopped"
    else
      rm -f "$PID_FILE"; echo "not running"
    fi
    ;;
  restart)
    "$0" stop || true
    exec "$0" start
    ;;
  status)
    if is_running; then
      echo "running pid $(cat "$PID_FILE"): webhook :$WEBHOOK_PORT  admin http://127.0.0.1:$ADMIN_PORT/"
      curl -fsS ${SDBOT_ADMIN_TOKEN:+-H "Authorization: Bearer $SDBOT_ADMIN_TOKEN"} "http://127.0.0.1:$ADMIN_PORT/api/status" && echo
    else
      echo "not running"; exit 1
    fi
    ;;
  logs)
    tail -n "${2:-50}" -f "$LOG_FILE"
    ;;
  test)
    shift
    cd "$HERE" && exec python3 -m unittest discover -s tests -t . "$@"
    ;;
  replay)
    shift
    exec python3 "$HERE/scripts/replay.py" "$@"
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs|test|replay}" >&2
    exit 2
    ;;
esac
