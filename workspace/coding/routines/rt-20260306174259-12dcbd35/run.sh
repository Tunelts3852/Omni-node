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
#!/bin/bash

# 현재 요일 확인 (월=1, 화=2, 수=3, 목=4, 금=5)
DAY_OF_WEEK=$(date +%u)

# 지정된 요일인지 확인
if [ $DAY_OF_WEEK -ge 1 ] && [ $DAY_OF_WEEK -le 5 ]; then
  # 현재 시간 확인
  CURRENT_HOUR=$(date +%H)
  CURRENT_MINUTE=$(date +%M)

  # 오전 8시인지 확인
  if [ $CURRENT_HOUR -eq 8 ] && [ $CURRENT_MINUTE -eq 0 ]; then
    # 뉴스 요약 수집 (예시: 첫 번째 문단만 가져오기)
    NEWS_SUMMARY=$(curl -s https://news.google.com/rss | xmllint --format - 2>/dev/null | grep -oP '(?<=<description>).*?(?=</description>)' | head -1)

    # 서버 상태 정보 수집 (예시: 로컬 서버의 uptime)
    SERVER_STATUS=$(uptime)

    # 결과 요약 출력
    echo "News Summary: $NEWS_SUMMARY"
    echo "Server Status: $SERVER_STATUS"
  fi
fi