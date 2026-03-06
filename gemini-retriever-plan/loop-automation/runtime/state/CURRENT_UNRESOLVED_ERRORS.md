# 미해결 오류 목록

_자동 루프가 갱신하는 상태 파일입니다._

- 현재 재현되는 치명 블로커 없음
- 비차단 백로그: guard webhook/log collector live URL 미설정 (로컬+텔레그램 운영 범위 밖, 사용자 요청 시에만 연동)
- 비차단 항목: `publishedAt` 누락 문서 기본 폐기 정책으로 일부 질의에서 count-lock 미충족 차단률이 남을 수 있음 (보강 정책 문서화/텔레그램 회귀 assert 강화/임계치 락 회귀 자동화/채널 범위 회귀 강화/샘플 30건 readiness/임계치 2차 튜닝/운영 기준선 동결/fail-closed·count-lock 묶음 자동 검증/단일 수용 리포트 확정/워크플로 bundle 강제 연동/runtime artifact 입력 모드 실검증/비-seed 표본 152건 누적 관측/readiness·bundle 강제 검증 재통과 + runtime artifact `generatedAt` 편차 기본 강제 정책 적용/재검증 완료)
