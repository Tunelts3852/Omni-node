#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardDir = path.resolve(__dirname);
const repoRoot = path.resolve(dashboardDir, "..");

const sourcePaths = {
  guardAlertWorkflow: path.resolve(repoRoot, ".github/workflows/guard-alert-dispatch-regression.yml"),
  guardRetryBrowserWorkflow: path.resolve(repoRoot, ".github/workflows/guard-retry-timeline-browser-e2e-regression.yml")
};

const KEY_SOURCE_POLICY = "keychain|secure_file_600";
const GEMINI_KEY_REQUIRED_FOR = ["test", "validation", "regression", "production_run"];
const ALLOWED_KEY_SOURCES = new Set(["keychain", "secure_file_600"]);
const DEFAULT_RUNTIME_GENERATED_MAX_SKEW_SECONDS = 5400;

function parseArgs(argv) {
  let writePath = "";
  let guardAlertManifestPath = "";
  let guardRetryBrowserManifestPath = "";
  let runtimeArtifactRoot = "";
  let guardAlertArtifactDir = "";
  let guardRetryBrowserArtifactDir = "";
  let requireRuntimeContract = false;
  let requireRuntimeKeySource = "";
  let requireRuntimeGeneratedAfter = "";
  let requireRuntimeGeneratedBefore = "";
  let requireRuntimeGeneratedMaxSkewSeconds = null;
  let requireGuardAlertMockRun = "";
  let requireGuardAlertLiveRun = "";
  let requireGuardRetryBrowserRun = "";
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--write") {
      const next = argv[i + 1];
      assert(next, "--write 옵션에는 출력 파일 경로가 필요합니다.");
      writePath = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--guard-alert-manifest") {
      const next = argv[i + 1];
      assert(next, "--guard-alert-manifest 옵션에는 파일 경로가 필요합니다.");
      guardAlertManifestPath = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--guard-retry-browser-manifest") {
      const next = argv[i + 1];
      assert(next, "--guard-retry-browser-manifest 옵션에는 파일 경로가 필요합니다.");
      guardRetryBrowserManifestPath = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--runtime-artifact-root") {
      const next = argv[i + 1];
      assert(next, "--runtime-artifact-root 옵션에는 디렉터리 경로가 필요합니다.");
      runtimeArtifactRoot = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--guard-alert-artifact-dir") {
      const next = argv[i + 1];
      assert(next, "--guard-alert-artifact-dir 옵션에는 디렉터리 경로가 필요합니다.");
      guardAlertArtifactDir = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--guard-retry-browser-artifact-dir") {
      const next = argv[i + 1];
      assert(next, "--guard-retry-browser-artifact-dir 옵션에는 디렉터리 경로가 필요합니다.");
      guardRetryBrowserArtifactDir = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--require-runtime-contract") {
      requireRuntimeContract = true;
      continue;
    }
    if (token === "--require-runtime-key-source") {
      const next = argv[i + 1];
      assert(next, "--require-runtime-key-source 옵션에는 key source 값이 필요합니다.");
      assertAllowedValue(next, ALLOWED_KEY_SOURCES, "--require-runtime-key-source");
      requireRuntimeKeySource = next;
      i += 1;
      continue;
    }
    if (token === "--require-runtime-generated-after") {
      const next = argv[i + 1];
      assert(next, "--require-runtime-generated-after 옵션에는 ISO8601 UTC 시각이 필요합니다.");
      const parsedAtMs = Date.parse(next);
      assert(
        !Number.isNaN(parsedAtMs),
        "--require-runtime-generated-after 옵션은 ISO8601 UTC 시각이어야 합니다."
      );
      requireRuntimeGeneratedAfter = new Date(parsedAtMs).toISOString();
      i += 1;
      continue;
    }
    if (token === "--require-runtime-generated-before") {
      const next = argv[i + 1];
      assert(next, "--require-runtime-generated-before 옵션에는 ISO8601 UTC 시각이 필요합니다.");
      const parsedAtMs = Date.parse(next);
      assert(
        !Number.isNaN(parsedAtMs),
        "--require-runtime-generated-before 옵션은 ISO8601 UTC 시각이어야 합니다."
      );
      requireRuntimeGeneratedBefore = new Date(parsedAtMs).toISOString();
      i += 1;
      continue;
    }
    if (token === "--require-runtime-generated-max-skew-seconds") {
      const next = argv[i + 1];
      assert(next, "--require-runtime-generated-max-skew-seconds 옵션에는 0 이상의 초 단위 값이 필요합니다.");
      const parsedSeconds = Number(next);
      assert(
        Number.isFinite(parsedSeconds) && parsedSeconds >= 0,
        "--require-runtime-generated-max-skew-seconds 옵션은 0 이상의 숫자여야 합니다."
      );
      requireRuntimeGeneratedMaxSkewSeconds = parsedSeconds;
      i += 1;
      continue;
    }
    if (token === "--require-guard-alert-mock-run") {
      const next = argv[i + 1];
      assert(next, "--require-guard-alert-mock-run 옵션에는 실행 상태 값이 필요합니다.");
      assertAllowedValue(next, new Set(["executed", "missing_json"]), "--require-guard-alert-mock-run");
      requireGuardAlertMockRun = next;
      i += 1;
      continue;
    }
    if (token === "--require-guard-alert-live-run") {
      const next = argv[i + 1];
      assert(next, "--require-guard-alert-live-run 옵션에는 실행 상태 값이 필요합니다.");
      assertAllowedValue(
        next,
        new Set(["executed", "skipped_no_live_urls", "failed_before_json", "not_run"]),
        "--require-guard-alert-live-run"
      );
      requireGuardAlertLiveRun = next;
      i += 1;
      continue;
    }
    if (token === "--require-guard-retry-browser-run") {
      const next = argv[i + 1];
      assert(next, "--require-guard-retry-browser-run 옵션에는 실행 상태 값이 필요합니다.");
      assertAllowedValue(
        next,
        new Set(["executed", "missing_json"]),
        "--require-guard-retry-browser-run"
      );
      requireGuardRetryBrowserRun = next;
      i += 1;
      continue;
    }
    throw new Error(`지원하지 않는 인자: ${token}`);
  }
  return {
    writePath,
    guardAlertManifestPath,
    guardRetryBrowserManifestPath,
    runtimeArtifactRoot,
    guardAlertArtifactDir,
    guardRetryBrowserArtifactDir,
    requireRuntimeContract,
    requireRuntimeKeySource,
    requireRuntimeGeneratedAfter,
    requireRuntimeGeneratedBefore,
    requireRuntimeGeneratedMaxSkewSeconds,
    requireGuardAlertMockRun,
    requireGuardAlertLiveRun,
    requireGuardRetryBrowserRun
  };
}

