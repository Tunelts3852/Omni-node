# Loop 0019 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. `check-p7-fail-closed-count-lock-bundle.js` CI/자동 루프 검증 체인 연동
- guard-retry-timeline 브라우저 E2E에서 bundle `--enforce` 실행과 JSON 아티팩트 계약을 고정

2. `guard_retry_timeline` 장기 관측 확장(`55 -> 70+`)
- 로컬+텔레그램 P3 smoke 누적으로 경보 드리프트(오탐/미탐) 추세 재검증

3. P7 운영 전환 수용 리포트 자동 참조 연결
- CI 산출물에서 baseline + smoke + readiness + bundle JSON 경로를 루프 문서에 자동 링크하도록 문서화/스크립트화
