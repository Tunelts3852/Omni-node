#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const repoRoot = path.resolve(__dirname, "..");
const middlewareProjectPath = path.resolve(repoRoot, "omninode-middleware", "OmniNode.Middleware.csproj");
const runtimeRoot = path.resolve(repoRoot, ".runtime", "loop43-guard-retry-timeline-browser-e2e");
const wsPort = Number.parseInt(process.env.OMNINODE_E2E_WS_PORT || "18883", 10);
const guardRetryTimelineStatePath = path.join(runtimeRoot, "guard_retry_timeline.json");
const guardRetryTimelineSchemaVersion = "guard_retry_timeline.v1";
const guardRetryTimelineDefaultMaxEntries = 512;
const expectedChannels = ["chat", "coding", "telegram"];
const seedEntryPrefix = "seed-";

const retryTimelineQuery = new URLSearchParams({
  bucketMinutes: "5",
  windowMinutes: "60",
  maxBucketRows: "12",
  channels: "chat,coding,telegram"
}).toString();

function ensureRuntimeLayout() {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "memory-notes"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "code-runs"), { recursive: true });
}

function buildSeedEntries(now) {
  return [
    {
      id: "seed-chat-1",
      capturedAt: new Date(now - 2 * 60 * 1000).toISOString(),
      channel: "chat",
      retryRequired: true,
      retryAttempt: 2,
      retryMaxAttempts: 3,
      retryStopReason: "citation_validation_failed"
    },
    {
      id: "seed-chat-2",
      capturedAt: new Date(now - 4 * 60 * 1000).toISOString(),
      channel: "chat",
      retryRequired: true,
      retryAttempt: 1,
      retryMaxAttempts: 3,
      retryStopReason: "citation_validation_failed"
    },
    {
      id: "seed-coding-1",
      capturedAt: new Date(now - 3 * 60 * 1000).toISOString(),
      channel: "coding",
      retryRequired: true,
      retryAttempt: 1,
      retryMaxAttempts: 2,
      retryStopReason: "count_lock_unsatisfied"
    },
    {
      id: "seed-telegram-1",
      capturedAt: new Date(now - 5 * 60 * 1000).toISOString(),
      channel: "telegram",
      retryRequired: false,
      retryAttempt: 0,
      retryMaxAttempts: 2,
      retryStopReason: "-"
    }
  ];
}

function isSeedEntry(entry) {
  const id = `${entry && entry.id ? entry.id : ""}`.trim().toLowerCase();
  return id.startsWith(seedEntryPrefix);
}

function loadExistingGuardRetryTimelineState() {
  if (!fs.existsSync(guardRetryTimelineStatePath)) {
    return {
      maxEntries: guardRetryTimelineDefaultMaxEntries,
      entries: []
    };
  }

  try {
    const raw = fs.readFileSync(guardRetryTimelineStatePath, "utf8");
    const parsed = JSON.parse(raw);
    const parsedMaxEntries = Number(parsed && parsed.maxEntries);
    const maxEntries = Number.isFinite(parsedMaxEntries)
      ? Math.max(64, Math.min(4096, Math.floor(parsedMaxEntries)))
      : guardRetryTimelineDefaultMaxEntries;
    const entries = Array.isArray(parsed && parsed.entries)
      ? parsed.entries.filter((entry) => entry && typeof entry === "object")
      : [];
    return {
      maxEntries,
      entries
    };
  } catch (error) {
    console.error(`[guard-retry-seed] 기존 상태 로딩 실패: ${error.message}`);
    return {
      maxEntries: guardRetryTimelineDefaultMaxEntries,
      entries: []
    };
  }
}

