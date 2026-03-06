#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
LOCK_DIR="$RUNTIME_DIR/LOCK"
RUN_FILE="$RUNTIME_DIR/RUNNING"
STOP_FILE="$RUNTIME_DIR/STOP"
INDEX_FILE="$RUNTIME_DIR/LOOP_INDEX.md"
LAST_LOOP_FILE="$RUNTIME_DIR/state/last_loop_number.txt"

echo "[status] 확인 시각: $(date '+%Y-%m-%dT%H:%M:%S%z')"

if [[ -d "$LOCK_DIR" ]]; then
    echo "[status] 루프 상태: RUNNING"
else
    echo "[status] 루프 상태: IDLE"
fi

if [[ -f "$STOP_FILE" ]]; then
    echo "[status] 정지 요청: 있음 ($STOP_FILE)"
else
    echo "[status] 정지 요청: 없음"
fi

if [[ -f "$RUN_FILE" ]]; then
    echo "[status] 현재 실행 정보:"
    cat "$RUN_FILE"
else
    echo "[status] 현재 실행 정보 파일 없음"
fi

if [[ -f "$LAST_LOOP_FILE" ]]; then
    echo "[status] 마지막 완료 루프 번호: $(cat "$LAST_LOOP_FILE")"
fi

if [[ -f "$INDEX_FILE" ]]; then
    echo "[status] 최근 루프 기록:"
    tail -n 10 "$INDEX_FILE"
else
    echo "[status] 루프 인덱스 파일 없음"
fi
