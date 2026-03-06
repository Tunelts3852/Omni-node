# Loop 0015 - 다음 루프 우선 작업

## 다음 루프에서 가장 먼저 할 일

1. P7 운영 전환 기준선 고정
- `citation_validation_failed_rate`를 포함한 guard 임계치 2차 튜닝 최종값 5개를 운영 기준선 문서/스냅샷으로 동결

2. 로컬+텔레그램 경로 드리프트 재관측
- `guard_retry_timeline` 비-seed 표본을 추가 누적해 경보 오탐/미탐 변화 여부를 재검증

3. fail-closed/count-lock 실패 시나리오 회귀 묶음화
- 대화/코딩/텔레그램 실패 메시지 일관성 결과를 수집해 P7 수용 근거로 정리