function seedGuardRetryTimelineState() {
  const now = Date.now();
  const existingState = loadExistingGuardRetryTimelineState();
  const seedEntries = buildSeedEntries(now);
  const preservedNonSeedEntries = existingState.entries.filter((entry) => !isSeedEntry(entry));
  const mergedEntries = [...seedEntries, ...preservedNonSeedEntries].slice(0, existingState.maxEntries);
  const payload = {
    schemaVersion: guardRetryTimelineSchemaVersion,
    savedAtUtc: new Date(now).toISOString(),
    maxEntries: existingState.maxEntries,
    entries: mergedEntries
  };

  fs.writeFileSync(guardRetryTimelineStatePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    payload,
    seedEntriesCount: seedEntries.length,
    preservedNonSeedEntries: preservedNonSeedEntries.length,
    droppedNonSeedEntries: Math.max(0, seedEntries.length + preservedNonSeedEntries.length - mergedEntries.length)
  };
}

function buildMiddlewareEnv() {
  return {
    ...process.env,
    OMNINODE_WS_PORT: `${wsPort}`,
    OMNINODE_GATEWAY_STARTUP_PROBE: "0",
    OMNINODE_ENABLE_HEALTH_ENDPOINT: "1",
    OMNINODE_ENABLE_LOCAL_OTP_FALLBACK: "1",
    OMNINODE_DASHBOARD_INDEX: path.resolve(repoRoot, "omninode-dashboard", "index.html"),
    OMNINODE_LLM_USAGE_STATE_PATH: path.join(runtimeRoot, "llm_usage.json"),
    OMNINODE_COPILOT_USAGE_STATE_PATH: path.join(runtimeRoot, "copilot_usage.json"),
    OMNINODE_CONVERSATION_STATE_PATH: path.join(runtimeRoot, "conversations.json"),
    OMNINODE_AUTH_SESSION_STATE_PATH: path.join(runtimeRoot, "auth_sessions.json"),
    OMNINODE_MEMORY_NOTES_DIR: path.join(runtimeRoot, "memory-notes"),
    OMNINODE_CODE_RUNS_DIR: path.join(runtimeRoot, "code-runs"),
    OMNINODE_AUDIT_LOG_PATH: path.join(runtimeRoot, "audit.log"),
    OMNINODE_GATEWAY_HEALTH_STATE_PATH: path.join(runtimeRoot, "gateway_health.json"),
    OMNINODE_GATEWAY_STARTUP_PROBE_STATE_PATH: path.join(runtimeRoot, "gateway_startup_probe.json"),
    OMNINODE_GUARD_RETRY_TIMELINE_STATE_PATH: guardRetryTimelineStatePath,
    OMNINODE_TELEGRAM_TOKEN_KEYCHAIN_SERVICE: "__none__",
    OMNINODE_TELEGRAM_CHAT_ID_KEYCHAIN_SERVICE: "__none__"
  };
}

function consumeLines(bufferState, chunk, sink) {
  bufferState.value += chunk;
  let idx = bufferState.value.indexOf("\n");
  while (idx >= 0) {
    const line = bufferState.value.slice(0, idx).replace(/\r$/, "");
    bufferState.value = bufferState.value.slice(idx + 1);
    if (line) {
      sink.push(line);
    }
    idx = bufferState.value.indexOf("\n");
  }
}

function startMiddleware() {
  const stdoutLines = [];
  const stderrLines = [];
  const proc = spawn(
    "dotnet",
    ["run", "--project", middlewareProjectPath, "--no-build"],
    {
      cwd: repoRoot,
      env: buildMiddlewareEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const stdoutBuffer = { value: "" };
  const stderrBuffer = { value: "" };

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => consumeLines(stdoutBuffer, chunk, stdoutLines));
  proc.stderr.on("data", (chunk) => consumeLines(stderrBuffer, chunk, stderrLines));

  return { proc, stdoutLines, stderrLines };
}

async function waitForCondition(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(message);
}

async function waitForServerReady(ctx) {
  const dashboardLine = await waitForCondition(
    () => ctx.stdoutLines.find((line) => line.includes("[web] dashboard=http://127.0.0.1:")),
    30000,
    "미들웨어 기동 로그를 찾지 못했습니다."
  );

  return dashboardLine;
}

function parseOtpFromLines(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const match = line.match(/\[otp\] local fallback otp=(\d{6}) session=([a-zA-Z0-9\-]+)/);
    if (match) {
      return {
        otp: match[1],
        sessionId: match[2]
      };
    }
  }

  return null;
}

