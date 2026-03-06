# Loop 0029 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. `guard_retry_timeline` 비-seed 표본 `140+` 누적
- 로컬+텔레그램 P3 smoke를 추가 실행해 표본 분포를 최신화

2. readiness 강제 검증 재실행
- `check-guard-sample-readiness.js --enforce-ready`로 누적 표본 기준 준비 상태를 재확인

3. fail-closed/count-lock bundle 강제 검증 재실행
- `check-p7-fail-closed-count-lock-bundle.js --enforce`로 검색 단일 경로/생성 멀티 제공자/종료 사유 계약을 재확인