function readText(filePath) {
  assert(fs.existsSync(filePath), `파일이 없습니다: ${filePath}`);
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath, label) {
  const text = readText(filePath);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} JSON 파싱 실패: ${error.message}`);
  }
}

function assertIncludesAll(text, patterns, label) {
  const missing = patterns.filter((pattern) => !text.includes(pattern));
  assert.equal(missing.length, 0, `${label} 누락 패턴: ${missing.join(", ")}`);
}

function assertNoDirectGeminiKeyInjection(text, label) {
  const forbiddenPatterns = [
    {
      pattern: /^\s*OMNINODE_GEMINI_API_KEY\s*:/m,
      reason: "workflow env 직접 선언"
    },
    {
      pattern: /\bOMNINODE_GEMINI_API_KEY\s*:\s*\$\{\{\s*secrets\./,
      reason: "env secret 직접 매핑"
    },
    {
      pattern: /\bexport\s+OMNINODE_GEMINI_API_KEY(?!_)\b/,
      reason: "shell export 직접 주입"
    },
    {
      pattern: /\becho\s+["']OMNINODE_GEMINI_API_KEY(?!_)=/,
      reason: "GITHUB_ENV 직접 주입"
    },
    {
      pattern: /\bOMNINODE_GEMINI_API_KEY(?!_)\s*=\s*\$\{\{\s*secrets\./,
      reason: "shell 변수 secret 직접 대입"
    },
    {
      pattern: /\bsecrets\.OMNINODE_GEMINI_API_KEY(?!_SECURE_FILE_CONTENT)\b/,
      reason: "GitHub secret 직접 참조"
    },
    {
      pattern: /\bvars\.OMNINODE_GEMINI_API_KEY(?!_SECURE_FILE_CONTENT)\b/,
      reason: "GitHub variable 직접 참조"
    },
    {
      pattern: /\bOMNINODE_GEMINI_API_KEY(?!_)\s*=/,
      reason: "shell 변수 직접 대입"
    }
  ];
  const detectedReasons = forbiddenPatterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ reason }) => reason);
  assert.equal(
    detectedReasons.length,
    0,
    `${label} 정책 위반: OMNINODE_GEMINI_API_KEY 직접 주입 패턴 감지 (${detectedReasons.join(", ")})`
  );
}

function assertIsoTimestamp(value, label) {
  assert.equal(typeof value, "string", `${label} 는 문자열이어야 합니다.`);
  assert(!Number.isNaN(Date.parse(value)), `${label} 는 ISO8601 UTC 타임스탬프여야 합니다.`);
}

function assertPlainObject(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} 는 객체여야 합니다.`);
}

function assertBooleanFields(obj, fields, label) {
  for (const field of fields) {
    assert.equal(typeof obj[field], "boolean", `${label}.${field} 는 boolean 이어야 합니다.`);
  }
}

function assertAllowedValue(value, allowedSet, label) {
  assert(allowedSet.has(value), `${label} 허용값: ${Array.from(allowedSet).join(", ")} (현재: ${value})`);
}

function assertArtifactExists(filePath, expected, label) {
  const exists = fs.existsSync(filePath);
  assert.equal(
    exists,
    expected,
    `${label} 존재성 불일치 (expected=${expected}, actual=${exists}, path=${filePath})`
  );
}

function assertDirectory(filePath, label) {
  assert(fs.existsSync(filePath), `${label} 디렉터리가 없습니다: ${filePath}`);
  assert(fs.statSync(filePath).isDirectory(), `${label} 경로는 디렉터리여야 합니다: ${filePath}`);
}

function assertPathInsideDirectory(filePath, dirPath, label) {
  const relativePath = path.relative(dirPath, filePath);
  assert(
    !relativePath.startsWith("..") && !path.isAbsolute(relativePath),
    `${label} 경로는 artifact 디렉터리 하위여야 합니다: ${filePath} (artifact_dir=${dirPath})`
  );
}

function listFilesByNameRecursively(rootDirPath, fileName) {
  const matches = [];
  const stack = [rootDirPath];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === fileName) {
        matches.push(entryPath);
      }
    }
  }
  return matches;
}

function resolveRuntimeArtifactContext(artifactDirPath, explicitManifestPath, expectedWorkflow, label) {
  assertDirectory(artifactDirPath, `${label} runtime artifact`);

  if (explicitManifestPath) {
    assert(fs.existsSync(explicitManifestPath), `${label} execution-manifest 파일이 없습니다: ${explicitManifestPath}`);
    assertPathInsideDirectory(explicitManifestPath, artifactDirPath, `${label} execution-manifest`);
    return {
      manifestPath: explicitManifestPath,
      artifactDirPath: path.dirname(explicitManifestPath)
    };
  }

  const manifestCandidates = listFilesByNameRecursively(artifactDirPath, "execution-manifest.json");
  assert(
    manifestCandidates.length > 0,
    `${label} runtime artifact execution-manifest 누락: ${artifactDirPath}`
  );

  const workflowMatches = [];
  const parseErrors = [];
  for (const manifestPath of manifestCandidates) {
    try {
      const manifest = readJson(manifestPath, `${label} execution-manifest`);
      if (manifest && manifest.workflow === expectedWorkflow) {
        workflowMatches.push({
          manifestPath,
          artifactDirPath: path.dirname(manifestPath),
          modifiedAtMs: fs.statSync(manifestPath).mtimeMs
        });
      }
    } catch (error) {
      parseErrors.push(`${manifestPath}: ${error.message}`);
    }
  }

  assert(
    workflowMatches.length > 0,
    [
      `${label} runtime artifact에서 workflow=${expectedWorkflow} execution-manifest를 찾지 못했습니다.`,
      `검색 경로: ${artifactDirPath}`,
      `후보 파일: ${manifestCandidates.join(", ")}`,
      parseErrors.length > 0 ? `파싱 실패: ${parseErrors.join(" | ")}` : ""
    ]
      .filter(Boolean)
      .join(" ")
  );

  workflowMatches.sort((left, right) => {
    if (left.modifiedAtMs !== right.modifiedAtMs) {
      return right.modifiedAtMs - left.modifiedAtMs;
    }
    return left.manifestPath.localeCompare(right.manifestPath);
  });

  return {
    manifestPath: workflowMatches[0].manifestPath,
    artifactDirPath: workflowMatches[0].artifactDirPath
  };
}

