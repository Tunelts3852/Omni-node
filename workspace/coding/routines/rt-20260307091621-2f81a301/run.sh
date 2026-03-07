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
# 매일 08:00에 실행되는 루틴의 내용
echo "루틴이 실행되었습니다."
echo "현재 시스템 상태를 확인합니다."
# macOS와 Linux 모두에서 동작하는 시스템 상태 확인 명령어 사용
uptime