# Loop 0014 - 남은 개발 항목

## 아직 남은 항목

1. readiness 30건 기준 나머지 guard 임계치 2차 튜닝 수행
- 대상 규칙: `citation_validation_failed_rate`

2. 2차 튜닝 반영값 동기화 마무리
- 대상 파일: `omninode-dashboard/app.js`, `omninode-dashboard/check-guard-threshold-lock.js`, 경보 기준 문서/기준선

3. 반영값 기준 전체 재검증 및 기준선 갱신
- `check-guard-retry-timeline-browser-e2e.js`
- `check-guard-threshold-lock.js`
- `check-guard-sample-readiness.js --enforce-ready`
