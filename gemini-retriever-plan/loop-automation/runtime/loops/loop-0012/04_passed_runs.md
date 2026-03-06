# Loop 0012 - 통과한 실행/검증

## 실행해서 통과한 항목

1. readiness 샘플 기반 `guard_blocked_rate` 관측치 산출
- 명령: `node -e 'const fs=require("fs");const p=".runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));const entries=(j.entries||[]).filter(e=>e&&typeof e==="object"&&!String(e.id||"").startsWith("seed-")&&["chat","coding","telegram"].includes(String(e.channel||"")));const total=entries.length;const blockedByStop=entries.filter(e=>String(e.retryStopReason||"-")!=="-").length;const blockedByRetry=entries.filter(e=>!!e.retryRequired).length;const byChannel={chat:0,coding:0,telegram:0};const blockedByChannel={chat:0,coding:0,telegram:0};for(const e of entries){const c=e.channel;byChannel[c]++;if(String(e.retryStopReason||"-")!=="-"){blockedByChannel[c]++;}}const out={statePath:p,total,blockedByStop,blockedByRetry,blockedRateByStop:total?Number((blockedByStop/total).toFixed(6)):0,blockedRateByRetry:total?Number((blockedByRetry/total).toFixed(6)):0,byChannel,blockedByChannel,generatedAtUtc:new Date().toISOString()};console.log(JSON.stringify(out,null,2));'`
- 결과: 통과(`total=30`, `blockedRateByStop=0.4`, `blockedRateByRetry=0.4`)

2. 대시보드 스크립트 문법 검증
- 명령:
  - `node --check omninode-dashboard/app.js`
  - `node --check omninode-dashboard/check-guard-threshold-lock.js`
- 결과: 통과(문법 오류 없음)

3. guard 임계치 고정 회귀 검증
- 명령: `node omninode-dashboard/check-guard-threshold-lock.js`
- 결과: 통과(`ok=true`, `guard_blocked_rate` 고정값 `warn=0.45`, `critical=0.65` 포함 6개 체크 통과)

4. readiness 강제 검증
- 명령: `node omninode-dashboard/check-guard-sample-readiness.js --state-path .runtime/loop43-guard-retry-timeline-browser-e2e/guard_retry_timeline.json --enforce-ready`
- 결과: 통과(`ready=true`, `total=30/30`, `chat=6`, `coding=6`, `telegram=18`)
