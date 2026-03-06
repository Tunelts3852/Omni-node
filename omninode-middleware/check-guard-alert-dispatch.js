#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const READY_LOG_MARKER = "[web] dashboard=";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 700;
const DEFAULT_DISPATCH_MAX_ATTEMPTS = 1;
const GUARD_ALERT_SCHEMA_VERSION = "guard_alert_event.v1";
const GUARD_ALERT_EVENT_TYPE = "omninode.guard_alert.summary";
const GUARD_ALERT_COUNT_LOCK_CHANNELS = ["chat", "coding", "telegram", "search", "other"];

function printUsage() {
  console.error(
    "Usage: node omninode-middleware/check-guard-alert-dispatch.js " +
      "[--project <csproj>] [--runtime-dir <path>] [--timeout-ms <ms>] " +
      "[--dispatch-timeout-ms <ms>] [--dispatch-max-attempts <n>] " +
      "[--skip-build] [--include-live-targets] " +
      "[--live-webhook-url <url>] [--live-log-collector-url <url>] " +
      "[--write <path>]"
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
    runtimeDir: path.resolve("/tmp", `omninode-guard-alert-dispatch-${Date.now()}`),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dispatchTimeoutMs: DEFAULT_DISPATCH_TIMEOUT_MS,
    dispatchMaxAttempts: DEFAULT_DISPATCH_MAX_ATTEMPTS,
    skipBuild: false,
    includeLiveTargets: false,
    liveWebhookUrl: "",
    liveLogCollectorUrl: "",
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
    if (token === "--timeout-ms" && i + 1 < argv.length) {
      args.timeoutMs = parsePositiveInt(argv[++i], args.timeoutMs);
      continue;
    }
    if (token === "--dispatch-timeout-ms" && i + 1 < argv.length) {
      args.dispatchTimeoutMs = parsePositiveInt(argv[++i], args.dispatchTimeoutMs);
      continue;
    }
    if (token === "--dispatch-max-attempts" && i + 1 < argv.length) {
      args.dispatchMaxAttempts = parsePositiveInt(argv[++i], args.dispatchMaxAttempts);
      continue;
    }
    if (token === "--skip-build") {
      args.skipBuild = true;
      continue;
    }
    if (token === "--include-live-targets") {
      args.includeLiveTargets = true;
      continue;
    }
    if (token === "--live-webhook-url" && i + 1 < argv.length) {
      args.liveWebhookUrl = toTrimmed(argv[++i]);
      continue;
    }
    if (token === "--live-log-collector-url" && i + 1 < argv.length) {
      args.liveLogCollectorUrl = toTrimmed(argv[++i]);
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

function createRuntimePaths(baseRuntimeDir, scenarioName) {
  const runtimeDir = path.join(baseRuntimeDir, scenarioName);
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

function buildMiddlewareEnv(baseEnv, wsPort, runtimePaths, scenarioConfig, dispatchConfig) {
  return {
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
    OMNINODE_TELEGRAM_TOKEN_KEYCHAIN_SERVICE: "omninode_missing_telegram_token_for_guard_alert_dispatch",
    OMNINODE_TELEGRAM_CHAT_ID_KEYCHAIN_SERVICE: "omninode_missing_telegram_chat_for_guard_alert_dispatch",
    OMNINODE_TELEGRAM_BOT_TOKEN_FILE: path.join(runtimePaths.runtimeDir, "missing_telegram_bot_token"),
    OMNINODE_TELEGRAM_CHAT_ID_FILE: path.join(runtimePaths.runtimeDir, "missing_telegram_chat_id"),
    OMNINODE_GUARD_ALERT_WEBHOOK_URL: scenarioConfig.webhookUrl,
    OMNINODE_GUARD_ALERT_LOG_COLLECTOR_URL: scenarioConfig.logCollectorUrl,
    OMNINODE_GUARD_ALERT_DISPATCH_TIMEOUT_MS: String(dispatchConfig.timeoutMs),
    OMNINODE_GUARD_ALERT_DISPATCH_MAX_ATTEMPTS: String(dispatchConfig.maxAttempts)
  };
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
      throw new Error(`middleware exited while waiting otp (code=${state.exitCode}, signal=${state.exitSignal || "-"})`);
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

  return { sessionId };
}

function buildGuardAlertEvent(scenarioName) {
  const countLockUnsatisfiedByChannel = {
    chat: 3,
    coding: 1,
    telegram: 1,
    search: 0,
    other: 0
  };
  const countLockUnsatisfiedRateByChannel = {
    chat: 0.3,
    coding: 0.1,
    telegram: 0.2,
    search: 0,
    other: 0
  };
  return {
    schemaVersion: GUARD_ALERT_SCHEMA_VERSION,
    eventType: GUARD_ALERT_EVENT_TYPE,
    eventId: `loop0038-${scenarioName}-${Date.now().toString(36)}`,
    emittedAtUtc: new Date().toISOString(),
    source: "check-guard-alert-dispatch",
    summary: {
      scenario: scenarioName,
      guardStatus: "critical",
      retryStatus: "warn"
    },
    guardMetrics: {
      totalSamples: 10,
      countLockUnsatisfiedTotal: 5,
      countLockUnsatisfiedByChannel,
      countLockUnsatisfiedRateByChannel
    }
  };
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => toTrimmed(item)).filter(Boolean).join(",");
  }
  return toTrimmed(value);
}

function assertFiniteNonNegativeNumber(value, label) {
  assert.equal(typeof value, "number", `${label} must be number`);
  assert(Number.isFinite(value), `${label} must be finite number`);
  assert(value >= 0, `${label} must be >= 0`);
}

function assertRate(value, label) {
  assertFiniteNonNegativeNumber(value, label);
  assert(value <= 1, `${label} must be <= 1`);
}

function assertGuardAlertEventContract(payload, scenarioName) {
  assert(payload && typeof payload === "object" && !Array.isArray(payload), `${scenarioName}: payload must be object`);
  assert.equal(payload.schemaVersion, GUARD_ALERT_SCHEMA_VERSION, `${scenarioName}: schemaVersion mismatch`);
  assert.equal(payload.eventType, GUARD_ALERT_EVENT_TYPE, `${scenarioName}: eventType mismatch`);
  assert.equal(typeof payload.eventId, "string", `${scenarioName}: eventId must be string`);
  assert(payload.eventId.length > 0, `${scenarioName}: eventId must not be empty`);
  assert.equal(typeof payload.emittedAtUtc, "string", `${scenarioName}: emittedAtUtc must be string`);
  assert(!Number.isNaN(Date.parse(payload.emittedAtUtc)), `${scenarioName}: emittedAtUtc must be ISO8601`);

  const guardMetrics = payload.guardMetrics;
  assert(
    guardMetrics && typeof guardMetrics === "object" && !Array.isArray(guardMetrics),
    `${scenarioName}: guardMetrics must be object`
  );
  assertFiniteNonNegativeNumber(guardMetrics.totalSamples, `${scenarioName}: guardMetrics.totalSamples`);
  assertFiniteNonNegativeNumber(
    guardMetrics.countLockUnsatisfiedTotal,
    `${scenarioName}: guardMetrics.countLockUnsatisfiedTotal`
  );

  const countLockUnsatisfiedByChannel = guardMetrics.countLockUnsatisfiedByChannel;
  const countLockUnsatisfiedRateByChannel = guardMetrics.countLockUnsatisfiedRateByChannel;
  assert(
    countLockUnsatisfiedByChannel && typeof countLockUnsatisfiedByChannel === "object" && !Array.isArray(countLockUnsatisfiedByChannel),
    `${scenarioName}: guardMetrics.countLockUnsatisfiedByChannel must be object`
  );
  assert(
    countLockUnsatisfiedRateByChannel
      && typeof countLockUnsatisfiedRateByChannel === "object"
      && !Array.isArray(countLockUnsatisfiedRateByChannel),
    `${scenarioName}: guardMetrics.countLockUnsatisfiedRateByChannel must be object`
  );

  let unsatisfiedSum = 0;
  for (const channel of GUARD_ALERT_COUNT_LOCK_CHANNELS) {
    const unsatisfied = countLockUnsatisfiedByChannel[channel];
    const rate = countLockUnsatisfiedRateByChannel[channel];
    assertFiniteNonNegativeNumber(unsatisfied, `${scenarioName}: countLockUnsatisfiedByChannel.${channel}`);
    assertRate(rate, `${scenarioName}: countLockUnsatisfiedRateByChannel.${channel}`);
    unsatisfiedSum += unsatisfied;
  }

  assert.equal(
    unsatisfiedSum,
    guardMetrics.countLockUnsatisfiedTotal,
    `${scenarioName}: guardMetrics.countLockUnsatisfiedTotal must match channel sum`
  );
}

function assertMockTargetPayloads(probe, expectedPayload, scenarioName) {
  const requestPayloads = probe && probe.requestPayloads;
  if (!requestPayloads || typeof requestPayloads !== "object") {
    return {
      verified: false,
      reason: "no_mock_payloads",
      checkedRequestCount: 0,
      checkedTargets: []
    };
  }

  const checkedTargets = [];
  let checkedRequestCount = 0;
  for (const targetName of ["webhook", "log_collector"]) {
    const requests = Array.isArray(requestPayloads[targetName]) ? requestPayloads[targetName] : [];
    if (requests.length === 0) {
      continue;
    }

    checkedTargets.push(targetName);
    for (let i = 0; i < requests.length; i += 1) {
      const request = requests[i] || {};
      const requestLabel = `${scenarioName}: mock-target(${targetName}) request(${i})`;
      const method = toTrimmed(request.method).toUpperCase();
      const contentType = normalizeHeaderValue(request.headers && request.headers["content-type"]).toLowerCase();
      const schemaHeader = normalizeHeaderValue(request.headers && request.headers["x-omninode-schema-version"]);

      assert.equal(method, "POST", `${requestLabel}: method must be POST`);
      assert(contentType.includes("application/json"), `${requestLabel}: content-type must contain application/json`);
      assert.equal(schemaHeader, GUARD_ALERT_SCHEMA_VERSION, `${requestLabel}: schema header mismatch`);

      let parsedBody = null;
      try {
        parsedBody = JSON.parse(String(request.body || ""));
      } catch (error) {
        throw new Error(`${requestLabel}: body JSON parse failed (${error.message})`);
      }

      assertGuardAlertEventContract(parsedBody, requestLabel);
      assert.deepEqual(parsedBody, expectedPayload, `${requestLabel}: payload mismatch`);
      checkedRequestCount += 1;
    }
  }

  return {
    verified: checkedRequestCount > 0,
    reason: checkedRequestCount > 0 ? "" : "no_mock_request_captured",
    checkedRequestCount,
    checkedTargets
  };
}

function resolveLiveTargetConfig(args) {
  const fromEnvWebhook = toTrimmed(process.env.OMNINODE_GUARD_ALERT_WEBHOOK_URL || "");
  const fromEnvLogCollector = toTrimmed(process.env.OMNINODE_GUARD_ALERT_LOG_COLLECTOR_URL || "");
  const webhookUrl = toTrimmed(args.liveWebhookUrl || fromEnvWebhook);
  const logCollectorUrl = toTrimmed(args.liveLogCollectorUrl || fromEnvLogCollector);

  if (args.includeLiveTargets && !webhookUrl && !logCollectorUrl) {
    throw new Error(
      "live target 검증에는 최소 1개 이상의 URL이 필요합니다. " +
      "--live-webhook-url/--live-log-collector-url 또는 " +
      "OMNINODE_GUARD_ALERT_WEBHOOK_URL/OMNINODE_GUARD_ALERT_LOG_COLLECTOR_URL을 설정하세요."
    );
  }

  return { webhookUrl, logCollectorUrl };
}

function buildScenarioDefinitions(options) {
  const scenarios = [
    {
      name: "no_target_configured",
      description: "Webhook/Log Collector URL이 모두 비어 있을 때 no_target_configured",
      setup: async () => ({
        config: {
          webhookUrl: "",
          logCollectorUrl: ""
        },
        probe: {
          requestCounts: {
            webhook: 0,
            log_collector: 0
          },
          requestPayloads: {
            webhook: [],
            log_collector: []
          }
        },
        async cleanup() {
        }
      }),
      expected: {
        ok: false,
        status: "no_target_configured",
        sentCount: 0,
        failedCount: 0,
        skippedCount: 2,
        targetStatuses: {
          webhook: "skipped",
          log_collector: "skipped"
        }
      }
    },
    {
      name: "sent_all",
      description: "Webhook/Log Collector 모두 HTTP 2xx 응답 시 sent",
      setup: async () => {
        const webhook = await startMockTarget("webhook", { type: "success", statusCode: 202 });
        const logCollector = await startMockTarget("log_collector", { type: "success", statusCode: 200 });
        return {
          config: {
            webhookUrl: webhook.url,
            logCollectorUrl: logCollector.url
          },
          probe: {
            requestCounts: {
              get webhook() {
                return webhook.requests.length;
              },
              get log_collector() {
                return logCollector.requests.length;
              }
            },
            requestPayloads: {
              get webhook() {
                return webhook.requests;
              },
              get log_collector() {
                return logCollector.requests;
              }
            }
          },
          async cleanup() {
            await Promise.all([webhook.close(), logCollector.close()]);
          }
        };
      },
      expected: {
        ok: true,
        status: "sent",
        sentCount: 2,
        failedCount: 0,
        skippedCount: 0,
        targetStatuses: {
          webhook: "sent",
          log_collector: "sent"
        }
      }
    },
    {
      name: "partial_failed_http",
      description: "한쪽 HTTP 실패(500) 시 partial_failed",
      setup: async () => {
        const webhook = await startMockTarget("webhook", { type: "success", statusCode: 200 });
        const logCollector = await startMockTarget("log_collector", { type: "http_error", statusCode: 500, body: "collector down" });
        return {
          config: {
            webhookUrl: webhook.url,
            logCollectorUrl: logCollector.url
          },
          probe: {
            requestCounts: {
              get webhook() {
                return webhook.requests.length;
              },
              get log_collector() {
                return logCollector.requests.length;
              }
            },
            requestPayloads: {
              get webhook() {
                return webhook.requests;
              },
              get log_collector() {
                return logCollector.requests;
              }
            }
          },
          async cleanup() {
            await Promise.all([webhook.close(), logCollector.close()]);
          }
        };
      },
      expected: {
        ok: false,
        status: "partial_failed",
        sentCount: 1,
        failedCount: 1,
        skippedCount: 0,
        targetStatuses: {
          webhook: "sent",
          log_collector: "failed"
        },
        targetErrorsInclude: {
          log_collector: "http_500"
        }
      }
    },
    {
      name: "failed_timeout",
      description: "모든 대상 timeout 시 failed",
      setup: async () => {
        const webhook = await startMockTarget("webhook", { type: "timeout" });
        const logCollector = await startMockTarget("log_collector", { type: "timeout" });
        return {
          config: {
            webhookUrl: webhook.url,
            logCollectorUrl: logCollector.url
          },
          probe: {
            requestCounts: {
              get webhook() {
                return webhook.requests.length;
              },
              get log_collector() {
                return logCollector.requests.length;
              }
            },
            requestPayloads: {
              get webhook() {
                return webhook.requests;
              },
              get log_collector() {
                return logCollector.requests;
              }
            }
          },
          async cleanup() {
            await Promise.all([webhook.close(), logCollector.close()]);
          }
        };
      },
      expected: {
        ok: false,
        status: "failed",
        sentCount: 0,
        failedCount: 2,
        skippedCount: 0,
        targetStatuses: {
          webhook: "failed",
          log_collector: "failed"
        },
        targetErrorsInclude: {
          webhook: "timeout",
          log_collector: "timeout"
        }
      }
    },
    {
      name: "failed_invalid_url",
      description: "유효하지 않은 스킴 URL 주입 시 invalid_url 계열 실패",
      setup: async () => ({
        config: {
          webhookUrl: "ftp://127.0.0.1:65535/guard-alert",
          logCollectorUrl: ""
        },
        probe: {
          requestCounts: {
            webhook: 0,
            log_collector: 0
          },
          requestPayloads: {
            webhook: [],
            log_collector: []
          }
        },
        async cleanup() {
        }
      }),
      expected: {
        ok: false,
        status: "failed",
        sentCount: 0,
        failedCount: 1,
        skippedCount: 1,
        targetStatuses: {
          webhook: "failed",
          log_collector: "skipped"
        },
        targetErrorsInclude: {
          webhook: "invalid_target_scheme"
        }
      }
    }
  ];

  if (options.includeLiveTargets) {
    const liveTargetConfig = options.liveTargetConfig;
    scenarios.push({
      name: "live_targets",
      description: "실환경 URL 주입 상태에서 dispatch_guard_alert 전송 결과 검증",
      setup: async () => ({
        config: {
          webhookUrl: liveTargetConfig.webhookUrl,
          logCollectorUrl: liveTargetConfig.logCollectorUrl
        },
        probe: {
          requestCounts: {
            webhook: null,
            log_collector: null
          },
          requestPayloads: {}
        },
        async cleanup() {
        }
      }),
      assertResult: (dispatchResult, scenarioName) => {
        assertLiveDispatchResult(dispatchResult, liveTargetConfig, scenarioName);
      }
    });
  }

  return scenarios;
}

async function startMockTarget(name, behavior) {
  const requests = [];
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8")
      });

      if (behavior.type === "success") {
        res.statusCode = behavior.statusCode || 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, target: name }));
        return;
      }

      if (behavior.type === "http_error") {
        res.statusCode = behavior.statusCode || 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(behavior.body || "mock error");
        return;
      }

      if (behavior.type === "timeout") {
        // Intentionally do not end the response to trigger middleware timeout.
        return;
      }

      res.statusCode = 500;
      res.end("unknown mock behavior");
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error(`mock target address unavailable: ${name}`);
  }

  return {
    url: `http://127.0.0.1:${address.port}/${name}`,
    requests,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function toTargetMap(dispatchResult) {
  const map = new Map();
  const targets = Array.isArray(dispatchResult.targets) ? dispatchResult.targets : [];
  for (const target of targets) {
    const name = toTrimmed(target && target.name);
    if (!name) {
      continue;
    }
    map.set(name, target);
  }
  return map;
}

function assertDispatchResult(result, expected, scenarioName) {
  assert.equal(result.type, "guard_alert_dispatch_result", `${scenarioName}: invalid message type`);
  assert.equal(result.status, expected.status, `${scenarioName}: status mismatch`);
  assert.equal(Boolean(result.ok), expected.ok, `${scenarioName}: ok mismatch`);
  assert.equal(Number(result.sentCount || 0), expected.sentCount, `${scenarioName}: sentCount mismatch`);
  assert.equal(Number(result.failedCount || 0), expected.failedCount, `${scenarioName}: failedCount mismatch`);
  assert.equal(Number(result.skippedCount || 0), expected.skippedCount, `${scenarioName}: skippedCount mismatch`);
  assert.equal(result.schemaVersion, GUARD_ALERT_SCHEMA_VERSION, `${scenarioName}: schemaVersion mismatch`);
  assert.equal(result.eventType, GUARD_ALERT_EVENT_TYPE, `${scenarioName}: eventType mismatch`);

  const targetMap = toTargetMap(result);
  for (const [name, status] of Object.entries(expected.targetStatuses || {})) {
    const target = targetMap.get(name);
    assert(target, `${scenarioName}: missing target ${name}`);
    assert.equal(target.status, status, `${scenarioName}: target(${name}) status mismatch`);
  }

  for (const [name, needle] of Object.entries(expected.targetErrorsInclude || {})) {
    const target = targetMap.get(name);
    assert(target, `${scenarioName}: missing target ${name} for error check`);
    const errorText = String(target.error || "");
    assert(
      errorText.includes(needle),
      `${scenarioName}: target(${name}) error does not include '${needle}' (actual='${errorText}')`
    );
  }
}

function assertLiveDispatchResult(result, liveTargetConfig, scenarioName) {
  assert.equal(result.type, "guard_alert_dispatch_result", `${scenarioName}: invalid message type`);
  assert.equal(result.schemaVersion, GUARD_ALERT_SCHEMA_VERSION, `${scenarioName}: schemaVersion mismatch`);
  assert.equal(result.eventType, GUARD_ALERT_EVENT_TYPE, `${scenarioName}: eventType mismatch`);

  const allowedStatuses = new Set(["sent", "partial_failed", "failed"]);
  assert(allowedStatuses.has(result.status), `${scenarioName}: unsupported status '${String(result.status || "")}'`);

  const configuredTargets = [
    { name: "webhook", endpoint: toTrimmed(liveTargetConfig.webhookUrl) },
    { name: "log_collector", endpoint: toTrimmed(liveTargetConfig.logCollectorUrl) }
  ];
  const targetMap = toTargetMap(result);
  let configuredCount = 0;

  for (const targetInfo of configuredTargets) {
    const target = targetMap.get(targetInfo.name);
    assert(target, `${scenarioName}: missing target ${targetInfo.name}`);

    if (targetInfo.endpoint) {
      configuredCount += 1;
      assert.notEqual(
        toTrimmed(target.status),
        "skipped",
        `${scenarioName}: target(${targetInfo.name}) must not be skipped when live endpoint is configured`
      );
    } else {
      assert.equal(
        toTrimmed(target.status),
        "skipped",
        `${scenarioName}: target(${targetInfo.name}) must be skipped when endpoint is empty`
      );
    }
  }

  assert(configuredCount > 0, `${scenarioName}: no configured live target`);
  const sentCount = Number(result.sentCount || 0);
  const failedCount = Number(result.failedCount || 0);
  assert(
    sentCount + failedCount >= configuredCount,
    `${scenarioName}: sentCount+failedCount(${sentCount + failedCount}) < configured(${configuredCount})`
  );
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

function snapshotDispatchResult(result) {
  return {
    type: result.type,
    ok: Boolean(result.ok),
    status: toTrimmed(result.status),
    message: toTrimmed(result.message),
    schemaVersion: toTrimmed(result.schemaVersion),
    eventType: toTrimmed(result.eventType),
    attemptedAtUtc: toTrimmed(result.attemptedAtUtc),
    sentCount: Number(result.sentCount || 0),
    failedCount: Number(result.failedCount || 0),
    skippedCount: Number(result.skippedCount || 0),
    targets: Array.isArray(result.targets)
      ? result.targets.map((target) => ({
          name: toTrimmed(target && target.name),
          status: toTrimmed(target && target.status),
          attempts: Number((target && target.attempts) || 0),
          statusCode: target && target.statusCode !== undefined ? target.statusCode : null,
          error: toTrimmed(target && target.error),
          endpoint: toTrimmed(target && target.endpoint)
        }))
      : []
  };
}

function toNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function runSingleScenario(args, scenario, dispatchConfig) {
  const wsPort = await allocatePort();
  const runtimePaths = createRuntimePaths(args.runtimeDir, scenario.name);
  const scenarioResult = {
    name: scenario.name,
    description: scenario.description,
    ok: false,
    wsPort,
    runtimeDir: runtimePaths.runtimeDir,
    expected: scenario.expected,
    dispatchResult: null,
    requestCounts: null,
    payloadContract: {
      eventPayload: "not_verified",
      mockTargetPayload: "not_verified",
      checkedMockRequestCount: 0,
      checkedMockTargets: [],
      reason: ""
    },
    logs: {
      stdoutTail: "",
      stderrTail: ""
    },
    error: ""
  };

  let setupBundle = null;
  let processBundle = null;
  let client = null;

  try {
    setupBundle = await scenario.setup();

    const env = buildMiddlewareEnv(process.env, wsPort, runtimePaths, setupBundle.config, dispatchConfig);
    processBundle = spawnMiddleware(args.project, env);

    await waitForMiddlewareReady(processBundle.state, args.timeoutMs);

    client = new JsonWebSocketClient(`ws://127.0.0.1:${wsPort}/ws/`);
    await client.connect(args.timeoutMs);
    await executeAuthFlow(client, processBundle.state, args.timeoutMs);

    const eventPayload = buildGuardAlertEvent(scenario.name);
    assertGuardAlertEventContract(eventPayload, `${scenario.name}: eventPayload`);
    scenarioResult.payloadContract.eventPayload = "verified";
    client.send({
      type: "dispatch_guard_alert",
      guardAlertEvent: eventPayload
    });

    const dispatchResult = await client.waitFor(
      (msg) => msg.type === "guard_alert_dispatch_result",
      `${scenario.name}: guard_alert_dispatch_result`,
      args.timeoutMs
    );

    if (typeof scenario.assertResult === "function") {
      scenario.assertResult(dispatchResult, scenario.name);
    } else {
      assertDispatchResult(dispatchResult, scenario.expected, scenario.name);
    }
    const mockTargetPayloadCheck = assertMockTargetPayloads(setupBundle.probe, eventPayload, scenario.name);
    scenarioResult.payloadContract.mockTargetPayload = mockTargetPayloadCheck.verified ? "verified" : "not_applicable";
    scenarioResult.payloadContract.checkedMockRequestCount = mockTargetPayloadCheck.checkedRequestCount;
    scenarioResult.payloadContract.checkedMockTargets = mockTargetPayloadCheck.checkedTargets;
    scenarioResult.payloadContract.reason = mockTargetPayloadCheck.reason || "";

    scenarioResult.dispatchResult = snapshotDispatchResult(dispatchResult);
    scenarioResult.requestCounts = {
      webhook: toNullableNumber(setupBundle.probe.requestCounts.webhook),
      log_collector: toNullableNumber(setupBundle.probe.requestCounts.log_collector)
    };
    scenarioResult.ok = true;
  } catch (error) {
    scenarioResult.error = error && error.stack ? error.stack : String(error);
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
      }
    }

    if (processBundle) {
      scenarioResult.logs.stdoutTail = tailText(processBundle.state.stdoutLines.join("\n"), 60);
      scenarioResult.logs.stderrTail = tailText(processBundle.state.stderrLines.join("\n"), 60);
      await terminateProcess(processBundle.child, 1500);
    }

    if (setupBundle && typeof setupBundle.cleanup === "function") {
      try {
        await setupBundle.cleanup();
      } catch {
      }
    }
  }

  return scenarioResult;
}

