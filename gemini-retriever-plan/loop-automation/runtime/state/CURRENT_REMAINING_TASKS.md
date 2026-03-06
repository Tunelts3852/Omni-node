# 남은 개발 항목

_자동 루프가 갱신하는 상태 파일입니다._

## 단계 상태
- P0: 완료
- P1: 완료
- P2: 완료
- P3: 완료
- P4: 완료
- P5: 완료
- P6: 완료
- P7: 진행 중

## 이번 루프 반영 완료
1. count-lock/fail-closed 품질 임계치(warn/critical) 1차 고정
2. 로컬+텔레그램 경로 guard retry timeline 회귀 실행 및 통과 기록
3. `publishedAt` 누락 문서 폐기로 인한 count-lock 미충족 보강 정책 문서화(통합 설계서 6.8)
4. guard retry timeline 브라우저 E2E에 텔레그램 채널 API/UI assert 추가 및 회귀 통과
5. guard 임계치 1차 고정값 정적 회귀 스크립트 추가 및 guard retry timeline 브라우저 E2E 워크플로 연동
6. guard retry timeline 브라우저 E2E에 API/UI 채널 범위(chat/coding/telegram) 고정 assert 추가 및 회귀 통과
7. 히스토리 루프/상태 문서의 외부 관제(webhook/log collector) 문구를 비차단 백로그 표준 문구로 통일
8. 실사용 샘플 30건 readiness 자동 점검 스크립트 추가 및 guard-retry CI 아티팩트 계약 반영
9. guard retry timeline 브라우저 E2E seed 주입 로직을 비-seed 누적 보존 방식으로 변경(샘플 누적 리셋 방지)
10. `check-p3-guard-smoke.js`에 guard retry timeline state path 절대경로 고정 옵션/샘플 증분 요약 출력 추가
11. 로컬+텔레그램 운영 경로 샘플 누적 실행으로 readiness 충족(`total=30/30`, `ready=true`)
12. readiness 30건 근거 기반 `retry_required_rate` 임계치 2차 튜닝 1건 반영(`warn=0.45`, `critical=0.7`) 및 임계치 락 회귀 동기화
13. readiness 30건 근거 기반 `guard_blocked_rate` 임계치 2차 튜닝 1건 반영(`warn=0.45`, `critical=0.65`) 및 임계치 락 회귀 동기화
14. readiness 30건 근거 기반 `telegram_guard_meta_blocked_count` 임계치 2차 튜닝 1건 반영(`warn=1`, `critical=2`) 및 임계치 락 회귀 동기화
15. readiness 30건 근거 기반 `count_lock_unsatisfied_rate` 임계치 2차 튜닝 1건 반영(`warn=0.1`, `critical=0.2`) 및 임계치 락 회귀 동기화
16. readiness 30건 근거 기반 `citation_validation_failed_rate` 임계치 2차 튜닝 1건 반영(`warn=0.1`, `critical=0.2`) 및 임계치 락 회귀 동기화
17. P7 운영 전환 기준선 문서/스냅샷(`P7_GUARD_THRESHOLD_BASELINE.md/.json`) 동결 및 `check-guard-threshold-lock.js` 스냅샷 참조 검증 반영
18. 로컬+텔레그램 경로 P3 guard smoke 회귀 1회 추가 실행으로 `guard_retry_timeline` 비-seed 표본 누적 재관측(`30 -> 35`, `chat +1`, `coding +1`, `telegram +3`)
19. fail-closed/count-lock 실패 시나리오 수용 근거 묶음 스크립트(`check-p7-fail-closed-count-lock-bundle.js`) 추가 및 `--enforce` 검증 통과
20. 로컬+텔레그램 경로 P3 guard smoke 3회 추가 실행으로 `guard_retry_timeline` 비-seed 표본 누적 재관측(`35 -> 50`, 회차별 `chat +1`, `coding +1`, `telegram +3`) 및 loop0018 readiness/묶음 강제 검증 통과
21. loop0019 단일 P7 운영 전환 수용 리포트 확정(루프19 smoke/readiness/bundle 강제 검증 재통과 + 비-seed 표본 `50 -> 55` 누적)
22. guard-retry 브라우저 E2E 워크플로에 `check-p3-guard-smoke.js` + `check-guard-sample-readiness.js --enforce-ready` + `check-p7-fail-closed-count-lock-bundle.js --enforce` 연쇄 검증/JSON 산출/manifest artifact 계약 고정
23. loop0020 smoke/readiness/bundle 강제 검증 재통과 및 `guard_retry_timeline` 비-seed 표본 누적 재관측(`55 -> 60`, `chat +1`, `coding +1`, `telegram +3`)
24. loop0021 로컬+텔레그램 P3 smoke 2회 + readiness/bundle 강제 검증 재통과 및 `guard_retry_timeline` 비-seed 표본 누적 재관측(`60 -> 70`, 회차별 `chat +1`, `coding +1`, `telegram +3`)
25. loop0022 로컬+텔레그램 P3 smoke 2회 재실행 및 `guard_retry_timeline` 비-seed 표본 누적 재관측(`70 -> 80`, 회차별 `chat +1`, `coding +1`, `telegram +3`)
26. loop0022 readiness 강제 검증 재통과(`ready=true`, `total=80/30`)
27. loop0022 fail-closed/count-lock bundle 강제 검증 재통과(`ok=true`, `searchPathSingleGeminiGrounding=true`, `multiProviderRouteObserved=true`)
28. loop0023 guard-alert/guard-retry-browser runtime artifact 실물 생성 및 workflow별 `execution-manifest.json` 계약 필드 기록
29. loop0023 `check-guard-regression-workflow-artifacts.js` runtime artifact 입력 모드 강제 검증 통과(`runtimeContractSatisfied=true`)
30. loop0023 로컬+텔레그램 P3 smoke 1회 + readiness/bundle 강제 검증 통과 및 비-seed 표본 누적 재관측(`80 -> 85`, `chat +1`, `coding +1`, `telegram +3`)
31. loop0024 로컬+텔레그램 P3 smoke 1회 재실행 및 비-seed 표본 누적 재관측(`85 -> 90`, `chat +1`, `coding +1`, `telegram +3`)
32. loop0024 readiness 강제 검증 재통과(`ready=true`, `total=90/30`)
33. loop0024 fail-closed/count-lock bundle 강제 검증 재통과(`ok=true`, `searchPathSingleGeminiGrounding=true`, `multiProviderRouteObserved=true`, `countLockTerminationObservedAllChannels=true`)
34. loop0025 로컬+텔레그램 P3 smoke 1회 재실행 및 비-seed 표본 누적 재관측(`90 -> 95`, `chat +1`, `coding +1`, `telegram +3`)
35. loop0025 로컬+텔레그램 P3 smoke 1회 재실행 및 비-seed 표본 누적 재관측(`95 -> 100`, `chat +1`, `coding +1`, `telegram +3`)
36. loop0025 readiness 강제 검증 재통과(`ready=true`, `total=100/30`)
37. loop0025 fail-closed/count-lock bundle 강제 검증 재통과(`ok=true`, `searchPathSingleGeminiGrounding=true`, `multiProviderRouteObserved=true`, `countLockTerminationObservedAllChannels=true`)
38. loop0026 로컬+텔레그램 P3 smoke 1회 재실행 및 비-seed 표본 누적 재관측(`100 -> 105`, `chat +1`, `coding +1`, `telegram +3`)
39. loop0026 로컬+텔레그램 P3 smoke 1회 재실행 및 비-seed 표본 누적 재관측(`105 -> 110`, `chat +1`, `coding +1`, `telegram +3`)
40. loop0026 readiness 강제 검증 재통과(`ready=true`, `total=110/30`)
41. loop0026 fail-closed/count-lock bundle 강제 검증 재통과(`ok=true`, `searchPathSingleGeminiGrounding=true`, `multiProviderRouteObserved=true`, `countLockTerminationObservedAllChannels=true`)
42. loop0027 로컬+텔레그램 P3 smoke 재실행(run1) 통과 및 비-seed 표본 누적 재관측(`112 -> 117`, `chat +1`, `coding +1`, `telegram +3`)
43. loop0027 로컬+텔레그램 P3 smoke 추가 실행(run2) 통과 및 비-seed 표본 누적 재관측(`117 -> 122`, `chat +1`, `coding +1`, `telegram +3`)
44. loop0027 readiness 강제 검증 재통과(`ready=true`, `total=122/30`)
45. loop0027 fail-closed/count-lock bundle 강제 검증 재통과(`ok=true`, `searchPathSingleGeminiGrounding=true`, `multiProviderRouteObserved=true`, `countLockTerminationObservedAllChannels=true`)
46. loop0028 `check-guard-regression-workflow-artifacts.js`에 runtime contract 강제 시 `generatedAt` 시간 편차 기본 임계치(`5400s`) 자동 검증 정책 반영
47. loop0028 runtime artifact 입력 모드 guard 회귀 계약 검증 재통과(`ok=true`, `runtimeContractSatisfied=true`, `runtimeGeneratedMaxSkewSource=default_when_require_runtime_contract`, `runtimeGeneratedSkewSeconds=89.15`)
48. loop0029 로컬+텔레그램 P3 smoke 2회 + readiness/bundle 강제 검증 재통과 및 `guard_retry_timeline` 비-seed 표본 누적 재관측(`122 -> 132`, 회차별 `chat +1`, `coding +1`, `telegram +3`)
49. loop0030 로컬+텔레그램 P3 smoke 2회 재실행 및 `guard_retry_timeline` 비-seed 표본 누적 재관측(`132 -> 142`, 회차별 `chat +1`, `coding +1`, `telegram +3`)
50. loop0030 readiness 강제 검증 재통과(`ready=true`, `total=142/30`)
51. loop0030 fail-closed/count-lock bundle 강제 검증 재통과(`ok=true`, `searchPathSingleGeminiGrounding=true`, `multiProviderRouteObserved=true`, `countLockTerminationObservedAllChannels=true`)
52. loop0031 로컬+텔레그램 P3 smoke 2회 + readiness/bundle 강제 검증 재통과 및 `guard_retry_timeline` 비-seed 표본 누적 재관측(`142 -> 152`, 회차별 `chat +1`, `coding +1`, `telegram +3`)

## 즉시 남은 작업(로컬 + 텔레그램 운영 기준)
1. `guard_retry_timeline` 비-seed 표본을 `160+`로 추가 누적한 뒤 readiness(`--enforce-ready`) + bundle(`--enforce`) 강제 검증을 재실행해 최신 누적 분포 기준 품질 게이트를 재확인
