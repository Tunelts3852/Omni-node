# Loop 0006 - 통과한 실행/검증

## 실행해서 통과한 항목

1. retry timeline 브라우저 E2E 문법 회귀
- 명령: `node --check omninode-dashboard/check-guard-retry-timeline-browser-e2e.js`
- 결과: 문법 검사 통과(exit 0)

2. retry timeline API 우선 정적 회귀
- 명령: `node omninode-dashboard/check-guard-retry-timeline-api-priority.js`
- 결과: `ok=true`, 서버 API 우선 경로 관련 6개 체크 통과

3. guard retry timeline 브라우저 E2E
- 명령: `node omninode-dashboard/check-guard-retry-timeline-browser-e2e.js`
- 결과: `ok=true`, `schemaVersion=guard_retry_timeline.v1`, 채널 집계(`chat=2`, `coding=1`, `telegram=1`), `uiRowCount=3`, `source=server_api`

4. 채널 범위 assert 반영 검증
- 명령: `rg -n "expectedChannels|API 채널 세트|운영 범위 외 채널" omninode-dashboard/check-guard-retry-timeline-browser-e2e.js`
- 결과: API/UI 채널 범위 고정 assert 라인 확인(`15`, `252~253`, `369`, `374`)
