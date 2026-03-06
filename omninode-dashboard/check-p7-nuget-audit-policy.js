const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardDir = path.resolve(__dirname);
const repoRoot = path.resolve(dashboardDir, "..");

const sourcePaths = {
  startupProbeValidation: path.resolve(repoRoot, "omninode-middleware/run-startup-probe-validation.js"),
  releaseGateChecklist: path.resolve(repoRoot, "gemini-retriever-plan/09_release_gate_checklist.md")
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

function extractBlock(text, startToken, endToken, label) {
  const startIndex = text.indexOf(startToken);
  assert.notEqual(startIndex, -1, `${label} 시작 토큰을 찾을 수 없습니다: ${startToken}`);
  const endIndex = text.indexOf(endToken, startIndex);
  assert.notEqual(endIndex, -1, `${label} 종료 토큰을 찾을 수 없습니다: ${endToken}`);
  return text.slice(startIndex, endIndex);
}

function checkStartupProbePolicy(files) {
  const startupProbeText = readText(files.startupProbeValidation);

  const prebuildBlock = extractBlock(
    startupProbeText,
    "function runPrebuild(projectPath) {",
    "async function runProbeValidationWithRetry(",
    "run-startup-probe-validation.js prebuild"
  );

  const runBlock = extractBlock(
    startupProbeText,
    "const dotnetRunArgs = [",
    "const server = spawn(",
    "run-startup-probe-validation.js run"
  );

  assertIncludesAll(
    prebuildBlock,
    [
      "\"build\",",
      "\"-p:NuGetAudit=false\",",
      "\"-p:NuGetAuditMode=direct\""
    ],
    "run-startup-probe-validation.js prebuild 정책"
  );

  assertIncludesAll(
    runBlock,
    [
      "\"run\",",
      "\"--no-build\",",
      "\"--no-restore\",",
      "\"--project\""
    ],
    "run-startup-probe-validation.js 실행 정책"
  );

  return {
    ok: true,
    files: [files.startupProbeValidation]
  };
}

function checkReleaseDocumentPolicy(files) {
  const checklistText = readText(files.releaseGateChecklist);

  assertIncludesAll(
    checklistText,
    [
      "# P7 릴리스 게이트 체크리스트",
      "금칙어 목록 0건 정책",
      "키 소스 정책(`keychain|secure_file_600`)",
      "count-lock",
      "fail-closed"
    ],
    "09_release_gate_checklist.md"
  );

  return {
    ok: true,
    files: [files.releaseGateChecklist]
  };
}

function buildResult() {
  const startup = checkStartupProbePolicy(sourcePaths);
  const document = checkReleaseDocumentPolicy(sourcePaths);

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    checklist: {
      startupProbeNugetPolicy: startup.ok,
      releaseDocumentPolicy: document.ok
    },
    evidenceFiles: [...startup.files, ...document.files]
  };
}

function main() {
  const args = parseArgs(process.argv);
  const result = buildResult();
  if (args.writePath) {
    fs.mkdirSync(path.dirname(args.writePath), { recursive: true });
    fs.writeFileSync(args.writePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error) {
  const result = {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
}
