# Loop 0015 - 남은 개발 항목

## 아직 남은 항목

1. P7 전환 기준선 확정
- 대상: guard 임계치 2차 튜닝 최종값 5개(`guard_blocked_rate`, `retry_required_rate`, `count_lock_unsatisfied_rate`, `citation_validation_failed_rate`, `telegram_guard_meta_blocked_count`)를 운영 기준선 문서/스냅샷으로 고정

2. 로컬+텔레그램 장기 관측 회귀 추가
- 대상: `guard_retry_timeline` 표본을 30건 기준선에서 추가 누적해 경보 드리프트(오탐/미탐) 여부를 재확인

3. P7 수용 기준 검증 정리
- 대상: 대화/코딩/텔레그램 경로의 fail-closed 메시지 일관성 및 count-lock 충족/실패 시나리오 점검 결과를 다음 루프 리포트에 묶음화