function assertKeyPolicyContract(manifest, label) {
  assert.equal(
    manifest.keySourcePolicy,
    KEY_SOURCE_POLICY,
    `${label}.keySourcePolicy 는 ${KEY_SOURCE_POLICY} 이어야 합니다.`
  );
  assert.deepEqual(
    manifest.geminiKeyRequiredFor,
    GEMINI_KEY_REQUIRED_FOR,
    `${label}.geminiKeyRequiredFor 계약 불일치`
  );
  assertAllowedValue(manifest.keySource, ALLOWED_KEY_SOURCES, `${label}.keySource`);
}

function checkGuardAlertWorkflow(filePath) {
  const text = readText(filePath);
  assertIncludesAll(
    text,
    [
      "name: guard-alert-dispatch-regression",
      "GEMINI_KEY_SOURCE_POLICY=keychain|secure_file_600",
      "GEMINI_KEY_VALIDATED_SOURCE=secure_file_600",
      "정책 위반: OMNINODE_GEMINI_API_KEY 직접 주입 금지",
      "키 소스 검증 실패: OMNINODE_GEMINI_API_KEY_SECURE_FILE_CONTENT 미설정",
      "정책 위반: OMNINODE_GEMINI_API_KEY 직접 주입 감지",
      "mock-regression-console.log",
      "live-regression-console.log",
      "execution-manifest.json",
      "live URL 미설정: live 회귀 생략",
      "liveRunStatus = \"skipped_no_live_urls\"",
      "liveRunStatus = \"failed_before_json\"",
      "workflow: \"guard-alert-dispatch-regression\"",
      "keySourcePolicy: process.env.GEMINI_KEY_SOURCE_POLICY || \"keychain|secure_file_600\"",
      "keySource: process.env.GEMINI_KEY_VALIDATED_SOURCE || \"unknown\"",
      "geminiKeyRequiredFor: [\"test\", \"validation\", \"regression\", \"production_run\"]",
      "--write \"$mock_json\"",
      "--write \"$live_json\"",
      "uses: actions/upload-artifact@v4",
      "path: /tmp/guard-alert-regression/*",
      "retention-days: 14",
      "if-no-files-found: error"
    ],
    "guard-alert-dispatch-regression.yml"
  );
  assertNoDirectGeminiKeyInjection(text, "guard-alert-dispatch-regression.yml");

  return {
    ok: true,
    noDirectGeminiKeyInjection: true,
    workflow: "guard-alert-dispatch-regression",
    file: filePath
  };
}

function checkGuardRetryBrowserWorkflow(filePath) {
  const text = readText(filePath);
  assertIncludesAll(
    text,
    [
      "name: guard-retry-timeline-browser-e2e-regression",
      "GEMINI_KEY_SOURCE_POLICY=keychain|secure_file_600",
      "GEMINI_KEY_VALIDATED_SOURCE=secure_file_600",
      "정책 위반: OMNINODE_GEMINI_API_KEY 직접 주입 금지",
      "키 소스 검증 실패: OMNINODE_GEMINI_API_KEY_SECURE_FILE_CONTENT 미설정",
      "정책 위반: OMNINODE_GEMINI_API_KEY 직접 주입 감지",
      "gemini_key_required_for=test,validation,regression,production_run",
      "browser-e2e-console.log",
      "browser-e2e-stderr.log",
      "browser-e2e-result.json",
      "p3-guard-smoke.json",
      "guard-sample-readiness.json",
      "p7-failclosed-countlock-bundle.json",
      "execution-manifest.json",
      "브라우저 E2E 회귀 실패 (exit=$run_status)",
      "node omninode-middleware/check-p3-guard-smoke.js",
      "--attempts 6",
      "--enforce-ready",
      "node omninode-dashboard/check-p7-fail-closed-count-lock-bundle.js",
      "--enforce",
      "workflow: \"guard-retry-timeline-browser-e2e-regression\"",
      "keySourcePolicy: process.env.GEMINI_KEY_SOURCE_POLICY || \"keychain|secure_file_600\"",
      "keySource: process.env.GEMINI_KEY_VALIDATED_SOURCE || \"unknown\"",
      "geminiKeyRequiredFor: [\"test\", \"validation\", \"regression\", \"production_run\"]",
      "run: fs.existsSync(files.resultJson) ? \"executed\" : \"missing_json\"",
      "p3GuardSmokeJson: fs.existsSync(files.p3GuardSmokeJson)",
      "sampleReadinessJson: fs.existsSync(files.sampleReadinessJson)",
      "failClosedCountLockBundleJson: fs.existsSync(files.failClosedCountLockBundleJson)",
      "uses: actions/upload-artifact@v4",
      "path: /tmp/guard-retry-timeline-browser-e2e-regression/*",
      "retention-days: 14",
      "if-no-files-found: error"
    ],
    "guard-retry-timeline-browser-e2e-regression.yml"
  );
  assertNoDirectGeminiKeyInjection(text, "guard-retry-timeline-browser-e2e-regression.yml");

  return {
    ok: true,
    noDirectGeminiKeyInjection: true,
    workflow: "guard-retry-timeline-browser-e2e-regression",
    file: filePath
  };
}

