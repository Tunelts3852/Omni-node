# Loop 0027 - 통과한 실행/검증

## 실행해서 통과한 항목

1. P3 guard smoke 재실행(run1)
- 명령: `node omninode-middleware/check-p3-guard-smoke.js --skip-build --attempts 1 --timeout-ms 45000 --guard-retry-timeline-state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --write .runtime/loop0027-guard-retry-timeline-regression/p3-guard-smoke-run1.json`
- 결과: 통과(`ok=true`)
- 핵심 근거: 비-seed 표본 `112 -> 117`(`chat +1`, `coding +1`, `telegram +3`)

2. P3 guard smoke 추가 실행(run2)
- 명령: `node omninode-middleware/check-p3-guard-smoke.js --skip-build --attempts 1 --timeout-ms 45000 --guard-retry-timeline-state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --write .runtime/loop0027-guard-retry-timeline-regression/p3-guard-smoke-run2.json`
- 결과: 통과(`ok=true`)
- 핵심 근거: 비-seed 표본 `117 -> 122`(`chat +1`, `coding +1`, `telegram +3`)

3. guard 샘플 readiness 강제 검증
- 명령: `node omninode-dashboard/check-guard-sample-readiness.js --state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --enforce-ready --write .runtime/loop0027-guard-retry-timeline-regression/guard-sample-readiness.json`
- 결과: 통과(`ready=true`, `total=122/30`)

4. P7 fail-closed/count-lock bundle 강제 검증
- 명령: `node omninode-dashboard/check-p7-fail-closed-count-lock-bundle.js --smoke-report .runtime/loop0027-guard-retry-timeline-regression/p3-guard-smoke-run2.json --timeline-state .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --readiness-report .runtime/loop0027-guard-retry-timeline-regression/guard-sample-readiness.json --enforce --write .runtime/loop0027-guard-retry-timeline-regression/p7-failclosed-countlock-bundle.json`
- 결과: 통과(`ok=true`)
- 핵심 근거: `searchPathSingleGeminiGrounding=true`, `multiProviderRouteObserved=true`, `countLockTerminationObservedAllChannels=true`, `timeline.nonSeedEntries=122`
