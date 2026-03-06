# Loop 0021 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. `guard_retry_timeline` 비-seed 표본 `70 -> 80+` 추가 누적
- 로컬+텔레그램 P3 smoke 반복으로 경보 드리프트 장기 추세 추가 관측

2. guard 회귀 워크플로 runtime artifact 계약 실검증
- `check-guard-regression-workflow-artifacts.js`를 `--runtime-artifact-root` 입력과 함께 실행해 manifest/artifact 실물 정합성 확인

3. P7 운영 전환 근거 문서 연속성 유지
- baseline + smoke + readiness + bundle JSON 경로를 다음 루프 리포트/상태 문서에 동일 규칙으로 연동
