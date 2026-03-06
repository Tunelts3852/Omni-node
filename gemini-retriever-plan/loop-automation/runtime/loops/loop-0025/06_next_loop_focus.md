# Loop 0025 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. runtime artifact 시간 정합성 검증 조건 적용 여부 확정
- `check-guard-regression-workflow-artifacts.js`에 `generatedAt` 편차 임계 검증을 추가할지 검토 후 적용/보류를 문서화

2. `guard_retry_timeline` 비-seed 표본 `100 -> 110+` 추가 누적
- 로컬+텔레그램 P3 smoke 반복으로 경보 드리프트(오탐/미탐) 추세 관측 구간 2차 확장

3. `110+` 누적 기준 readiness/bundle 강제 검증 재통과 확보
- `check-guard-sample-readiness.js --enforce-ready` + `check-p7-fail-closed-count-lock-bundle.js --enforce`를 연쇄 실행해 최신 누적값 기준 품질 게이트 재확인
