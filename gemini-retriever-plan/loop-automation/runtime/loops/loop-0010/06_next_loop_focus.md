# Loop 0010 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. readiness 30건 샘플 기준으로 guard 임계치 2차 튜닝 값 산정
2. 2차 튜닝 값을 `app.js`/`check-guard-threshold-lock.js`/경보 기준에 동시 반영
3. 반영 직후 guard retry timeline 브라우저 E2E + 정적 회귀 + readiness(`--enforce-ready`) 재검증
