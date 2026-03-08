#!/usr/bin/env bash
set -euo pipefail

# Omni-node portability shim (macOS/Linux)
if ! command -v free >/dev/null 2>&1; then
  free() {
    echo "              total        used        free"
    echo "Mem:           n/a         n/a         n/a"
    if command -v vm_stat >/dev/null 2>&1; then
      echo ""
      vm_stat | head -n 6
    fi
    return 0
  }
fi

if [ "$(uname -s)" = "Darwin" ]; then
  top() {
    local remapped=()
    local replaced=0
    for arg in "$@"; do
      if [ "$arg" = "-bn1" ]; then
        remapped+=("-l" "1")
        replaced=1
      else
        remapped+=("$arg")
      fi
    done
    if [ "$replaced" -eq 1 ]; then
      command top "${remapped[@]}"
      return $?
    fi
    command top "$@"
  }
fi
echo "[Routine] 요청: '워크스페이스 상태를 요약'"
echo "[Routine] 스케줄: 매일 08:00 (Asia/Seoul)"
echo "[Routine] 실행시각: $(date '+%Y-%m-%d %H:%M:%S')"
echo "[Routine] 자동 생성 코드가 유효하지 않아 기본 템플릿으로 실행했습니다."
echo "[Routine] 실제 작업 로직은 루틴 수정 저장으로 재생성하세요."