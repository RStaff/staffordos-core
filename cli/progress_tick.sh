#!/usr/bin/env bash
set -euo pipefail

# progress_tick.sh "note" [project_id] [mode_id]
NOTE=${1:-}
PROJECT_ID=${2:-ross-llm}
MODE_ID=${3:-ooda}

if [ -z "$NOTE" ]; then
  echo "Usage: $0 \"note\" [project_id] [mode_id]"
  exit 1
fi

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$BASE_DIR/state"
LOG_DIR="$STATE_DIR/log"

mkdir -p "$LOG_DIR"

TODAY=$(date +%F)
LOG_FILE="$LOG_DIR/${TODAY}.json"

python3 - "$LOG_FILE" "$NOTE" "$PROJECT_ID" "$MODE_ID" <<'PY'
import json, os, sys
from datetime import datetime

log_file, note, project_id, mode_id = sys.argv[1:5]
now = datetime.now()
today = now.strftime("%Y-%m-%d")
time_str = now.strftime("%H:%M")

data = {
    "date": today,
    "ticks": []
}

if os.path.exists(log_file):
    try:
        with open(log_file, "r") as f:
            data = json.load(f)
    except Exception:
        # If file is corrupted, start a fresh structure but don't crash.
        data = {"date": today, "ticks": []}

tick = {
    "time": time_str,
    "project_id": project_id,
    "mode_id": mode_id,
    "note": note,
    "energy": "unknown",
    "friction": "unknown"
}

data.setdefault("ticks", []).append(tick)

with open(log_file, "w") as f:
    json.dump(data, f, indent=2)

print(f"✅ Logged tick at {time_str} for project='{project_id}', mode='{mode_id}'")
PY
