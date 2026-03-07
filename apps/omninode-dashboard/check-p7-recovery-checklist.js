const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardDir = path.resolve(__dirname);
const repoRoot = path.resolve(dashboardDir, "..");

const sourcePaths = {
  riskAndQualityPlan: path.resolve(repoRoot, "gemini-retriever-plan/08_risk_and_quality.md"),
  currentStatus: path.resolve(repoRoot, "gemini-retriever-plan/loop-automation/runtime/state/CURRENT_STATUS.md"),
  loopRunScript: path.resolve(repoRoot, "gemini-retriever-plan/loop-automation/run_codex_dev_loop.sh"),
  loopStatusScript: path.resolve(repoRoot, "gemini-retriever-plan/loop-automation/status_codex_dev_loop.sh"),
  loopStopScript: path.resolve(repoRoot, "gemini-retriever-plan/loop-automation/stop_codex_dev_loop.sh"),
  omniProgram: path.resolve(repoRoot, "omninode-middleware/src/Program.cs"),
  omniAppConfig: path.resolve(repoRoot, "omninode-middleware/src/AppConfig.cs"),
  omniGateway: path.resolve(repoRoot, "omninode-middleware/src/WebSocketGateway.cs"),
  omniStartupProbe: path.resolve(repoRoot, "omninode-middleware/src/GatewayStartupProbe.cs"),
  dashboardE2eScript: path.resolve(repoRoot, "omninode-dashboard/check-chat-multi-browser-e2e.js")
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

function checkRollbackPolicy(files) {
  const riskText = readText(files.riskAndQualityPlan);
  assertIncludesAll(
    riskText,
    [
      "## 4. 장애 대응 기준",
      "즉시 차단 조건",
      "키 소스 정책 위반",
      "fail-closed 미적용",
      "count-lock 우회 출력"
    ],
    "08_risk_and_quality.md"
  );

  const statusText = readText(files.currentStatus);
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
    files: [files.riskAndQualityPlan, files.currentStatus]
  };
}

function checkRuntimeIsolation(files) {
  const appConfigText = readText(files.omniAppConfig);
  const gatewayText = readText(files.omniGateway);
  const startupProbeText = readText(files.omniStartupProbe);

  assertIncludesAll(
    appConfigText,
    [
      "EnableHealthEndpoint = GetBoolEnv(\"OMNINODE_ENABLE_HEALTH_ENDPOINT\", true)",
      "EnableGatewayStartupProbe = GetBoolEnv(\"OMNINODE_GATEWAY_STARTUP_PROBE\", false)",
      "EnableLocalOtpFallback = GetBoolEnv(\"OMNINODE_ENABLE_LOCAL_OTP_FALLBACK\", true)"
    ],
    "AppConfig.cs"
  );

  assertIncludesAll(
    gatewayText,
    [
      "[web] degraded mode enabled: websocket/dashboard listener unavailable",
      "status: \"degraded\"",
      "WriteGatewayHealthSnapshot"
    ],
    "WebSocketGateway.cs"
  );

  assertIncludesAll(
    startupProbeText,
    [
      "WriteProbeSnapshot(",
      "result=failed",
      "ResolveReasonMetadata"
    ],
    "GatewayStartupProbe.cs"
  );

  return {
    ok: true,
    files: [files.omniAppConfig, files.omniGateway, files.omniStartupProbe]
  };
}

function checkRestartSequence(files) {
  const runLoopText = readText(files.loopRunScript);
  const statusLoopText = readText(files.loopStatusScript);
  const stopLoopText = readText(files.loopStopScript);
  const programText = readText(files.omniProgram);
  const e2eText = readText(files.dashboardE2eScript);

  assertIncludesAll(
    runLoopText,
    [
      "STOP_FILE=\"$RUNTIME_DIR/STOP\"",
      "request_stop_on_signal()",
      "현재 루프 완료 후 안전 종료합니다.",
      "detect_gemini_key_source",
      "GeminiKeySource = keychain | secure_file_600"
    ],
    "run_codex_dev_loop.sh"
  );

  assertIncludesAll(
    statusLoopText,
    [
      "STOP_FILE=\"$RUNTIME_DIR/STOP\"",
      "[status] 정지 요청:",
      "cat \"$RUN_FILE\""
    ],
    "status_codex_dev_loop.sh"
  );

  assertIncludesAll(
    stopLoopText,
    [
      "touch \"$STOP_FILE\"",
      "현재 루프가 끝나면 안전 종료됩니다.",
      "cat \"$RUN_FILE\""
    ],
    "stop_codex_dev_loop.sh"
  );

  assertIncludesAll(
    programText,
    [
      "using var cts = new CancellationTokenSource();",
      "Console.CancelKeyPress += (_, eventArgs) =>",
      "await Task.WhenAll(webTask, telegramTask);"
    ],
    "Program.cs"
  );

  assertIncludesAll(
    e2eText,
    [
      "proc.kill(\"SIGINT\")",
      "proc.kill(\"SIGTERM\")",
      "proc.kill(\"SIGKILL\")"
    ],
    "check-chat-multi-browser-e2e.js"
  );

  return {
    ok: true,
    files: [files.loopRunScript, files.loopStatusScript, files.loopStopScript, files.omniProgram, files.dashboardE2eScript]
  };
}

function run() {
  const args = parseArgs(process.argv);

  const rollback = checkRollbackPolicy(sourcePaths);
  const isolation = checkRuntimeIsolation(sourcePaths);
  const restart = checkRestartSequence(sourcePaths);

  const report = {
    ok: true,
    stage: "P7",
    generatedAtUtc: new Date().toISOString(),
    checklist: {
      rollbackPolicy: rollback.ok,
      runtimeIsolation: isolation.ok,
      restartSequence: restart.ok
    },
    evidenceFiles: [...rollback.files, ...isolation.files, ...restart.files]
  };

  if (args.writePath) {
    fs.mkdirSync(path.dirname(args.writePath), { recursive: true });
    fs.writeFileSync(args.writePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report, null, 2));
}

run();
