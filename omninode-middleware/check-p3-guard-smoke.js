#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_WS_PORT = "auto";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 5;
const READY_LOG_MARKER = "[web] dashboard=";

function printUsage() {
  console.error(
    "Usage: node omninode-middleware/check-p3-guard-smoke.js " +
      "[--project <csproj>] [--runtime-dir <path>] [--ws-port <port|auto>] " +
      "[--timeout-ms <ms>] [--attempts <n>] " +
      "[--guard-retry-timeline-state-path <path>] " +
      "[--skip-build] [--write <path>]"
  );
}

function toTrimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv) {
  const middlewareDir = path.resolve(__dirname);
  const args = {
    project: path.resolve(middlewareDir, "OmniNode.Middleware.csproj"),
    runtimeDir: path.resolve("/tmp", `omninode-p3-guard-smoke-${Date.now()}`),
    wsPort: DEFAULT_WS_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    attempts: DEFAULT_ATTEMPTS,
    guardRetryTimelineStatePath: "",
    skipBuild: false,
    writePath: ""
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--project" && i + 1 < argv.length) {
      args.project = path.resolve(argv[++i]);
      continue;
    }
    if (token === "--runtime-dir" && i + 1 < argv.length) {
      args.runtimeDir = path.resolve(argv[++i]);
      continue;
    }
    if (token === "--ws-port" && i + 1 < argv.length) {
      args.wsPort = toTrimmed(argv[++i]) || DEFAULT_WS_PORT;
      continue;
    }
    if (token === "--timeout-ms" && i + 1 < argv.length) {
      args.timeoutMs = parsePositiveInt(argv[++i], args.timeoutMs);
      continue;
    }
    if (token === "--attempts" && i + 1 < argv.length) {
      args.attempts = parsePositiveInt(argv[++i], args.attempts);
      continue;
    }
    if (token === "--guard-retry-timeline-state-path" && i + 1 < argv.length) {
      args.guardRetryTimelineStatePath = path.resolve(argv[++i]);
      continue;
    }
    if (token === "--skip-build") {
      args.skipBuild = true;
      continue;
    }
    if (token === "--write" && i + 1 < argv.length) {
      args.writePath = path.resolve(argv[++i]);
      continue;
    }
    if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`unknown option: ${token}`);
  }

  return args;
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("failed to resolve free port")));
        return;
      }
      const port = String(addr.port);
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function resolvePort(rawPort) {
  const value = toTrimmed(rawPort).toLowerCase();
  if (!value || value === "auto") {
    return allocatePort();
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid ws port: ${rawPort}`);
  }

  return String(parsed);
}

function runBuild(projectPath) {
  const projectDir = path.dirname(projectPath);
  const result = spawnSync("dotnet", ["build", projectPath], {
    cwd: projectDir,
    stdio: "pipe",
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      [
        "dotnet build failed",
        result.stdout || "",
        result.stderr || ""
      ].join("\n")
    );
  }

  return {
    command: `dotnet build ${projectPath}`,
    stdoutTail: tailText(result.stdout, 20)
  };
}

function tailText(raw, maxLines) {
  const lines = String(raw || "")
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length <= maxLines) {
    return lines.join("\n");
  }
  return lines.slice(lines.length - maxLines).join("\n");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function createRuntimePaths(runtimeDir) {
  ensureDir(runtimeDir);
  const paths = {
    runtimeDir,
    authSession: path.join(runtimeDir, "auth_sessions.json"),
    llmUsage: path.join(runtimeDir, "llm_usage.json"),
    copilotUsage: path.join(runtimeDir, "copilot_usage.json"),
    conversation: path.join(runtimeDir, "conversations.json"),
    memoryNotes: path.join(runtimeDir, "memory_notes"),
    codeRuns: path.join(runtimeDir, "code_runs"),
    auditLog: path.join(runtimeDir, "audit.log"),
    healthState: path.join(runtimeDir, "gateway_health.json"),
    probeState: path.join(runtimeDir, "gateway_startup_probe.json")
  };
  ensureDir(paths.memoryNotes);
  ensureDir(paths.codeRuns);
  return paths;
}

function buildMiddlewareEnv(baseEnv, wsPort, runtimePaths, guardRetryTimelineStatePath) {
  const env = {
    ...baseEnv,
    OMNINODE_WS_PORT: wsPort,
    OMNINODE_GATEWAY_STARTUP_PROBE: "0",
    OMNINODE_ENABLE_HEALTH_ENDPOINT: "1",
    OMNINODE_ENABLE_LOCAL_OTP_FALLBACK: "1",
    OMNINODE_AUTH_SESSION_STATE_PATH: runtimePaths.authSession,
    OMNINODE_LLM_USAGE_STATE_PATH: runtimePaths.llmUsage,
    OMNINODE_COPILOT_USAGE_STATE_PATH: runtimePaths.copilotUsage,
    OMNINODE_CONVERSATION_STATE_PATH: runtimePaths.conversation,
    OMNINODE_MEMORY_NOTES_DIR: runtimePaths.memoryNotes,
    OMNINODE_CODE_RUNS_DIR: runtimePaths.codeRuns,
    OMNINODE_AUDIT_LOG_PATH: runtimePaths.auditLog,
    OMNINODE_GATEWAY_HEALTH_STATE_PATH: runtimePaths.healthState,
    OMNINODE_GATEWAY_STARTUP_PROBE_STATE_PATH: runtimePaths.probeState,
    OMNINODE_TELEGRAM_TOKEN_KEYCHAIN_SERVICE: "omninode_missing_telegram_token_for_guard_smoke",
    OMNINODE_TELEGRAM_CHAT_ID_KEYCHAIN_SERVICE: "omninode_missing_telegram_chat_for_guard_smoke",
    OMNINODE_TELEGRAM_BOT_TOKEN_FILE: path.join(runtimePaths.runtimeDir, "missing_telegram_bot_token"),
    OMNINODE_TELEGRAM_CHAT_ID_FILE: path.join(runtimePaths.runtimeDir, "missing_telegram_chat_id")
  };

  const resolvedGuardRetryTimelineStatePath = resolveGuardRetryTimelineStatePath(
    guardRetryTimelineStatePath || baseEnv.OMNINODE_GUARD_RETRY_TIMELINE_STATE_PATH
  );
  if (resolvedGuardRetryTimelineStatePath) {
    env.OMNINODE_GUARD_RETRY_TIMELINE_STATE_PATH = resolvedGuardRetryTimelineStatePath;
  }

  return env;
}

function resolveGuardRetryTimelineStatePath(inputPath) {
  const candidate = toTrimmed(inputPath);
  if (!candidate) {
    return "";
  }
  return path.resolve(candidate);
}

function isSeedEntryId(id) {
  return toTrimmed(id).toLowerCase().startsWith("seed-");
}

function summarizeGuardRetryTimelineState(statePath) {
  const byChannel = { chat: 0, coding: 0, telegram: 0 };
  const summary = {
    path: statePath,
    exists: false,
    totalEntries: 0,
    nonSeedEntries: 0,
    seedEntries: 0,
    byChannel
  };

  if (!statePath || !fs.existsSync(statePath)) {
    return summary;
  }

  summary.exists = true;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return summary;
  }

  const entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
  summary.totalEntries = entries.length;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    if (isSeedEntryId(entry.id)) {
      summary.seedEntries += 1;
      continue;
    }

    const channel = toTrimmed(entry.channel).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(byChannel, channel)) {
      byChannel[channel] += 1;
      summary.nonSeedEntries += 1;
    }
  }

  return summary;
}

function spawnMiddleware(projectPath, env) {
  const projectDir = path.dirname(projectPath);
  const child = spawn("dotnet", ["run", "--no-build", "--project", projectPath], {
    cwd: projectDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const state = {
    stdoutLines: [],
    stderrLines: [],
    ready: false,
    exited: false,
    exitCode: null,
    exitSignal: null,
    otpBySession: new Map()
  };

  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let lineBreakIndex = stdoutBuffer.indexOf("\n");
    while (lineBreakIndex >= 0) {
      const line = stdoutBuffer.slice(0, lineBreakIndex).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(lineBreakIndex + 1);
      onStdoutLine(line, state);
      lineBreakIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    let lineBreakIndex = stderrBuffer.indexOf("\n");
    while (lineBreakIndex >= 0) {
      const line = stderrBuffer.slice(0, lineBreakIndex).replace(/\r$/, "");
      stderrBuffer = stderrBuffer.slice(lineBreakIndex + 1);
      onStderrLine(line, state);
      lineBreakIndex = stderrBuffer.indexOf("\n");
    }
  });

  child.on("exit", (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
  });

  return { child, state };
}

function onStdoutLine(line, state) {
  const trimmed = line.trimEnd();
  if (trimmed.length === 0) {
    return;
  }
  state.stdoutLines.push(trimmed);
  if (trimmed.includes(READY_LOG_MARKER)) {
    state.ready = true;
  }

  const otpMatch = trimmed.match(/\[otp\]\s+local fallback otp=(\S+)\s+session=(\S+)/i);
  if (otpMatch) {
    state.otpBySession.set(otpMatch[2], otpMatch[1]);
  }
}

function onStderrLine(line, state) {
  const trimmed = line.trimEnd();
  if (trimmed.length === 0) {
    return;
  }
  state.stderrLines.push(trimmed);
}

async function waitForMiddlewareReady(state, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (state.ready) {
      return;
    }
    if (state.exited) {
      throw new Error(`middleware exited before ready (code=${state.exitCode}, signal=${state.exitSignal || "-"})`);
    }
    await sleep(50);
  }
  throw new Error("middleware ready timeout");
}

async function waitForOtp(state, sessionId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const otp = state.otpBySession.get(sessionId);
    if (otp) {
      return otp;
    }
    if (state.exited) {
      throw new Error(`middleware exited while waiting otp (code=${state.exitCode})`);
    }
    await sleep(50);
  }
  throw new Error(`otp timeout for session=${sessionId}`);
}

class JsonWebSocketClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.queue = [];
    this.waiters = [];
    this.closeInfo = null;
  }

  async connect(timeoutMs) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`websocket connect timeout: ${this.url}`));
      }, timeoutMs);

      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });

      ws.addEventListener("error", (event) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(new Error(`websocket connect failed: ${event && event.message ? event.message : "unknown"}`));
      });

      ws.addEventListener("message", (event) => {
        this.onMessage(event);
      });

      ws.addEventListener("close", (event) => {
        this.closeInfo = {
          code: event.code,
          reason: event.reason || ""
        };
      });
    });
  }

  onMessage(event) {
    const raw = typeof event.data === "string" ? event.data : String(event.data || "");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { type: "_raw", raw };
    }

    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i];
      if (!waiter.predicate(parsed)) {
        continue;
      }
      this.waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
      return;
    }

    this.queue.push(parsed);
  }

  send(payload) {
    assert(this.ws, "websocket is not connected");
    this.ws.send(JSON.stringify(payload));
  }

  waitFor(predicate, label, timeoutMs) {
    const existingIndex = this.queue.findIndex((item) => predicate(item));
    if (existingIndex >= 0) {
      const [found] = this.queue.splice(existingIndex, 1);
      return Promise.resolve(found);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const closeDetail = this.closeInfo
          ? ` (closed code=${this.closeInfo.code} reason=${this.closeInfo.reason || "-"})`
          : "";
        reject(new Error(`waitFor timeout: ${label}${closeDetail}`));
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async close() {
    if (!this.ws) {
      return;
    }

    const ws = this.ws;
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
      await sleep(100);
      return;
    }
  }
}

function assertGuardEnvelope(msg, label) {
  assert.equal(typeof msg.guardCategory, "string", `${label}: guardCategory missing`);
  assert.equal(typeof msg.guardReason, "string", `${label}: guardReason missing`);
  assert.equal(typeof msg.guardDetail, "string", `${label}: guardDetail missing`);
  assert.equal(typeof msg.retryRequired, "boolean", `${label}: retryRequired missing`);
  assert.equal(typeof msg.retryAction, "string", `${label}: retryAction missing`);
  assert.equal(typeof msg.retryScope, "string", `${label}: retryScope missing`);
  assert.equal(typeof msg.retryReason, "string", `${label}: retryReason missing`);

  if (msg.guardCategory === "-") {
    assert.equal(msg.retryRequired, false, `${label}: guard 미차단인데 retryRequired=true`);
    return;
  }

  assert.equal(msg.retryRequired, true, `${label}: guard 차단인데 retryRequired=false`);
  assert.notEqual(msg.retryAction, "-", `${label}: guard 차단인데 retryAction이 '-'입니다.`);
  assert.notEqual(msg.retryScope, "-", `${label}: guard 차단인데 retryScope가 '-'입니다.`);
  assert.notEqual(msg.retryReason, "-", `${label}: guard 차단인데 retryReason이 '-'입니다.`);
}

function buildGuardSnapshot(msg) {
  return {
    guardCategory: msg.guardCategory,
    guardReason: msg.guardReason,
    guardDetail: msg.guardDetail,
    retryRequired: msg.retryRequired,
    retryAction: msg.retryAction,
    retryScope: msg.retryScope,
    retryReason: msg.retryReason
  };
}

function buildPdfAttachment() {
  return {
    name: "guard-smoke.pdf",
    mimeType: "application/pdf",
    dataBase64: "JVBERi0xLjQKMSAwIG9iago8PCA+PgplbmRvYmoK",
    sizeBytes: 28,
    isImage: false
  };
}

function buildFreshnessProbeText(prefix) {
  const token = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `오늘 ${token} qxjvnfkz 최신 뉴스 업데이트 핵심만 알려줘`;
}

async function executeAuthFlow(client, processState, timeoutMs) {
  const authRequired = await client.waitFor((msg) => msg.type === "auth_required", "auth_required", timeoutMs);
  const sessionId = toTrimmed(authRequired.sessionId);
  assert(sessionId, "auth_required.sessionId is empty");

  client.send({ type: "request_otp" });
  const otpResult = await client.waitFor((msg) => msg.type === "otp_request_result", "otp_request_result", timeoutMs);
  assert.equal(otpResult.ok, true, "otp_request_result.ok must be true");

  const otp = await waitForOtp(processState, sessionId, timeoutMs);
  client.send({ type: "auth", otp });

  const authResult = await client.waitFor((msg) => msg.type === "auth_result", "auth_result", timeoutMs);
  assert.equal(authResult.ok, true, "auth_result.ok must be true");

  return { sessionId, otpMasked: otp.length >= 2 ? `${otp[0]}***${otp[otp.length - 1]}` : "***" };
}

async function waitForAuditBlockedGuard(auditLogPath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(auditLogPath)) {
      const lines = fs
        .readFileSync(auditLogPath, "utf8")
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (payload.action !== "telegram_guard_meta") {
          continue;
        }
        if (payload.status !== "blocked") {
          continue;
        }
        const message = String(payload.message || "");
        if (!message.includes("guardCategory=") || !message.includes("guardReason=") || !message.includes("guardDetail=")) {
          continue;
        }
        return payload;
      }
    }
    await sleep(120);
  }
  throw new Error("telegram_guard_meta blocked log not found");
}

async function runScenario(client, auditLogPath, timeoutMs, attempts) {
  const result = {
    checks: {},
    traces: []
  };

  client.send({ type: "ping" });
  await client.waitFor((msg) => msg.type === "pong", "pong", timeoutMs);

  client.send({ type: "llm_chat_single", text: "" });
  const emptyChatError = await client.waitFor(
    (msg) => msg.type === "error" && String(msg.message || "").includes("empty message"),
    "llm_chat_single empty error",
    timeoutMs
  );
  assertGuardEnvelope(emptyChatError, "llm_chat_single empty");
  result.checks.chatEmptyError = {
    ok: true,
    ...buildGuardSnapshot(emptyChatError)
  };

  client.send({ type: "coding_run_single", text: "" });
  const emptyCodingError = await client.waitFor(
    (msg) => msg.type === "error" && String(msg.message || "").includes("empty coding input"),
    "coding_run_single empty error",
    timeoutMs
  );
  assertGuardEnvelope(emptyCodingError, "coding_run_single empty");
  result.checks.codingEmptyError = {
    ok: true,
    ...buildGuardSnapshot(emptyCodingError)
  };

  client.send({ type: "telegram_stub_command", text: "" });
  const emptyTelegramResult = await client.waitFor(
    (msg) => msg.type === "telegram_stub_result" && msg.status === "invalid",
    "telegram_stub_command empty",
    timeoutMs
  );
  assertGuardEnvelope(emptyTelegramResult, "telegram_stub_command empty");
  result.checks.telegramEmptyError = {
    ok: true,
    ...buildGuardSnapshot(emptyTelegramResult)
  };

  let chatBlocked = null;
  for (let i = 0; i < attempts; i += 1) {
    const text = buildFreshnessProbeText("chat");
    client.send({
      type: "llm_chat_single",
      text,
      provider: "copilot",
      model: "gpt-5-mini",
      attachments: [buildPdfAttachment()],
      webSearchEnabled: true
    });

    const chatResult = await client.waitFor((msg) => msg.type === "llm_chat_result", "llm_chat_result", timeoutMs);
    assertGuardEnvelope(chatResult, "llm_chat_result");
    result.traces.push({
      step: "chat_guard_probe",
      attempt: i + 1,
      ...buildGuardSnapshot(chatResult)
    });

    if (chatResult.guardCategory !== "-") {
      chatBlocked = chatResult;
      break;
    }
  }
  assert(chatBlocked, "llm_chat_result에서 guard 차단이 확인되지 않았습니다.");
  result.checks.chatGuardBlocked = {
    ok: true,
    ...buildGuardSnapshot(chatBlocked)
  };

  let codingBlocked = null;
  for (let i = 0; i < attempts; i += 1) {
    const text = buildFreshnessProbeText("coding");
    client.send({
      type: "coding_run_single",
      text,
      provider: "copilot",
      model: "gpt-5-mini",
      language: "python",
      attachments: [buildPdfAttachment()],
      webSearchEnabled: true
    });

    const codingResult = await client.waitFor((msg) => msg.type === "coding_result", "coding_result", timeoutMs);
    assertGuardEnvelope(codingResult, "coding_result");
    result.traces.push({
      step: "coding_guard_probe",
      attempt: i + 1,
      ...buildGuardSnapshot(codingResult)
    });

    if (codingResult.guardCategory !== "-") {
      codingBlocked = codingResult;
      break;
    }
  }
  assert(codingBlocked, "coding_result에서 guard 차단이 확인되지 않았습니다.");
  result.checks.codingGuardBlocked = {
    ok: true,
    ...buildGuardSnapshot(codingBlocked)
  };

  client.send({ type: "telegram_stub_command", text: "/llm single provider copilot" });
  const providerSetResult = await client.waitFor(
    (msg) => msg.type === "telegram_stub_result" && msg.status === "ok",
    "telegram provider set",
    timeoutMs
  );
  assertGuardEnvelope(providerSetResult, "telegram provider set result");

  client.send({
    type: "telegram_stub_command",
    text: buildFreshnessProbeText("telegram"),
    attachments: [buildPdfAttachment()],
    webSearchEnabled: true
  });
  const telegramRouteResult = await client.waitFor(
    (msg) => msg.type === "telegram_stub_result" && typeof msg.status === "string" && msg.status !== "invalid",
    "telegram stub route result",
    timeoutMs
  );
  assertGuardEnvelope(telegramRouteResult, "telegram route result");
  result.checks.telegramRouteResult = {
    ok: true,
    status: telegramRouteResult.status,
    ...buildGuardSnapshot(telegramRouteResult)
  };

  const telegramGuardAudit = await waitForAuditBlockedGuard(auditLogPath, timeoutMs);
  result.checks.telegramGuardAuditBlocked = {
    ok: true,
    action: telegramGuardAudit.action,
    status: telegramGuardAudit.status,
    message: telegramGuardAudit.message
  };

  return result;
}

async function terminateProcess(child, waitMs) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGINT");
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    if (child.exitCode !== null) {
      return;
    }
    await sleep(50);
  }

  child.kill("SIGTERM");
  const secondStart = Date.now();
  while (Date.now() - secondStart < waitMs) {
    if (child.exitCode !== null) {
      return;
    }
    await sleep(50);
  }

  child.kill("SIGKILL");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeReport(pathOrEmpty, payload) {
  if (!pathOrEmpty) {
    return;
  }
  ensureDir(path.dirname(pathOrEmpty));
  fs.writeFileSync(pathOrEmpty, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const wsPort = await resolvePort(args.wsPort);
  const runtimePaths = createRuntimePaths(args.runtimeDir);
  const guardRetryTimelineStatePath = resolveGuardRetryTimelineStatePath(
    args.guardRetryTimelineStatePath || process.env.OMNINODE_GUARD_RETRY_TIMELINE_STATE_PATH
  );
  if (guardRetryTimelineStatePath) {
    ensureDir(path.dirname(guardRetryTimelineStatePath));
  }
  const guardStateBefore = summarizeGuardRetryTimelineState(guardRetryTimelineStatePath);

  const output = {
    ok: false,
    stage: "P3",
    generatedAtUtc: new Date().toISOString(),
    key_source_policy: "keychain|secure_file_600",
    wsPort,
    runtimeDir: runtimePaths.runtimeDir,
    build: null,
    auth: null,
    guardRetryTimelineStatePath: guardRetryTimelineStatePath || null,
    guardRetryTimelineSamples: {
      before: guardStateBefore,
      after: null,
      delta: null
    },
    checks: null,
    logs: {
      stdoutTail: "",
      stderrTail: ""
    }
  };

  let processBundle = null;
  let client = null;

  try {
    if (!args.skipBuild) {
      output.build = runBuild(args.project);
    }

    const env = buildMiddlewareEnv(process.env, wsPort, runtimePaths, guardRetryTimelineStatePath);
    processBundle = spawnMiddleware(args.project, env);

    await waitForMiddlewareReady(processBundle.state, args.timeoutMs);

    client = new JsonWebSocketClient(`ws://127.0.0.1:${wsPort}/ws/`);
    await client.connect(args.timeoutMs);

    output.auth = await executeAuthFlow(client, processBundle.state, args.timeoutMs);

    const checks = await runScenario(
      client,
      runtimePaths.auditLog,
      args.timeoutMs,
      args.attempts
    );
    output.checks = checks;
    output.ok = true;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
      }
    }

    if (processBundle) {
      output.logs.stdoutTail = tailText(processBundle.state.stdoutLines.join("\n"), 60);
      output.logs.stderrTail = tailText(processBundle.state.stderrLines.join("\n"), 60);
      await terminateProcess(processBundle.child, 1500);
    }

    const guardStateAfter = summarizeGuardRetryTimelineState(guardRetryTimelineStatePath);
    output.guardRetryTimelineSamples.after = guardStateAfter;
    output.guardRetryTimelineSamples.delta = {
      totalEntries: guardStateAfter.totalEntries - guardStateBefore.totalEntries,
      nonSeedEntries: guardStateAfter.nonSeedEntries - guardStateBefore.nonSeedEntries,
      seedEntries: guardStateAfter.seedEntries - guardStateBefore.seedEntries,
      byChannel: {
        chat: guardStateAfter.byChannel.chat - guardStateBefore.byChannel.chat,
        coding: guardStateAfter.byChannel.coding - guardStateBefore.byChannel.coding,
        telegram: guardStateAfter.byChannel.telegram - guardStateBefore.byChannel.telegram
      }
    };

    writeReport(args.writePath, output);
  }

  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
