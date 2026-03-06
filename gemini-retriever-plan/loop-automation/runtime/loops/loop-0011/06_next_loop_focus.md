# Loop 0011 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. readiness 30건 관측치를 기준으로 나머지 guard 임계치 4개(`guard_blocked_rate`, `count_lock_unsatisfied_rate`, `citation_validation_failed_rate`, `telegram_guard_meta_blocked_count`) 2차 튜닝 반영
2. 튜닝 반영값을 `app.js`와 `check-guard-threshold-lock.js` 및 경보 기준 문서에 동시 동기화
3. 반영 직후 guard retry timeline 브라우저 E2E + 정적 회귀 + readiness(`--enforce-ready`) 재검증 후 기준선 갱신
