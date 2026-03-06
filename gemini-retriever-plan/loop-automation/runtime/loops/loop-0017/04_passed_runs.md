# Loop 0017 - 통과한 실행/검증

## 실행해서 통과한 항목

1. P3 guard smoke 회귀(로컬+텔레그램) 재실행
- 명령: `node omninode-middleware/check-p3-guard-smoke.js --skip-build --attempts 1 --timeout-ms 45000 --guard-retry-timeline-state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --write .runtime/loop0017-p7-failclosed-smoke.json`
- 결과: 통과(`ok=true`)
- 핵심 근거: chat/coding guard 차단(`termination=count_lock_unsatisfied_after_retries`, `retryScope=gemini_grounding_search`), telegram audit 차단(`route=telegram-single:copilot...`)

2. guard 샘플 readiness 강제 검증
- 명령: `node omninode-dashboard/check-guard-sample-readiness.js --state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --enforce-ready --write .runtime/loop0017-guard-sample-readiness.json`
- 결과: 통과(`ready=true`, `total=35/30`, `chat=7`, `coding=7`, `telegram=21`)

3. P7 fail-closed/count-lock 묶음 스크립트 문법 검증
- 명령: `node --check omninode-dashboard/check-p7-fail-closed-count-lock-bundle.js`
- 결과: 통과(문법 오류 없음)

4. P7 fail-closed/count-lock 묶음 강제 검증
- 명령: `node omninode-dashboard/check-p7-fail-closed-count-lock-bundle.js --smoke-report .runtime/loop0017-p7-failclosed-smoke.json --timeline-state .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --readiness-report .runtime/loop0017-guard-sample-readiness.json --enforce --write .runtime/loop0017-p7-failclosed-countlock-bundle.json`
- 결과: 통과(`ok=true`, 키 정책/검색 단일 경로/멀티 제공자 경로/count-lock 종료 근거/채널 표본 기준 동시 검증)
