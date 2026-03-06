# Loop 0018 - 미해결 오류

## 처리하지 못한 오류

- 현재 재현되는 치명 블로커 없음
- 비차단 백로그: guard webhook/log collector live URL 미설정 (로컬+텔레그램 운영 범위 밖, 사용자 요청 시에만 연동)
- 비차단 항목: `publishedAt` 누락 문서 기본 폐기 정책으로 일부 질의에서 count-lock 미충족 차단률이 남을 수 있음 (보강 정책 문서화/채널 회귀 강화/임계치 2차 튜닝/운영 기준선 동결/fail-closed·count-lock 묶음 검증/비-seed 표본 50건 누적 관측 완료)
