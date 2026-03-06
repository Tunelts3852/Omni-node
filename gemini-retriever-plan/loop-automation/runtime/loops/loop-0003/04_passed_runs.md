# Loop 0003 - 통과한 실행/검증

## 실행해서 통과한 항목

1. guard retry timeline 브라우저 E2E
- 명령: `node omninode-dashboard/check-guard-retry-timeline-browser-e2e.js`
- 결과: `ok=true`, `schemaVersion=guard_retry_timeline.v1`, 채널 집계(`chat=2`, `coding=1`, `telegram=1`), `uiRowCount=3`, `source=server_api`

2. 텔레그램 채널 회귀 assert 반영 검증
- 명령: `rg -n "telegram totalSamples|telegram 행" omninode-dashboard/check-guard-retry-timeline-browser-e2e.js`
- 결과: API assert/ UI assert 반영 라인 확인(`259`, `359`)

3. retry timeline API 우선 정적 회귀
- 명령: `node omninode-dashboard/check-guard-retry-timeline-api-priority.js`
- 결과: `ok=true`, 서버 API 우선 경로 관련 6개 체크 통과
