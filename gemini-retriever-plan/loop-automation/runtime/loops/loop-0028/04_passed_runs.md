# Loop 0028 - 통과한 실행/검증

## 실행해서 통과한 항목

1. guard 회귀 계약 스크립트 문법 점검
- 명령: `node --check omninode-dashboard/check-guard-regression-workflow-artifacts.js`
- 결과: 통과(종료 코드 `0`)

2. guard 회귀 워크플로 정적 계약 검증
- 명령: `node omninode-dashboard/check-guard-regression-workflow-artifacts.js`
- 결과: 통과(`ok=true`)
- 핵심 근거: `runtimeGeneratedMaxSkewSource="not_applied"`(runtime artifact 미입력)

3. runtime artifact 입력 모드 계약 검증(시간 편차 기본 강제 정책 포함)
- 명령: `node omninode-dashboard/check-guard-regression-workflow-artifacts.js --runtime-artifact-root .runtime/loop0023-runtime-artifacts --require-runtime-contract --require-runtime-key-source secure_file_600 --require-guard-alert-mock-run executed --require-guard-alert-live-run skipped_no_live_urls --require-guard-retry-browser-run executed --write .runtime/loop0028-guard-regression-runtime-artifacts.json`
- 결과: 통과(`ok=true`, `runtimeContractSatisfied=true`)
- 핵심 근거: `runtimeGeneratedMaxSkewSeconds=5400`, `runtimeGeneratedMaxSkewSource="default_when_require_runtime_contract"`, `runtimeGeneratedSkewSeconds=89.15`
