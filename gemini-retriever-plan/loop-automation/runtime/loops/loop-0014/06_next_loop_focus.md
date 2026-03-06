# Loop 0014 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. readiness 30건 관측치를 기준으로 마지막 guard 임계치 1개(`citation_validation_failed_rate`) 2차 튜닝 반영
2. 튜닝 반영값을 `app.js`와 `check-guard-threshold-lock.js` 및 경보 기준 문서에 동시 동기화
3. 반영 직후 guard retry timeline 브라우저 E2E + 정적 회귀 + readiness(`--enforce-ready`) 재검증 후 기준선 갱신
