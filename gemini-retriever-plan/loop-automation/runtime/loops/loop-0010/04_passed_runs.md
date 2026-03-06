# Loop 0010 - 통과한 실행/검증

## 실행해서 통과한 항목

1. `check-p3-guard-smoke.js` 문법 검증
- 명령: `node --check omninode-middleware/check-p3-guard-smoke.js`
- 결과: 통과(문법 오류 없음)

2. guard state 경로 고정 단건 검증 실행
- 명령: `node omninode-middleware/check-p3-guard-smoke.js --skip-build --attempts 1 --timeout-ms 45000 --guard-retry-timeline-state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json`
- 결과: 통과(`ok=true`, `guardRetryTimelineSamples.delta.nonSeedEntries=5`, state path 절대경로 고정 확인)

3. 로컬+텔레그램 운영 샘플 누적 반복 실행(5회)
- 명령:
  - `for i in 1 2 3 4 5; do node omninode-middleware/check-p3-guard-smoke.js --skip-build --attempts 1 --timeout-ms 45000 --guard-retry-timeline-state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json; done`
- 결과: 통과(모든 반복 실행 성공, 비-seed 누적 총량 30건 도달)

4. guard 샘플 readiness 계산
- 명령:
  - `node omninode-dashboard/check-guard-sample-readiness.js --state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json`
  - `node omninode-dashboard/check-guard-sample-readiness.js --state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --enforce-ready`
- 결과: 통과(`ready=true`, `total=30/30`, `chat=6`, `coding=6`, `telegram=18`, 강제 검증 포함)

5. guard 임계치 고정 회귀 재확인
- 명령: `node omninode-dashboard/check-guard-threshold-lock.js`
- 결과: 통과(기존 고정 임계치 계약 유지)

6. retry timeline API 우선 경로 정적 회귀 재확인
- 명령: `node omninode-dashboard/check-guard-retry-timeline-api-priority.js`
- 결과: 통과(server_api 우선/메모리 fallback 표기 계약 유지)

7. guard 회귀 워크플로 아티팩트 계약 정적 검증
- 명령: `node omninode-dashboard/check-guard-regression-workflow-artifacts.js`
- 결과: 통과(key source 정책/워크플로 계약 유지)