async function stopMiddleware(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) {
    return;
  }

  proc.kill("SIGINT");
  const exitedBySigInt = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (exitedBySigInt) {
    return;
  }

  proc.kill("SIGTERM");
  const exitedBySigTerm = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exitedBySigTerm) {
    proc.kill("SIGKILL");
    await new Promise((resolve) => proc.once("exit", () => resolve()));
  }
}

async function fetchStatus(url) {
  const res = await fetch(url, { method: "GET" });
  return res.status;
}

async function waitForHttpStatus(url, expected, timeoutMs) {
  const start = Date.now();
  let lastStatus = null;

  while (Date.now() - start < timeoutMs) {
    try {
      lastStatus = await fetchStatus(url);
      if (lastStatus === expected) {
        return lastStatus;
      }
    } catch {
      lastStatus = null;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`${url} 상태 코드가 ${expected}가 아닙니다: ${lastStatus ?? "no_response"}`);
}

async function fetchRetryTimelineSnapshot(baseUrl) {
  const response = await fetch(`${baseUrl}/api/guard/retry-timeline?${retryTimelineQuery}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  assert.equal(response.status, 200, "retry timeline API 응답 상태가 200이 아닙니다.");

  const payload = await response.json();
  assert.equal(payload.schemaVersion, "guard_retry_timeline.v1", "retry timeline schemaVersion이 다릅니다.");
  assert.equal(payload.bucketMinutes, 5, "retry timeline bucketMinutes가 다릅니다.");
  assert.equal(payload.windowMinutes, 60, "retry timeline windowMinutes가 다릅니다.");
  assert.ok(Array.isArray(payload.channels), "retry timeline channels가 배열이 아닙니다.");
  const observedChannels = payload.channels.map((item) => item && item.channel).filter(Boolean).sort();
  assert.deepEqual(
    observedChannels,
    [...expectedChannels].sort(),
    `retry timeline API 채널 세트가 다릅니다: ${observedChannels.join(",")}`
  );

  const chatChannel = payload.channels.find((item) => item && item.channel === "chat");
  const codingChannel = payload.channels.find((item) => item && item.channel === "coding");
  const telegramChannel = payload.channels.find((item) => item && item.channel === "telegram");

  assert.ok(chatChannel, "retry timeline 채널(chat)이 없습니다.");
  assert.ok(codingChannel, "retry timeline 채널(coding)이 없습니다.");
  assert.ok(telegramChannel, "retry timeline 채널(telegram)이 없습니다.");

  assert.ok(chatChannel.totalSamples >= 2, "chat totalSamples가 시드 데이터보다 작습니다.");
  assert.ok(codingChannel.totalSamples >= 1, "coding totalSamples가 시드 데이터보다 작습니다.");
  assert.ok(telegramChannel.totalSamples >= 1, "telegram totalSamples가 시드 데이터보다 작습니다.");

  return payload;
}

async function authenticateWithOtp(page, stdoutLines) {
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "OTP 요청" }).click();

  const otpInfo = await waitForCondition(
    () => parseOtpFromLines(stdoutLines),
    15000,
    "fallback OTP 로그를 찾지 못했습니다."
  );

  await page.locator("input[placeholder='OTP 6자리']").fill(otpInfo.otp);
  await page.getByRole("button", { name: "OTP 인증" }).click();

  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll(".pill")).some((node) =>
      (node.textContent || "").includes("세션 인증됨")
    );
  }, null, { timeout: 15000 });

  return otpInfo;
}

async function waitForRetryTimelineServerApiHint(page) {
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll(".hint")).some((node) => {
      const text = (node.textContent || "").trim();
      return text.includes("retry 시계열 source=server_api");
    });
  }, null, { timeout: 30000 });
}

async function readRetryTimelineUiSnapshot(page) {
  return page.evaluate(() => {
    const retryTable = Array.from(document.querySelectorAll("table")).find((table) => {
      const caption = table.querySelector("caption");
      return caption && (caption.textContent || "").includes("retry 시계열");
    });

    const rows = retryTable
      ? Array.from(retryTable.querySelectorAll("tbody tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").trim())
      )
      : [];

    const sourceHint = Array.from(document.querySelectorAll(".hint"))
      .map((node) => (node.textContent || "").trim())
      .find((text) => text.includes("retry 시계열 source=")) || "";

    return {
      sourceHint,
      rows
    };
  });
}

async function run() {
  ensureRuntimeLayout();
  const seedState = seedGuardRetryTimelineState();
  const middleware = startMiddleware();
  let browser;

  try {
    await waitForServerReady(middleware);

    const baseUrl = `http://127.0.0.1:${wsPort}`;
    const healthz = await waitForHttpStatus(`${baseUrl}/healthz`, 200, 15000);
    assert.equal(healthz, 200, `/healthz 상태 코드가 200이 아닙니다: ${healthz}`);

    const apiSnapshot = await fetchRetryTimelineSnapshot(baseUrl);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();

    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    const otpInfo = await authenticateWithOtp(page, middleware.stdoutLines);
    await page.getByRole("button", { name: "설정", exact: true }).click();

    await waitForRetryTimelineServerApiHint(page);
    const uiSnapshot = await readRetryTimelineUiSnapshot(page);

    assert.ok(
      uiSnapshot.sourceHint.includes("retry 시계열 source=server_api"),
      `retry 시계열 source 표시가 server_api가 아닙니다: ${uiSnapshot.sourceHint || "empty"}`
    );
    assert.ok(
      !uiSnapshot.sourceHint.includes("fallbackReason="),
      `server_api 성공 경로인데 fallbackReason이 노출되었습니다: ${uiSnapshot.sourceHint}`
    );

    const chatRow = uiSnapshot.rows.find((cells) => cells[0] === "chat");
    const codingRow = uiSnapshot.rows.find((cells) => cells[0] === "coding");
    const telegramRow = uiSnapshot.rows.find((cells) => cells[0] === "telegram");
    assert.ok(chatRow, "retry 시계열 UI에서 chat 행을 찾지 못했습니다.");
    assert.ok(codingRow, "retry 시계열 UI에서 coding 행을 찾지 못했습니다.");
    assert.ok(telegramRow, "retry 시계열 UI에서 telegram 행을 찾지 못했습니다.");
    const observedUiChannels = uiSnapshot.rows.map((cells) => cells[0]).filter(Boolean);
    const unexpectedUiChannels = Array.from(
      new Set(observedUiChannels.filter((channel) => !expectedChannels.includes(channel)))
    );
    assert.equal(
      unexpectedUiChannels.length,
      0,
      `retry 시계열 UI에 운영 범위 외 채널이 포함되었습니다: ${unexpectedUiChannels.join(",")}`
    );

    const observedTopReasons = uiSnapshot.rows.map((cells) => cells[6]).filter(Boolean);
    assert.ok(
      observedTopReasons.length >= expectedChannels.length,
      `retry 시계열 UI top retryStopReason 행 수가 채널 수보다 작습니다: ${observedTopReasons.join(",")}`
    );

    const result = {
      ok: true,
      wsPort,
      runtimeRoot,
      guardRetryTimelineStatePath,
      otpSessionId: otpInfo.sessionId,
      apiSchemaVersion: apiSnapshot.schemaVersion,
      apiChannelTotals: (apiSnapshot.channels || []).map((item) => ({
        channel: item.channel,
        totalSamples: item.totalSamples,
        retryRequiredSamples: item.retryRequiredSamples
      })),
      uiSourceHint: uiSnapshot.sourceHint,
      uiRowCount: uiSnapshot.rows.length,
      seedEntries: seedState.seedEntriesCount,
      preservedNonSeedEntries: seedState.preservedNonSeedEntries,
      droppedNonSeedEntries: seedState.droppedNonSeedEntries
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (browser) {
      await browser.close();
    }
    await stopMiddleware(middleware.proc);
  }
}

run().catch((error) => {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : `${error}`
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
