# Loop 0018 - 통과한 실행/검증

## 실행해서 통과한 항목

1. P3 guard smoke 회귀 3회 연속 실행(로컬+텔레그램)
- 명령: `for i in 1 2 3; do node omninode-middleware/check-p3-guard-smoke.js --skip-build --attempts 1 --timeout-ms 45000 --guard-retry-timeline-state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --write .runtime/loop0018-p7-failclosed-smoke-run${i}.json; done`
- 결과: 3회 모두 통과(`ok=true`)
- 핵심 근거: 비-seed 표본 `35 -> 50`, 회차별 증분 `+5`(`chat +1`, `coding +1`, `telegram +3`), `retryScope=gemini_grounding_search`, `termination=count_lock_unsatisfied_after_retries`

2. guard 샘플 readiness 강제 검증
- 명령: `node omninode-dashboard/check-guard-sample-readiness.js --state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --enforce-ready --write .runtime/loop0018-guard-sample-readiness.json`
- 결과: 통과(`ready=true`, `total=50/30`, `chat=10`, `coding=10`, `telegram=30`)

3. P7 fail-closed/count-lock 묶음 강제 검증
- 명령: `node omninode-dashboard/check-p7-fail-closed-count-lock-bundle.js --smoke-report .runtime/loop0018-p7-failclosed-smoke-run3.json --timeline-state .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --readiness-report .runtime/loop0018-guard-sample-readiness.json --enforce --write .runtime/loop0018-p7-failclosed-countlock-bundle.json`
- 결과: 통과(`ok=true`, `GeminiKeySource=keychain|secure_file_600`, `searchPathSingleGeminiGrounding=true`, `multiProviderRouteObserved=true`, 채널 표본 `chat=10/coding=10/telegram=30`)

4. 비-seed 표본/차단률 요약 점검
- 명령: `node -e 'const fs=require("fs");const p=".runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));const entries=(j.entries||[]).filter(e=>e&&typeof e==="object"&&!String(e.id||"").startsWith("seed-")&&["chat","coding","telegram"].includes(String(e.channel||"")));const by={chat:0,coding:0,telegram:0};for(const e of entries){by[e.channel]++;}const retryRequired=entries.filter(e=>e.retryRequired===true).length;console.log(JSON.stringify({statePath:p,total:entries.length,retryRequired,retryRequiredRate:entries.length?Number((retryRequired/entries.length).toFixed(6)):0,by,generatedAtUtc:new Date().toISOString()},null,2));'`
- 결과: 통과(`total=50`, `retryRequiredRate=0.4`, `chat=10`, `coding=10`, `telegram=30`)
