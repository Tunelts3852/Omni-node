const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardDir = path.resolve(__dirname);
const repoRoot = path.resolve(dashboardDir, "..");

const sourcePaths = {
  executionChecklist: path.resolve(repoRoot, "gemini-retriever-plan/07_execution_checklist.md"),
  riskAndQualityPlan: path.resolve(repoRoot, "gemini-retriever-plan/08_risk_and_quality.md"),
  releaseGateChecklist: path.resolve(repoRoot, "gemini-retriever-plan/09_release_gate_checklist.md"),
  releaseNotesTemplate: path.resolve(repoRoot, "gemini-retriever-plan/10_release_notes_template.md"),
  currentStatus: path.resolve(repoRoot, "gemini-retriever-plan/loop-automation/runtime/state/CURRENT_STATUS.md"),
  omniAppConfig: path.resolve(repoRoot, "omninode-middleware/src/AppConfig.cs"),
  acpOptionSmoke: path.resolve(repoRoot, "omninode-middleware/check-acp-option-smoke.js"),
  chatMultiBrowserE2e: path.resolve(repoRoot, "omninode-dashboard/check-chat-multi-browser-e2e.js"),
  p7SecurityChecklist: path.resolve(repoRoot, "omninode-dashboard/check-p7-security-checklist.js"),
  p7RecoveryChecklist: path.resolve(repoRoot, "omninode-dashboard/check-p7-recovery-checklist.js")
};

function parseArgs(argv) {
  let writePath = "";
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--write") {
      const next = argv[i + 1];
      assert(next, "--write 옵션에는 출력 파일 경로가 필요합니다.");
      writePath = path.resolve(next);
      i += 1;
      continue;
    }
    throw new Error(`지원하지 않는 인자: ${token}`);
  }
  return { writePath };
}

function readText(filePath) {
  assert(fs.existsSync(filePath), `파일이 없습니다: ${filePath}`);
  return fs.readFileSync(filePath, "utf8");
}

function assertIncludesAll(text, patterns, label) {
  const missing = patterns.filter((pattern) => !text.includes(pattern));
  assert.equal(missing.length, 0, `${label} 누락 패턴: ${missing.join(", ")}`);
}

function checkExecutionSpec(files) {
  const executionText = readText(files.executionChecklist);
  const riskText = readText(files.riskAndQualityPlan);

  assertIncludesAll(
    executionText,
    [
      "# 실행 체크리스트",
      "키 정책 체크",
      "검색/근거 체크",
      "출력 가드 체크",
      "생성기/채널 체크"
    ],
    "07_execution_checklist.md"
  );

  assertIncludesAll(
    riskText,
    [
      "# 리스크 및 품질/운영 기준",
      "키 정책 우회",
      "count-lock",
      "fail-closed"
    ],
    "08_risk_and_quality.md"
  );

  return {
    ok: true,
    files: [files.executionChecklist, files.riskAndQualityPlan]
  };
}

function checkReleaseDocs(files) {
  const gateText = readText(files.releaseGateChecklist);
  const notesText = readText(files.releaseNotesTemplate);
  const statusText = readText(files.currentStatus);

  assertIncludesAll(
    gateText,
    [
      "# P7 릴리스 게이트 체크리스트",
      "금칙어 목록 0건 정책",
      "키 소스 정책(`keychain|secure_file_600`)",
      "요청 건수 N = 출력 건수 N"
    ],
    "09_release_gate_checklist.md"
  );

  assertIncludesAll(
    notesText,
    [
      "# Omni-node 릴리스 노트 템플릿",
      "targetCount",
      "validatedCount",
      "countLockSatisfied",
      "keySource"
    ],
    "10_release_notes_template.md"
  );

  assertIncludesAll(
    statusText,
    [
      "기준 계획: GEMINI_SEARCH_RETRIEVER_INTEGRATION_PLAN.md",
      "현재 활성 단계: P0",
      "GeminiKeySource=keychain|secure_file_600"
    ],
    "CURRENT_STATUS.md"
  );

  return {
    ok: true,
    files: [files.releaseGateChecklist, files.releaseNotesTemplate, files.currentStatus]
  };
}

function checkRuntimeScripts(files) {
  const appConfigText = readText(files.omniAppConfig);
  const acpText = readText(files.acpOptionSmoke);
  const chatE2eText = readText(files.chatMultiBrowserE2e);
  const securityText = readText(files.p7SecurityChecklist);
  const recoveryText = readText(files.p7RecoveryChecklist);

  assertIncludesAll(
    appConfigText,
    [
      "EnableHealthEndpoint = GetBoolEnv(\"OMNINODE_ENABLE_HEALTH_ENDPOINT\", true)",
      "EnableLocalOtpFallback = GetBoolEnv(\"OMNINODE_ENABLE_LOCAL_OTP_FALLBACK\", true)"
    ],
    "AppConfig.cs"
  );

  assertIncludesAll(
    acpText,
    [
      "check-acp-option-smoke.js",
      "--expect-lightcontext-direct-set",
      "promoteWriteResultToPrevious"
    ],
    "check-acp-option-smoke.js"
  );

  assertIncludesAll(
    chatE2eText,
    [
      "waitForHttpStatus(`${baseUrl}/healthz`, 200",
      "proc.kill(\"SIGINT\")",
      "proc.kill(\"SIGTERM\")",
      "proc.kill(\"SIGKILL\")"
    ],
    "check-chat-multi-browser-e2e.js"
  );

  assertIncludesAll(
    securityText,
    [
      "checkExternalContentBoundary",
      "checkLogClassification",
      "checkPermissionFlow"
    ],
    "check-p7-security-checklist.js"
  );

  assertIncludesAll(
    recoveryText,
    [
      "checkRollbackPolicy",
      "checkRuntimeIsolation",
      "checkRestartSequence"
    ],
    "check-p7-recovery-checklist.js"
  );

  return {
    ok: true,
    files: [files.omniAppConfig, files.acpOptionSmoke, files.chatMultiBrowserE2e, files.p7SecurityChecklist, files.p7RecoveryChecklist]
  };
}

function run() {
  const args = parseArgs(process.argv);

  const executionSpec = checkExecutionSpec(sourcePaths);
  const releaseDocs = checkReleaseDocs(sourcePaths);
  const runtimeScripts = checkRuntimeScripts(sourcePaths);

  const report = {
    ok: true,
    stage: "P7",
    generatedAtUtc: new Date().toISOString(),
    checklist: {
      executionSpec: executionSpec.ok,
      releaseDocs: releaseDocs.ok,
      runtimeScripts: runtimeScripts.ok
    },
    evidenceFiles: [...executionSpec.files, ...releaseDocs.files, ...runtimeScripts.files]
  };

  if (args.writePath) {
    fs.mkdirSync(path.dirname(args.writePath), { recursive: true });
    fs.writeFileSync(args.writePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report, null, 2));
}

run();
