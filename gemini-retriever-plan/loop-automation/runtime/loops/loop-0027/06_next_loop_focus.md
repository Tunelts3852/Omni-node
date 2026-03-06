# Loop 0027 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. runtime artifact 시간 정합성 검증 조건 적용 여부 확정
- `check-guard-regression-workflow-artifacts.js`에 `generatedAt` 편차 임계 검증을 추가할지 검토 후 적용/보류를 문서화

2. `generatedAt` 정책 확정 후 artifact 계약 회귀 재검증
- `check-guard-regression-workflow-artifacts.js`를 실행해 guard-alert/guard-retry-browser workflow artifact 계약이 최신 정책과 일치하는지 확인

3. `guard_retry_timeline` 비-seed 표본 추가 누적 및 게이트 재확인
- 로컬+텔레그램 P3 smoke 누적을 `130+`로 확장한 뒤 readiness(`--enforce-ready`) + bundle(`--enforce`)를 재실행해 경보 드리프트 안정 구간을 추가 관측
