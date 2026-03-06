const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardDir = path.resolve(__dirname);
const repoRoot = path.resolve(dashboardDir, "..");

const sourcePaths = {
  omniExternalGuard: path.resolve(repoRoot, "omninode-middleware/src/ExternalContentGuard.cs"),
  omniWebSearchTool: path.resolve(repoRoot, "omninode-middleware/src/WebSearchTool.cs"),
  omniWebFetchTool: path.resolve(repoRoot, "omninode-middleware/src/WebFetchTool.cs"),
  omniGateway: path.resolve(repoRoot, "omninode-middleware/src/WebSocketGateway.cs"),
  omniCommands: path.resolve(repoRoot, "omninode-middleware/src/CommandService.Commands.cs"),
  omniTelegram: path.resolve(repoRoot, "omninode-middleware/src/CommandService.Telegram.cs"),
  omniAuditLogger: path.resolve(repoRoot, "omninode-middleware/src/AuditLogger.cs"),
  omniAppConfig: path.resolve(repoRoot, "omninode-middleware/src/AppConfig.cs"),
  dashboardApp: path.resolve(repoRoot, "omninode-dashboard/app.js")
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

function checkExternalContentBoundary(files) {
  const guardText = readText(files.omniExternalGuard);
  const webSearchText = readText(files.omniWebSearchTool);
  const webFetchText = readText(files.omniWebFetchTool);
  const gatewayText = readText(files.omniGateway);

  assertIncludesAll(
    guardText,
    [
      "StartMarkerName = \"EXTERNAL_UNTRUSTED_CONTENT\"",
      "EndMarkerName = \"END_EXTERNAL_UNTRUSTED_CONTENT\"",
      "public static string WrapWebContent",
      "public static string ReplaceBoundaryMarkers"
    ],
    "ExternalContentGuard.cs"
  );

  assertIncludesAll(
    webSearchText,
    [
      "ExternalContentGuard.WrapWebContent",
      "ExternalContentDescriptor",
      "Untrusted: true",
      "Wrapped: true"
    ],
    "WebSearchTool.cs"
  );

  assertIncludesAll(
    webFetchText,
    [
      "ExternalContentGuard.WrapWebContent",
      "ExternalContentDescriptor",
      "Wrapped: true"
    ],
    "WebFetchTool.cs"
  );

  assertIncludesAll(
    gatewayText,
    [
      "\"web_search_result\"",
      "\"web_fetch_result\"",
      "\"externalContent\""
    ],
    "WebSocketGateway.cs"
  );

  return {
    ok: true,
    files: [files.omniExternalGuard, files.omniWebSearchTool, files.omniWebFetchTool, files.omniGateway]
  };
}

function checkLogClassification(files) {
  const appText = readText(files.dashboardApp);
  const auditText = readText(files.omniAuditLogger);

  assertIncludesAll(
    appText,
    [
      "const OPS_DOMAIN_FILTERS = [",
      "key: \"provider\"",
      "key: \"tool\"",
      "key: \"rag\"",
      "const TOOL_RESULT_DOMAIN_BY_GROUP = {"
    ],
    "app.js"
  );

  assertIncludesAll(
    auditText,
    [
      "\"source\":\"",
      "\"action\":\"",
      "\"status\":\"",
      "Trim(message, 1200)"
    ],
    "AuditLogger.cs"
  );

  return {
    ok: true,
    files: [files.dashboardApp, files.omniAuditLogger]
  };
}

function checkPermissionFlow(files) {
  const commandsText = readText(files.omniCommands);
  const telegramText = readText(files.omniTelegram);
  const appConfigText = readText(files.omniAppConfig);

  assertIncludesAll(
    commandsText,
    [
      "TryParseKillCommand",
      "ValidateKillTargetAsync",
      "_auditLogger.Log(source, \"kill\", \"deny\"",
      "_auditLogger.Log(source, \"kill\", \"ok\""
    ],
    "CommandService.Commands.cs"
  );

  assertIncludesAll(
    telegramText,
    [
      "ValidateKillTargetAsync(pid, \"telegram\"",
      "_auditLogger.Log(\"telegram\", \"kill\", \"deny\"",
      "_auditLogger.Log(\"telegram\", \"kill\", \"ok\""
    ],
    "CommandService.Telegram.cs"
  );

  assertIncludesAll(
    appConfigText,
    [
      "KillAllowlistCsv = GetStringEnv(\"OMNINODE_KILL_ALLOWLIST\", string.Empty)"
    ],
    "AppConfig.cs"
  );

  return {
    ok: true,
    files: [files.omniCommands, files.omniTelegram, files.omniAppConfig]
  };
}

function run() {
  const args = parseArgs(process.argv);

  const externalBoundary = checkExternalContentBoundary(sourcePaths);
  const logClassification = checkLogClassification(sourcePaths);
  const permissionFlow = checkPermissionFlow(sourcePaths);

  const report = {
    ok: true,
    stage: "P7",
    generatedAtUtc: new Date().toISOString(),
    checklist: {
      externalContentBoundary: externalBoundary.ok,
      logClassification: logClassification.ok,
      permissionFlow: permissionFlow.ok
    },
    evidenceFiles: [...externalBoundary.files, ...logClassification.files, ...permissionFlow.files]
  };

  if (args.writePath) {
    fs.mkdirSync(path.dirname(args.writePath), { recursive: true });
    fs.writeFileSync(args.writePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report, null, 2));
}

run();
