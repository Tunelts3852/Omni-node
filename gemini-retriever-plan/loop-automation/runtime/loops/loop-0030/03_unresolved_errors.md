# Loop 0030 - 미해결 오류

## 처리하지 못한 오류

- 현재 재현되는 치명 블로커 없음
- 비차단 백로그: guard webhook/log collector live URL 미설정 (로컬+텔레그램 운영 범위 밖, 사용자 요청 시에만 연동)
- 비차단 항목: `publishedAt` 누락 문서 기본 폐기 정책으로 일부 질의에서 count-lock 미충족 차단률이 남을 수 있음 (보강 정책/회귀/임계치 락/묶음 검증 자동화 + runtime artifact 입력 모드 실검증 + 비-seed 표본 142건 누적 및 readiness/bundle 강제 검증 재통과 유지)
