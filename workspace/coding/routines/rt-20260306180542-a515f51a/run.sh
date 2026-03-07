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
# 네이버 뉴스 헤드라인을 가져온다.
NEWS_URL="https://news.naver.com/main/main.naver?mode=LSD&mid=shm&sid1=100"
NEWS_HEALINES=$(curl -s "$NEWS_URL" | grep -oP '(?<=<div class="cluster_text_lede">).*?(?=</div>)')

if [ -z "$NEWS_HEALINES" ]; then
  echo "뉴스 헤드라인을 가져오는데 실패했습니다. 네트워크 상태를 확인하세요."
else
  echo "주요 뉴스 헤드라인:"
  echo "$NEWS_HEALINES" | sed 's/&quot;/"/g; s/&#x27;/'"'"'/g' | head -n 5
fi