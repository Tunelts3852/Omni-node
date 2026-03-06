# Loop 0023 - 통과한 실행/검증

## 실행해서 통과한 항목

1. guard-alert dispatch 회귀(P6)
- 명령: `node omninode-middleware/check-guard-alert-dispatch.js --timeout-ms 30000 --dispatch-timeout-ms 900 --dispatch-max-attempts 1 --write .runtime/loop0023-runtime-artifacts/guard-alert-dispatch-regression/mock-regression.json`
- 결과: 통과(`ok=true`, `summary.passed=5/5`)

2. guard-retry browser E2E 정적 점검
- 명령: `node --check omninode-dashboard/check-guard-retry-timeline-browser-e2e.js`
- 결과: 통과

3. guard threshold lock 정적/실행 점검
- 명령: `node --check omninode-dashboard/check-guard-threshold-lock.js`
- 결과: 통과
- 명령: `node omninode-dashboard/check-guard-threshold-lock.js`
- 결과: 통과(`ok=true`)

4. guard-retry browser E2E 실행
- 명령: `node omninode-dashboard/check-guard-retry-timeline-browser-e2e.js`
- 결과: 통과(`ok=true`, API/UI 채널 `chat/coding/telegram` 검증)

5. P3 guard smoke 1회 추가 실행(로컬+텔레그램)
- 명령: `node omninode-middleware/check-p3-guard-smoke.js --skip-build --attempts 1 --timeout-ms 45000 --guard-retry-timeline-state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --write .runtime/loop0023-runtime-artifacts/guard-retry-timeline-browser-e2e-regression/p3-guard-smoke.json`
- 결과: 통과(`ok=true`)
- 핵심 근거: 비-seed 표본 `80 -> 85`(`chat +1`, `coding +1`, `telegram +3`)

6. guard 샘플 readiness 강제 검증
- 명령: `node omninode-dashboard/check-guard-sample-readiness.js --state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --enforce-ready --write .runtime/loop0023-runtime-artifacts/guard-retry-timeline-browser-e2e-regression/guard-sample-readiness.json`
- 결과: 통과(`ready=true`, `total=85/30`)

7. P7 fail-closed/count-lock bundle 강제 검증
- 명령: `node omninode-dashboard/check-p7-fail-closed-count-lock-bundle.js --smoke-report .runtime/loop0023-runtime-artifacts/guard-retry-timeline-browser-e2e-regression/p3-guard-smoke.json --timeline-state .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --readiness-report .runtime/loop0023-runtime-artifacts/guard-retry-timeline-browser-e2e-regression/guard-sample-readiness.json --enforce --write .runtime/loop0023-runtime-artifacts/guard-retry-timeline-browser-e2e-regression/p7-failclosed-countlock-bundle.json`
- 결과: 통과(`ok=true`)
- 핵심 근거: `searchPathSingleGeminiGrounding=true`, `multiProviderRouteObserved=true`, `countLockTerminationObservedAllChannels=true`

8. guard 회귀 워크플로 runtime artifact 계약 검증
- 명령: `node omninode-dashboard/check-guard-regression-workflow-artifacts.js --runtime-artifact-root .runtime/loop0023-runtime-artifacts --require-runtime-contract --require-runtime-key-source secure_file_600 --require-guard-alert-mock-run executed --require-guard-alert-live-run skipped_no_live_urls --require-guard-retry-browser-run executed --write .runtime/loop0023-guard-regression-runtime-artifacts.json`
- 결과: 통과(`ok=true`, `runtimeContractSatisfied=true`)
