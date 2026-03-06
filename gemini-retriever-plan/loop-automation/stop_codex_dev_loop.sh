#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
STOP_FILE="$RUNTIME_DIR/STOP"
RUN_FILE="$RUNTIME_DIR/RUNNING"

mkdir -p "$RUNTIME_DIR"
touch "$STOP_FILE"

echo "[stop] 정지 요청을 기록했습니다: $STOP_FILE"
echo "[stop] 현재 루프가 끝나면 안전 종료됩니다."

if [[ -f "$RUN_FILE" ]]; then
    echo "[stop] 현재 실행 정보:"
    cat "$RUN_FILE"
else
    echo "[stop] 현재 실행 중인 루프 정보 파일이 없습니다."
fi
