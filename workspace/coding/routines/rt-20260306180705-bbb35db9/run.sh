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
# CPU 사용량 확인
CPU_USAGE=$(top -l 1 -s 0 -n 0 | grep "CPU usage" | awk '{print $3, $5}')

# RAM 사용량 확인 (macOS와 Linux 공통으로 사용 가능한 방식)
if [ "$(uname)" == "Darwin" ]; then
  # macOS
  MEM_TOTAL=$(sysctl -n hw.memsize)
  MEM_TOTAL_MB=$((MEM_TOTAL / 1024 / 1024))
  MEM_FREE=$(vm_stat | grep "Pages free:" | awk '{print $3}' | sed 's/\.//')
  MEM_FREE_MB=$((MEM_FREE * 4096 / 1024 / 1024))
  MEM_USED_MB=$((MEM_TOTAL_MB - MEM_FREE_MB))
  MEM_USAGE=$(printf "%.2f%%" $(echo "scale=2; ($MEM_USED_MB * 100) / $MEM_TOTAL_MB" | bc))
elif [ "$(uname)" == "Linux" ]; then
  # Linux
  MEM_TOTAL=$(grep "MemTotal:" /proc/meminfo | awk '{print $2}')
  MEM_FREE=$(grep "MemFree:" /proc/meminfo | awk '{print $2}')
  MEM_BUFFERS=$(grep "Buffers:" /proc/meminfo | awk '{print $2}')
  MEM_CACHED=$(grep "Cached:" /proc/meminfo | awk '{print $2}')
  MEM_USED=$((MEM_TOTAL - MEM_FREE - MEM_BUFFERS - MEM_CACHED))
  MEM_USAGE=$(printf "%.2f%%" $(echo "scale=2; ($MEM_USED * 100) / $MEM_TOTAL" | bc))
fi

# 결과 출력
echo "시스템 자원 사용량:"
echo "CPU 사용량: $CPU_USAGE"
echo "RAM 사용량: $MEM_USAGE ($MEM_USED_MB MB / $MEM_TOTAL_MB MB)"