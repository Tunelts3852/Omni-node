# Loop 0023 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. `guard_retry_timeline` 비-seed 표본 `85 -> 90+` 추가 누적
- 로컬+텔레그램 P3 smoke 반복으로 경보 드리프트(오탐/미탐) 추세 관측 구간 확장

2. `90+` 누적 기준 readiness/bundle 강제 검증 재통과 확보
- `check-guard-sample-readiness.js --enforce-ready` + `check-p7-fail-closed-count-lock-bundle.js --enforce`를 연쇄 실행해 최신 누적값 기준 품질 게이트 재확인

3. runtime artifact 입력 모드 검증의 시간 정합성 조건 추가 검토
- `check-guard-regression-workflow-artifacts.js`에 `--require-runtime-generated-max-skew-seconds` 조건을 적용해 manifest 생성 시각 편차 감시 강화 여부 확인
