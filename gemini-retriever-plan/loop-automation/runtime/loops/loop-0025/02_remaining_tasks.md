# Loop 0025 - 남은 개발 항목

## 아직 남은 항목

1. `check-guard-regression-workflow-artifacts.js`에 runtime artifact 생성 시각 편차(`generatedAt`) 강제 검증 조건을 적용할지 확정하고, 결정 결과를 코드/문서에 동기화
2. `guard_retry_timeline` 비-seed 표본을 `100 -> 110+`로 추가 누적해 경보 드리프트(오탐/미탐) 관측 구간을 2차 확장
3. `110+` 누적 기준으로 readiness(`--enforce-ready`) + bundle(`--enforce`) 강제 검증을 재실행해 임계치 안정성을 재확인