function checkGuardAlertRuntimeManifest(filePath) {
  const manifest = readJson(filePath, "guard-alert execution-manifest");
  assertPlainObject(manifest, "guard-alert execution-manifest");
  assert.equal(
    manifest.workflow,
    "guard-alert-dispatch-regression",
    "guard-alert execution-manifest.workflow 계약 불일치"
  );
  assertIsoTimestamp(manifest.generatedAtUtc, "guard-alert execution-manifest.generatedAtUtc");
  assertKeyPolicyContract(manifest, "guard-alert execution-manifest");

  assertPlainObject(manifest.runs, "guard-alert execution-manifest.runs");
  assertAllowedValue(
    manifest.runs.mock,
    new Set(["executed", "missing_json"]),
    "guard-alert execution-manifest.runs.mock"
  );
  assertAllowedValue(
    manifest.runs.live,
    new Set(["executed", "skipped_no_live_urls", "failed_before_json", "not_run"]),
    "guard-alert execution-manifest.runs.live"
  );

  assertPlainObject(manifest.artifacts, "guard-alert execution-manifest.artifacts");
  assertBooleanFields(
    manifest.artifacts,
    ["mockJson", "mockConsoleLog", "liveJson", "liveConsoleLog"],
    "guard-alert execution-manifest.artifacts"
  );

  if (manifest.runs.mock === "executed") {
    assert.equal(
      manifest.artifacts.mockJson,
      true,
      "guard-alert 실행 상태가 executed 인 경우 mockJson artifact 는 반드시 true 여야 합니다."
    );
  }
  if (manifest.runs.live === "executed") {
    assert.equal(
      manifest.artifacts.liveJson,
      true,
      "guard-alert live 상태가 executed 인 경우 liveJson artifact 는 반드시 true 여야 합니다."
    );
  }
  if (manifest.runs.live === "skipped_no_live_urls") {
    assert.equal(
      manifest.artifacts.liveConsoleLog,
      true,
      "guard-alert live 상태가 skipped_no_live_urls 인 경우 liveConsoleLog 가 필요합니다."
    );
  }

  return {
    ok: true,
    workflow: "guard-alert-dispatch-regression",
    file: filePath,
    keySource: manifest.keySource,
    manifest
  };
}

function checkGuardRetryBrowserRuntimeManifest(filePath) {
  const manifest = readJson(filePath, "guard-retry-browser execution-manifest");
  assertPlainObject(manifest, "guard-retry-browser execution-manifest");
  assert.equal(
    manifest.workflow,
    "guard-retry-timeline-browser-e2e-regression",
    "guard-retry-browser execution-manifest.workflow 계약 불일치"
  );
  assertIsoTimestamp(manifest.generatedAtUtc, "guard-retry-browser execution-manifest.generatedAtUtc");
  assertKeyPolicyContract(manifest, "guard-retry-browser execution-manifest");

  assertAllowedValue(
    manifest.run,
    new Set(["executed", "missing_json"]),
    "guard-retry-browser execution-manifest.run"
  );

  assertPlainObject(manifest.artifacts, "guard-retry-browser execution-manifest.artifacts");
  assertBooleanFields(
    manifest.artifacts,
    [
      "resultJson",
      "consoleLog",
      "stderrLog",
      "p3GuardSmokeJson",
      "sampleReadinessJson",
      "failClosedCountLockBundleJson"
    ],
    "guard-retry-browser execution-manifest.artifacts"
  );

  if (manifest.run === "executed") {
    assert.equal(
      manifest.artifacts.resultJson,
      true,
      "guard-retry-browser 실행 상태가 executed 인 경우 resultJson artifact 는 반드시 true 여야 합니다."
    );
    assert.equal(
      manifest.artifacts.consoleLog,
      true,
      "guard-retry-browser 실행 상태가 executed 인 경우 consoleLog artifact 는 반드시 true 여야 합니다."
    );
    assert.equal(
      manifest.artifacts.sampleReadinessJson,
      true,
      "guard-retry-browser 실행 상태가 executed 인 경우 sampleReadinessJson artifact 는 반드시 true 여야 합니다."
    );
    assert.equal(
      manifest.artifacts.p3GuardSmokeJson,
      true,
      "guard-retry-browser 실행 상태가 executed 인 경우 p3GuardSmokeJson artifact 는 반드시 true 여야 합니다."
    );
    assert.equal(
      manifest.artifacts.failClosedCountLockBundleJson,
      true,
      "guard-retry-browser 실행 상태가 executed 인 경우 failClosedCountLockBundleJson artifact 는 반드시 true 여야 합니다."
    );
  }

  return {
    ok: true,
    workflow: "guard-retry-timeline-browser-e2e-regression",
    file: filePath,
    keySource: manifest.keySource,
    manifest
  };
}

function checkGuardAlertRuntimeArtifacts(artifactDirPath, manifest) {
  assertPlainObject(manifest, "guard-alert runtime manifest");
  assertDirectory(artifactDirPath, "guard-alert runtime artifact");

  const files = {
    mockJson: path.join(artifactDirPath, "mock-regression.json"),
    mockConsoleLog: path.join(artifactDirPath, "mock-regression-console.log"),
    liveJson: path.join(artifactDirPath, "live-regression.json"),
    liveConsoleLog: path.join(artifactDirPath, "live-regression-console.log"),
    manifest: path.join(artifactDirPath, "execution-manifest.json")
  };

  assert(fs.existsSync(files.manifest), `guard-alert runtime artifact execution-manifest 누락: ${files.manifest}`);
  assertArtifactExists(
    files.mockJson,
    manifest.artifacts.mockJson,
    "guard-alert runtime artifact mock-regression.json"
  );
  assertArtifactExists(
    files.mockConsoleLog,
    manifest.artifacts.mockConsoleLog,
    "guard-alert runtime artifact mock-regression-console.log"
  );
  assertArtifactExists(
    files.liveJson,
    manifest.artifacts.liveJson,
    "guard-alert runtime artifact live-regression.json"
  );
  assertArtifactExists(
    files.liveConsoleLog,
    manifest.artifacts.liveConsoleLog,
    "guard-alert runtime artifact live-regression-console.log"
  );

  return {
    ok: true,
    workflow: "guard-alert-dispatch-regression",
    dir: artifactDirPath,
    files
  };
}

