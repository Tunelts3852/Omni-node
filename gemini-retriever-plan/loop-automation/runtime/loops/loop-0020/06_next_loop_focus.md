# Loop 0020 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. `guard_retry_timeline` 비-seed 표본 `60 -> 70+` 누적
- 로컬+텔레그램 P3 smoke 반복 실행으로 경보 드리프트(오탐/미탐) 장기 추세 재확인

2. loop0020 워크플로 bundle 연동 후속 검증
- `check-guard-regression-workflow-artifacts.js`를 runtime artifact 입력과 함께 실행해 manifest/artifact 계약이 실제 워크플로 산출물에서도 일치하는지 확인

3. P7 운영 전환 수용 리포트 자동 참조 연결 유지
- baseline + smoke + readiness + bundle JSON 경로를 다음 루프 문서에 연속 반영
