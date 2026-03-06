# Loop 0018 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. P7 운영 전환 최종 수용 리포트 확정
- 기준선 문서/스냅샷 + loop0018 묶음 JSON + 회귀 로그를 단일 승인 문서로 정리

2. `check-p7-fail-closed-count-lock-bundle.js` CI/자동 루프 체인 연동
- 워크플로 실행 시 bundle `--enforce` 검증과 JSON 아티팩트 생성/검증을 고정

3. `guard_retry_timeline` 장기 관측 구간 확장
- 비-seed 표본을 70+로 확장해 경보 드리프트 추세를 재검증
