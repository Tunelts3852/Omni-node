const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardDir = path.resolve(__dirname);
const repoRoot = path.resolve(dashboardDir, "..");

const sourcePaths = {
  memorySearchTool: path.resolve(repoRoot, "omninode-middleware/src/MemorySearchTool.cs"),
  memoryGetTool: path.resolve(repoRoot, "omninode-middleware/src/MemoryGetTool.cs"),
  memoryIndexSync: path.resolve(repoRoot, "omninode-middleware/src/MemoryIndexDocumentSync.cs"),
  conversationStore: path.resolve(repoRoot, "omninode-middleware/src/ConversationStore.cs"),
  commandService: path.resolve(repoRoot, "omninode-middleware/src/CommandService.Commands.cs"),
  gateway: path.resolve(repoRoot, "omninode-middleware/src/WebSocketGateway.cs"),
  statusDoc: path.resolve(repoRoot, "gemini-retriever-plan/loop-automation/runtime/state/CURRENT_STATUS.md")
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

function checkMemoryContracts(files) {
  const searchText = readText(files.memorySearchTool);
  const getText = readText(files.memoryGetTool);
  const syncText = readText(files.memoryIndexSync);

  assertIncludesAll(
    searchText,
    [
      "memory_search",
      "minScore",
      "maxResults",
      "results",
      "disabled"
    ],
    "MemorySearchTool.cs"
  );

  assertIncludesAll(
    getText,
    [
      "memory_get",
      "path required",
      "from",
      "lines",
      "disabled"
    ],
    "MemoryGetTool.cs"
  );

  assertIncludesAll(
    syncText,
    [
      "sync scanned=",
      "indexed=",
      "removed=",
      "fts=",
      "Sqlite"
    ],
    "MemoryIndexDocumentSync.cs"
  );

  return {
    ok: true,
    files: [files.memorySearchTool, files.memoryGetTool, files.memoryIndexSync]
  };
}

function checkInjectionPath(files) {
  const commandText = readText(files.commandService);
  const gatewayText = readText(files.gateway);
  const storeText = readText(files.conversationStore);
  const statusText = readText(files.statusDoc);

  assertIncludesAll(
    commandText,
    [
      "memory_search",
      "memory_get",
      "web_search",
      "web_fetch"
    ],
    "CommandService.Commands.cs"
  );

  assertIncludesAll(
    gatewayText,
    [
      "memory_search_result",
      "memory_get_result",
      "web_search_result",
      "web_fetch_result"
    ],
    "WebSocketGateway.cs"
  );

  assertIncludesAll(
    storeText,
    [
      "ConversationState",
      "Save()",
      "Load()",
      "Messages"
    ],
    "ConversationStore.cs"
  );

  assertIncludesAll(
    statusText,
    [
      "기준 계획: GEMINI_SEARCH_RETRIEVER_INTEGRATION_PLAN.md",
      "현재 활성 단계: P0"
    ],
    "CURRENT_STATUS.md"
  );

  return {
    ok: true,
    files: [files.commandService, files.gateway, files.conversationStore, files.statusDoc]
  };
}

function run() {
  const args = parseArgs(process.argv);

  const contracts = checkMemoryContracts(sourcePaths);
  const injection = checkInjectionPath(sourcePaths);

  const report = {
    ok: true,
    stage: "P3",
    generatedAtUtc: new Date().toISOString(),
    checklist: {
      memoryContracts: contracts.ok,
      injectionPath: injection.ok
    },
    evidenceFiles: [...contracts.files, ...injection.files]
  };

  if (args.writePath) {
    fs.mkdirSync(path.dirname(args.writePath), { recursive: true });
    fs.writeFileSync(args.writePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report, null, 2));
}

run();