function checkGuardRetryBrowserRuntimeArtifacts(artifactDirPath, manifest) {
  assertPlainObject(manifest, "guard-retry-browser runtime manifest");
  assertDirectory(artifactDirPath, "guard-retry-browser runtime artifact");

  const files = {
    resultJson: path.join(artifactDirPath, "browser-e2e-result.json"),
    consoleLog: path.join(artifactDirPath, "browser-e2e-console.log"),
    stderrLog: path.join(artifactDirPath, "browser-e2e-stderr.log"),
    p3GuardSmokeJson: path.join(artifactDirPath, "p3-guard-smoke.json"),
    sampleReadinessJson: path.join(artifactDirPath, "guard-sample-readiness.json"),
    failClosedCountLockBundleJson: path.join(artifactDirPath, "p7-failclosed-countlock-bundle.json"),
    manifest: path.join(artifactDirPath, "execution-manifest.json")
  };

  assert(fs.existsSync(files.manifest), `guard-retry-browser runtime artifact execution-manifest 누락: ${files.manifest}`);
  assertArtifactExists(
    files.resultJson,
    manifest.artifacts.resultJson,
    "guard-retry-browser runtime artifact browser-e2e-result.json"
  );
  assertArtifactExists(
    files.consoleLog,
    manifest.artifacts.consoleLog,
    "guard-retry-browser runtime artifact browser-e2e-console.log"
  );
  assertArtifactExists(
    files.stderrLog,
    manifest.artifacts.stderrLog,
    "guard-retry-browser runtime artifact browser-e2e-stderr.log"
  );
  assertArtifactExists(
    files.p3GuardSmokeJson,
    manifest.artifacts.p3GuardSmokeJson,
    "guard-retry-browser runtime artifact p3-guard-smoke.json"
  );
  assertArtifactExists(
    files.sampleReadinessJson,
    manifest.artifacts.sampleReadinessJson,
    "guard-retry-browser runtime artifact guard-sample-readiness.json"
  );
  assertArtifactExists(
    files.failClosedCountLockBundleJson,
    manifest.artifacts.failClosedCountLockBundleJson,
    "guard-retry-browser runtime artifact p7-failclosed-countlock-bundle.json"
  );

  return {
    ok: true,
    workflow: "guard-retry-timeline-browser-e2e-regression",
    dir: artifactDirPath,
    files
  };
}

function checkRuntimeKeySourceConsistency(guardAlertRuntime, guardRetryBrowserRuntime) {
  if (!guardAlertRuntime || !guardRetryBrowserRuntime) {
    return null;
  }

  const guardAlertKeySource = guardAlertRuntime.keySource;
  const guardRetryBrowserKeySource = guardRetryBrowserRuntime.keySource;
  assert.equal(
    guardAlertKeySource,
    guardRetryBrowserKeySource,
    [
      "runtime execution-manifest 간 keySource 불일치",
      `(guard-alert=${guardAlertKeySource}, guard-retry-browser=${guardRetryBrowserKeySource})`
    ].join(" ")
  );

  return {
    ok: true,
    keySource: guardAlertKeySource
  };
}

function checkRuntimeRequiredKeySource(runtimeKeySourceConsistency, requiredKeySource) {
  if (!requiredKeySource) {
    return null;
  }

  assert(
    runtimeKeySourceConsistency && runtimeKeySourceConsistency.ok,
    "--require-runtime-key-source 옵션은 runtime manifest keySource 교차 일관성 검증이 먼저 통과해야 합니다."
  );

  assert.equal(
    runtimeKeySourceConsistency.keySource,
    requiredKeySource,
    [
      "--require-runtime-key-source 검증 실패",
      `(required=${requiredKeySource}, actual=${runtimeKeySourceConsistency.keySource})`
    ].join(" ")
  );

  return {
    ok: true,
    requiredKeySource,
    actualKeySource: runtimeKeySourceConsistency.keySource
  };
}

function checkRuntimeGeneratedAfter(
  guardAlertRuntime,
  guardRetryBrowserRuntime,
  requiredGeneratedAfterIso
) {
  if (!requiredGeneratedAfterIso) {
    return null;
  }

  assert(
    guardAlertRuntime && guardRetryBrowserRuntime,
    "--require-runtime-generated-after 옵션은 두 workflow runtime execution-manifest 검증이 먼저 통과해야 합니다."
  );

  const requiredGeneratedAfterMs = Date.parse(requiredGeneratedAfterIso);
  const guardAlertGeneratedAtUtc = guardAlertRuntime.manifest.generatedAtUtc;
  const guardRetryBrowserGeneratedAtUtc = guardRetryBrowserRuntime.manifest.generatedAtUtc;
  const guardAlertGeneratedAtMs = Date.parse(guardAlertGeneratedAtUtc);
  const guardRetryBrowserGeneratedAtMs = Date.parse(guardRetryBrowserGeneratedAtUtc);

  assert(
    guardAlertGeneratedAtMs >= requiredGeneratedAfterMs,
    [
      "--require-runtime-generated-after 검증 실패 (guard-alert)",
      `(required=${requiredGeneratedAfterIso}, actual=${guardAlertGeneratedAtUtc})`
    ].join(" ")
  );
  assert(
    guardRetryBrowserGeneratedAtMs >= requiredGeneratedAfterMs,
    [
      "--require-runtime-generated-after 검증 실패 (guard-retry-browser)",
      `(required=${requiredGeneratedAfterIso}, actual=${guardRetryBrowserGeneratedAtUtc})`
    ].join(" ")
  );

  return {
    ok: true,
    requiredGeneratedAfter: requiredGeneratedAfterIso,
    actualGeneratedAtUtc: {
      guardAlert: guardAlertGeneratedAtUtc,
      guardRetryBrowser: guardRetryBrowserGeneratedAtUtc
    }
  };
}