async function main() {
  const args = parseArgs(process.argv);
  ensureDir(args.runtimeDir);
  const liveTargetConfig = resolveLiveTargetConfig(args);

  const dispatchConfig = {
    timeoutMs: Math.max(500, args.dispatchTimeoutMs),
    maxAttempts: Math.max(1, args.dispatchMaxAttempts)
  };

  const output = {
    ok: false,
    stage: "P6",
    generatedAtUtc: new Date().toISOString(),
    key_source_policy: "keychain|secure_file_600",
    project: args.project,
    runtimeDir: args.runtimeDir,
    liveTargets: {
      enabled: args.includeLiveTargets,
      webhookConfigured: Boolean(liveTargetConfig.webhookUrl),
      logCollectorConfigured: Boolean(liveTargetConfig.logCollectorUrl)
    },
    dispatchPolicy: {
      timeoutMs: dispatchConfig.timeoutMs,
      maxAttempts: dispatchConfig.maxAttempts
    },
    build: null,
    scenarios: []
  };

  if (!args.skipBuild) {
    output.build = runBuild(args.project);
  }

  const scenarios = buildScenarioDefinitions({
    includeLiveTargets: args.includeLiveTargets,
    liveTargetConfig
  });
  for (const scenario of scenarios) {
    const scenarioResult = await runSingleScenario(args, scenario, dispatchConfig);
    output.scenarios.push(scenarioResult);
  }

  output.ok = output.scenarios.every((item) => item.ok === true);
  output.summary = {
    total: output.scenarios.length,
    passed: output.scenarios.filter((item) => item.ok).length,
    failed: output.scenarios.filter((item) => !item.ok).length
  };

  writeReport(args.writePath, output);
  console.log(JSON.stringify(output, null, 2));

  if (!output.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