function checkRuntimeGeneratedBefore(
  guardAlertRuntime,
  guardRetryBrowserRuntime,
  requiredGeneratedBeforeIso
) {
  if (!requiredGeneratedBeforeIso) {
    return null;
  }

  assert(
    guardAlertRuntime && guardRetryBrowserRuntime,
    "--require-runtime-generated-before 옵션은 두 workflow runtime execution-manifest 검증이 먼저 통과해야 합니다."
  );

  const requiredGeneratedBeforeMs = Date.parse(requiredGeneratedBeforeIso);
  const guardAlertGeneratedAtUtc = guardAlertRuntime.manifest.generatedAtUtc;
  const guardRetryBrowserGeneratedAtUtc = guardRetryBrowserRuntime.manifest.generatedAtUtc;
  const guardAlertGeneratedAtMs = Date.parse(guardAlertGeneratedAtUtc);
  const guardRetryBrowserGeneratedAtMs = Date.parse(guardRetryBrowserGeneratedAtUtc);

  assert(
    guardAlertGeneratedAtMs <= requiredGeneratedBeforeMs,
    [
      "--require-runtime-generated-before 검증 실패 (guard-alert)",
      `(required=${requiredGeneratedBeforeIso}, actual=${guardAlertGeneratedAtUtc})`
    ].join(" ")
  );
  assert(
    guardRetryBrowserGeneratedAtMs <= requiredGeneratedBeforeMs,
    [
      "--require-runtime-generated-before 검증 실패 (guard-retry-browser)",
      `(required=${requiredGeneratedBeforeIso}, actual=${guardRetryBrowserGeneratedAtUtc})`
    ].join(" ")
  );

  return {
    ok: true,
    requiredGeneratedBefore: requiredGeneratedBeforeIso,
    actualGeneratedAtUtc: {
      guardAlert: guardAlertGeneratedAtUtc,
      guardRetryBrowser: guardRetryBrowserGeneratedAtUtc
    }
  };
}

function resolveRuntimeGeneratedMaxSkewPolicy(
  guardAlertRuntime,
  guardRetryBrowserRuntime,
  requireRuntimeContract,
  explicitRequireRuntimeGeneratedMaxSkewSeconds
) {
  if (
    explicitRequireRuntimeGeneratedMaxSkewSeconds !== null &&
    explicitRequireRuntimeGeneratedMaxSkewSeconds !== undefined
  ) {
    return {
      requiredMaxSkewSeconds: explicitRequireRuntimeGeneratedMaxSkewSeconds,
      source: "explicit"
    };
  }

  if (requireRuntimeContract && guardAlertRuntime && guardRetryBrowserRuntime) {
    return {
      requiredMaxSkewSeconds: DEFAULT_RUNTIME_GENERATED_MAX_SKEW_SECONDS,
      source: "default_when_require_runtime_contract"
    };
  }

  return {
    requiredMaxSkewSeconds: null,
    source: "not_applied"
  };
}

function checkRuntimeGeneratedMaxSkew(
  guardAlertRuntime,
  guardRetryBrowserRuntime,
  requiredMaxSkewSeconds
) {
  if (requiredMaxSkewSeconds === null || requiredMaxSkewSeconds === undefined) {
    return null;
  }

  assert(
    guardAlertRuntime && guardRetryBrowserRuntime,
    "--require-runtime-generated-max-skew-seconds 옵션은 두 workflow runtime execution-manifest 검증이 먼저 통과해야 합니다."
  );

  const guardAlertGeneratedAtUtc = guardAlertRuntime.manifest.generatedAtUtc;
  const guardRetryBrowserGeneratedAtUtc = guardRetryBrowserRuntime.manifest.generatedAtUtc;
  const guardAlertGeneratedAtMs = Date.parse(guardAlertGeneratedAtUtc);
  const guardRetryBrowserGeneratedAtMs = Date.parse(guardRetryBrowserGeneratedAtUtc);
  const actualSkewMs = Math.abs(guardAlertGeneratedAtMs - guardRetryBrowserGeneratedAtMs);
  const actualSkewSeconds = Number((actualSkewMs / 1000).toFixed(3));

  assert(
    actualSkewSeconds <= requiredMaxSkewSeconds,
    [
      "--require-runtime-generated-max-skew-seconds 검증 실패",
      `(required<=${requiredMaxSkewSeconds}s, actual=${actualSkewSeconds}s,`,
      `guard-alert=${guardAlertGeneratedAtUtc}, guard-retry-browser=${guardRetryBrowserGeneratedAtUtc})`
    ].join(" ")
  );

  return {
    ok: true,
    requiredMaxSkewSeconds,
    actualSkewSeconds,
    actualGeneratedAtUtc: {
      guardAlert: guardAlertGeneratedAtUtc,
      guardRetryBrowser: guardRetryBrowserGeneratedAtUtc
    }
  };
}

function checkRuntimeRequiredRunStatus(
  guardAlertRuntime,
  guardRetryBrowserRuntime,
  requiredGuardAlertMockRun,
  requiredGuardAlertLiveRun,
  requiredGuardRetryBrowserRun
) {
  const hasRequirement =
    Boolean(requiredGuardAlertMockRun) ||
    Boolean(requiredGuardAlertLiveRun) ||
    Boolean(requiredGuardRetryBrowserRun);
  if (!hasRequirement) {
    return null;
  }

  if (requiredGuardAlertMockRun || requiredGuardAlertLiveRun) {
    assert(
      guardAlertRuntime && guardAlertRuntime.manifest && guardAlertRuntime.manifest.runs,
      "--require-guard-alert-*-run 옵션은 guard-alert runtime execution-manifest 검증이 먼저 통과해야 합니다."
    );
  }
  if (requiredGuardRetryBrowserRun) {
    assert(
      guardRetryBrowserRuntime && guardRetryBrowserRuntime.manifest,
      "--require-guard-retry-browser-run 옵션은 guard-retry-browser runtime execution-manifest 검증이 먼저 통과해야 합니다."
    );
  }

  if (requiredGuardAlertMockRun) {
    const actualMockRun = guardAlertRuntime.manifest.runs.mock;
    assert.equal(
      actualMockRun,
      requiredGuardAlertMockRun,
      [
        "--require-guard-alert-mock-run 검증 실패",
        `(required=${requiredGuardAlertMockRun}, actual=${actualMockRun})`
      ].join(" ")
    );
  }

  if (requiredGuardAlertLiveRun) {
    const actualLiveRun = guardAlertRuntime.manifest.runs.live;
    assert.equal(
      actualLiveRun,
      requiredGuardAlertLiveRun,
      [
        "--require-guard-alert-live-run 검증 실패",
        `(required=${requiredGuardAlertLiveRun}, actual=${actualLiveRun})`
      ].join(" ")
    );
  }

  if (requiredGuardRetryBrowserRun) {
    const actualGuardRetryBrowserRun = guardRetryBrowserRuntime.manifest.run;
    assert.equal(
      actualGuardRetryBrowserRun,
      requiredGuardRetryBrowserRun,
      [
        "--require-guard-retry-browser-run 검증 실패",
        `(required=${requiredGuardRetryBrowserRun}, actual=${actualGuardRetryBrowserRun})`
      ].join(" ")
    );
  }

  return {
    ok: true,
    required: {
      guardAlertMockRun: requiredGuardAlertMockRun || null,
      guardAlertLiveRun: requiredGuardAlertLiveRun || null,
      guardRetryBrowserRun: requiredGuardRetryBrowserRun || null
    },
    actual: {
      guardAlertMockRun: guardAlertRuntime?.manifest?.runs?.mock ?? null,
      guardAlertLiveRun: guardAlertRuntime?.manifest?.runs?.live ?? null,
      guardRetryBrowserRun: guardRetryBrowserRuntime?.manifest?.run ?? null
    }
  };
}

function run() {
  const args = parseArgs(process.argv);
  const sharedRuntimeArtifactRoot = args.runtimeArtifactRoot || "";
  const guardAlertArtifactDir = args.guardAlertArtifactDir || sharedRuntimeArtifactRoot;
  const guardRetryBrowserArtifactDir = args.guardRetryBrowserArtifactDir || sharedRuntimeArtifactRoot;

  const guardAlertArtifactContext = guardAlertArtifactDir
    ? resolveRuntimeArtifactContext(
        guardAlertArtifactDir,
        args.guardAlertManifestPath || "",
        "guard-alert-dispatch-regression",
        "guard-alert"
      )
    : null;
  const guardRetryBrowserArtifactContext = guardRetryBrowserArtifactDir
    ? resolveRuntimeArtifactContext(
        guardRetryBrowserArtifactDir,
        args.guardRetryBrowserManifestPath || "",
        "guard-retry-timeline-browser-e2e-regression",
        "guard-retry-browser"
      )
    : null;

  const guardAlertManifestPath =
    args.guardAlertManifestPath ||
    (guardAlertArtifactContext ? guardAlertArtifactContext.manifestPath : "");
  const guardRetryBrowserManifestPath =
    args.guardRetryBrowserManifestPath ||
    (guardRetryBrowserArtifactContext ? guardRetryBrowserArtifactContext.manifestPath : "");

  const guardAlert = checkGuardAlertWorkflow(sourcePaths.guardAlertWorkflow);
  const guardRetryBrowser = checkGuardRetryBrowserWorkflow(sourcePaths.guardRetryBrowserWorkflow);
  const guardAlertRuntime = guardAlertManifestPath
    ? checkGuardAlertRuntimeManifest(guardAlertManifestPath)
    : null;
  const guardRetryBrowserRuntime = guardRetryBrowserManifestPath
    ? checkGuardRetryBrowserRuntimeManifest(guardRetryBrowserManifestPath)
    : null;
  const guardAlertRuntimeArtifact = guardAlertArtifactContext
    ? checkGuardAlertRuntimeArtifacts(guardAlertArtifactContext.artifactDirPath, guardAlertRuntime?.manifest)
    : null;
  const guardRetryBrowserRuntimeArtifact = guardRetryBrowserArtifactContext
    ? checkGuardRetryBrowserRuntimeArtifacts(
        guardRetryBrowserArtifactContext.artifactDirPath,
        guardRetryBrowserRuntime?.manifest
      )
    : null;
  const runtimeKeySourceConsistency = checkRuntimeKeySourceConsistency(
    guardAlertRuntime,
    guardRetryBrowserRuntime
  );
  const runtimeRequiredKeySource = checkRuntimeRequiredKeySource(
    runtimeKeySourceConsistency,
    args.requireRuntimeKeySource
  );
  const runtimeGeneratedAfter = checkRuntimeGeneratedAfter(
    guardAlertRuntime,
    guardRetryBrowserRuntime,
    args.requireRuntimeGeneratedAfter
  );
  const runtimeGeneratedBefore = checkRuntimeGeneratedBefore(
    guardAlertRuntime,
    guardRetryBrowserRuntime,
    args.requireRuntimeGeneratedBefore
  );
  const runtimeGeneratedMaxSkewPolicy = resolveRuntimeGeneratedMaxSkewPolicy(
    guardAlertRuntime,
    guardRetryBrowserRuntime,
    args.requireRuntimeContract,
    args.requireRuntimeGeneratedMaxSkewSeconds
  );
  const runtimeGeneratedMaxSkew = checkRuntimeGeneratedMaxSkew(
    guardAlertRuntime,
    guardRetryBrowserRuntime,
    runtimeGeneratedMaxSkewPolicy.requiredMaxSkewSeconds
  );
  const runtimeRequiredRunStatus = checkRuntimeRequiredRunStatus(
    guardAlertRuntime,
    guardRetryBrowserRuntime,
    args.requireGuardAlertMockRun,
    args.requireGuardAlertLiveRun,
    args.requireGuardRetryBrowserRun
  );

  const checks = {
    guardAlertArtifactAndLogs: guardAlert.ok,
    guardAlertManifestContract: guardAlert.ok,
    guardAlertNoDirectKeyInjection: guardAlert.noDirectGeminiKeyInjection,
    guardRetryBrowserArtifactAndLogs: guardRetryBrowser.ok,
    guardRetryBrowserManifestContract: guardRetryBrowser.ok,
    guardRetryBrowserNoDirectKeyInjection: guardRetryBrowser.noDirectGeminiKeyInjection,
    guardAlertRuntimeManifestContract: guardAlertRuntime ? guardAlertRuntime.ok : null,
    guardRetryBrowserRuntimeManifestContract: guardRetryBrowserRuntime ? guardRetryBrowserRuntime.ok : null,
    guardAlertRuntimeArtifactContract: guardAlertRuntimeArtifact ? guardAlertRuntimeArtifact.ok : null,
    guardRetryBrowserRuntimeArtifactContract: guardRetryBrowserRuntimeArtifact ? guardRetryBrowserRuntimeArtifact.ok : null,
    runtimeKeySourceConsistency: runtimeKeySourceConsistency ? runtimeKeySourceConsistency.ok : null,
    runtimeRequiredKeySource: runtimeRequiredKeySource ? runtimeRequiredKeySource.ok : null,
    runtimeGeneratedAfter: runtimeGeneratedAfter ? runtimeGeneratedAfter.ok : null,
    runtimeGeneratedBefore: runtimeGeneratedBefore ? runtimeGeneratedBefore.ok : null,
    runtimeGeneratedMaxSkew: runtimeGeneratedMaxSkew ? runtimeGeneratedMaxSkew.ok : null,
    runtimeRequiredRunStatus: runtimeRequiredRunStatus ? runtimeRequiredRunStatus.ok : null
  };
  const runtimeContractChecks = [
    "guardAlertRuntimeManifestContract",
    "guardRetryBrowserRuntimeManifestContract",
    "guardAlertRuntimeArtifactContract",
    "guardRetryBrowserRuntimeArtifactContract",
    "runtimeKeySourceConsistency"
  ];
  const runtimeContractSatisfied = runtimeContractChecks.every((checkKey) => checks[checkKey] === true);
  const runtimeContractMissingChecks = runtimeContractChecks.filter((checkKey) => checks[checkKey] !== true);
  if (args.requireRuntimeContract) {
    assert(
      runtimeContractSatisfied,
      [
        "--require-runtime-contract 옵션은 runtime manifest/artifact 계약 5종이 모두 true 여야 합니다.",
        `현재값: ${runtimeContractChecks.map((checkKey) => `${checkKey}=${String(checks[checkKey])}`).join(", ")}`,
        `미충족: ${runtimeContractMissingChecks.join(", ")}`,
        "힌트: --runtime-artifact-root 또는 workflow별 artifact dir 인자를 전달해 execution-manifest.json 기반 검증을 활성화하세요."
      ].join(" ")
    );
  }
  const checkValues = Object.values(checks).filter((value) => typeof value === "boolean");
  const evidenceFiles = Array.from(
    new Set([
      guardAlert.file,
      guardRetryBrowser.file,
      ...(guardAlertRuntime ? [guardAlertRuntime.file] : []),
      ...(guardRetryBrowserRuntime ? [guardRetryBrowserRuntime.file] : []),
      ...(guardAlertRuntimeArtifact
        ? Object.values(guardAlertRuntimeArtifact.files).filter((filePath) => fs.existsSync(filePath))
        : []),
      ...(guardRetryBrowserRuntimeArtifact
        ? Object.values(guardRetryBrowserRuntimeArtifact.files).filter((filePath) => fs.existsSync(filePath))
        : [])
    ])
  );

  const report = {
    ok: checkValues.every((value) => value),
    stage: "P6",
    generatedAtUtc: new Date().toISOString(),
    keySourcePolicy: KEY_SOURCE_POLICY,
    runtimeContractRequired: args.requireRuntimeContract,
    runtimeContractSatisfied,
    runtimeContractMissingChecks,
    runtimeKeySources: runtimeKeySourceConsistency
      ? {
          guardAlert: guardAlertRuntime.keySource,
          guardRetryBrowser: guardRetryBrowserRuntime.keySource
        }
      : null,
    runtimeRequiredKeySource: args.requireRuntimeKeySource || null,
    runtimeGeneratedAfter: args.requireRuntimeGeneratedAfter || null,
    runtimeGeneratedBefore: args.requireRuntimeGeneratedBefore || null,
    runtimeGeneratedMaxSkewSeconds: runtimeGeneratedMaxSkewPolicy.requiredMaxSkewSeconds,
    runtimeGeneratedMaxSkewSource: runtimeGeneratedMaxSkewPolicy.source,
    runtimeGeneratedMaxSkewDefaultSeconds: DEFAULT_RUNTIME_GENERATED_MAX_SKEW_SECONDS,
    runtimeGeneratedSkewSeconds: runtimeGeneratedMaxSkew ? runtimeGeneratedMaxSkew.actualSkewSeconds : null,
    runtimeGeneratedAtUtc:
      runtimeGeneratedAfter?.actualGeneratedAtUtc ||
      runtimeGeneratedBefore?.actualGeneratedAtUtc ||
      runtimeGeneratedMaxSkew?.actualGeneratedAtUtc ||
      null,
    runtimeRequiredRunStatus: runtimeRequiredRunStatus ? runtimeRequiredRunStatus.required : null,
    runtimeActualRunStatus: runtimeRequiredRunStatus ? runtimeRequiredRunStatus.actual : null,
    runtimeArtifactInput: {
      runtimeArtifactRoot: sharedRuntimeArtifactRoot || null,
      guardAlertArtifactDir: guardAlertArtifactDir || null,
      guardRetryBrowserArtifactDir: guardRetryBrowserArtifactDir || null
    },
    checks,
    evidenceFiles
  };

  if (args.writePath) {
    fs.mkdirSync(path.dirname(args.writePath), { recursive: true });
    fs.writeFileSync(args.writePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report, null, 2));
}

run();
