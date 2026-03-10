#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");

const WebSocketImpl = globalThis.WebSocket || require("ws");

const DEFAULT_WS_PORT = "auto";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_PROFILE = "simple";
const READY_LOG_MARKER = "[web] dashboard=";
const DEFAULT_PROVIDERS = ["codex", "copilot", "gemini", "groq", "cerebras"];
const LEAN_PROVIDERS = new Set(["groq", "cerebras"]);
const VALID_PROFILES = new Set(["simple", "complex"]);
const VALID_LANGUAGES = new Set(["python", "javascript", "java", "c", "html"]);
const VALID_MODES = new Set(["single", "orchestration", "multi"]);
const DEFAULT_MODELS = {
  codex: "gpt-5.4",
  copilot: "gpt-5-mini",
  gemini: "gemini-3-flash-preview",
  groq: "meta-llama/llama-4-scout-17b-16e-instruct",
  cerebras: "gpt-oss-120b"
};
const MODEL_ENV_KEYS = {
  codex: "OMNINODE_CODEX_MODEL",
  copilot: "OMNINODE_COPILOT_MODEL",
  gemini: "OMNINODE_GEMINI_MODEL",
  groq: "OMNINODE_GROQ_MODEL",
  cerebras: "OMNINODE_CEREBRAS_MODEL"
};

function printUsage() {
  console.error(
    "Usage: node apps/omninode-middleware/check-coding-provider-smoke.js " +
      "[--project <csproj>] [--runtime-dir <path>] [--ws-port <port|auto>] " +
      "[--timeout-ms <ms>] [--providers codex,copilot,gemini,groq,cerebras] " +
      "[--modes single,orchestration,multi] " +
      "[--profile simple|complex] [--languages python,javascript,java,c,html] " +
      "[--task-limit <n>] [--skip-build] [--write <path>]"
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

function parseCsvList(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

function buildDefaultRuntimeDir() {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return path.resolve("/tmp", `omninode-coding-provider-smoke-${suffix}`);
}

function parseArgs(argv) {
  const middlewareDir = path.resolve(__dirname);
  const args = {
    project: path.resolve(middlewareDir, "OmniNode.Middleware.csproj"),
    runtimeDir: buildDefaultRuntimeDir(),
    wsPort: DEFAULT_WS_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    providers: [...DEFAULT_PROVIDERS],
    modes: ["single"],
    profile: DEFAULT_PROFILE,
    languages: [],
    taskLimit: 0,
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
    if (token === "--providers" && i + 1 < argv.length) {
      const parsed = parseCsvList(argv[++i]);
      args.providers = parsed.length > 0 ? parsed : [...DEFAULT_PROVIDERS];
      continue;
    }
    if (token === "--modes" && i + 1 < argv.length) {
      const parsed = parseCsvList(argv[++i]);
      const invalid = parsed.filter((mode) => !VALID_MODES.has(mode));
      if (invalid.length > 0) {
        throw new Error(`invalid modes: ${invalid.join(",")}`);
      }
      args.modes = parsed.length > 0 ? parsed : ["single"];
      continue;
    }
    if (token === "--profile" && i + 1 < argv.length) {
      const profile = toTrimmed(argv[++i]).toLowerCase();
      if (!VALID_PROFILES.has(profile)) {
        throw new Error(`invalid profile: ${profile}`);
      }
      args.profile = profile;
      continue;
    }
    if (token === "--languages" && i + 1 < argv.length) {
      const parsed = parseCsvList(argv[++i]);
      const invalid = parsed.filter((language) => !VALID_LANGUAGES.has(language));
      if (invalid.length > 0) {
        throw new Error(`invalid languages: ${invalid.join(",")}`);
      }
      args.languages = parsed;
      continue;
    }
    if (token === "--task-limit" && i + 1 < argv.length) {
      args.taskLimit = Math.max(0, parsePositiveInt(argv[++i], 0));
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function createRuntimePaths(runtimeDir) {
  ensureDir(runtimeDir);
  const workspaceRoot = path.join(runtimeDir, "workspace", "coding");
  const codeRunsDir = path.join(runtimeDir, "state", "code-runs");
  const memoryNotesDir = path.join(runtimeDir, "state", "memory-notes");
  ensureDir(workspaceRoot);
  ensureDir(codeRunsDir);
  ensureDir(memoryNotesDir);
  return {
    runtimeDir,
    workspaceRoot,
    authSession: path.join(runtimeDir, "state", "auth_sessions.json"),
    llmUsage: path.join(runtimeDir, "state", "llm_usage.json"),
    copilotUsage: path.join(runtimeDir, "state", "copilot_usage.json"),
    conversation: path.join(runtimeDir, "state", "conversations.json"),
    memoryNotes: memoryNotesDir,
    codeRuns: codeRunsDir,
    auditLog: path.join(runtimeDir, "state", "audit.log"),
    healthState: path.join(runtimeDir, "state", "gateway_health.json"),
    probeState: path.join(runtimeDir, "state", "gateway_startup_probe.json")
  };
}

function buildMiddlewareEnv(baseEnv, wsPort, runtimePaths) {
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
    OMNINODE_WORKSPACE_ROOT: runtimePaths.workspaceRoot,
    OMNINODE_TELEGRAM_TOKEN_KEYCHAIN_SERVICE: "omninode_missing_telegram_token_for_coding_provider_smoke",
    OMNINODE_TELEGRAM_CHAT_ID_KEYCHAIN_SERVICE: "omninode_missing_telegram_chat_for_coding_provider_smoke",
    OMNINODE_TELEGRAM_BOT_TOKEN_FILE: path.join(runtimePaths.runtimeDir, "missing_telegram_bot_token"),
    OMNINODE_TELEGRAM_CHAT_ID_FILE: path.join(runtimePaths.runtimeDir, "missing_telegram_chat_id")
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
      const ws = new WebSocketImpl(this.url);
      this.ws = ws;

      const onOpen = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const onError = (event) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(new Error(`websocket connect failed: ${event && event.message ? event.message : "unknown"}`));
      };
      const onMessage = (event) => {
        this.onMessage(event);
      };
      const onClose = (event) => {
        this.closeInfo = {
          code: event.code,
          reason: event.reason || ""
        };
      };

      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("open", onOpen);
        ws.addEventListener("error", onError);
        ws.addEventListener("message", onMessage);
        ws.addEventListener("close", onClose);
        return;
      }

      ws.on("open", onOpen);
      ws.on("error", onError);
      ws.on("message", (data) => onMessage({ data: typeof data === "string" ? data : data.toString("utf8") }));
      ws.on("close", (code, reason) => onClose({ code, reason: reason ? reason.toString("utf8") : "" }));
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
    if (typeof ws.close === "function") {
      ws.close();
    }
    await sleep(100);
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

  return {
    sessionId,
    otpMasked: otp.length >= 2 ? `${otp[0]}***${otp[otp.length - 1]}` : "***"
  };
}

function randomToken(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveModel(provider) {
  if (provider === "copilot") {
    return DEFAULT_MODELS.copilot;
  }
  const envKey = MODEL_ENV_KEYS[provider];
  const fromEnv = envKey ? toTrimmed(process.env[envKey]) : "";
  return fromEnv || DEFAULT_MODELS[provider] || "";
}

function buildPythonStdoutTask(provider, model) {
  const token = randomToken(`smoke-${provider}-stdout`);
  const safeToken = token.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `smoke_${provider}_${safeToken}.py`;
  return {
    id: "python_stdout",
    provider,
    model,
    language: "python",
    expectedFileName: fileName,
    expectedStdout: token,
    expectedFileContains: [token],
    expectedStdoutContains: [token],
    prompt: [
      "Python으로만 작업해.",
      `파일 하나만 만들고 파일명은 "${fileName}" 로 정확히 써.`,
      `프로그램 실행 시 stdout에는 정확히 "${token}" 한 줄만 출력돼야 한다.`,
      "다른 파일 생성과 설명 출력은 금지한다."
    ].join(" ")
  };
}

function buildJavascriptStdoutTask(provider, model) {
  const token = randomToken(`smoke-${provider}-js`);
  const safeToken = token.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `smoke_${provider}_${safeToken}.js`;
  return {
    id: "javascript_stdout",
    provider,
    model,
    language: "javascript",
    expectedFileName: fileName,
    expectedStdout: token,
    expectedFileContains: [token],
    expectedStdoutContains: [token],
    prompt: [
      "JavaScript로만 작업해.",
      `파일 하나만 만들고 파일명은 "${fileName}" 로 정확히 써.`,
      `프로그램 실행 시 stdout에는 정확히 "${token}" 한 줄만 출력돼야 한다.`,
      "다른 파일 생성과 설명 출력은 금지한다."
    ].join(" ")
  };
}

function buildComplexPythonTask(provider, model) {
  const token = randomToken(`complex-${provider}-py`);
  const dataset = [
    { bucket: "alpha", value: 3 },
    { bucket: "alpha", value: 4 },
    { bucket: "alpha", value: 5 },
    { bucket: "beta", value: 7 },
    { bucket: "gamma", value: 6 },
    { bucket: "gamma", value: 5 }
  ];
  return {
    id: "python_complex",
    provider,
    model,
    language: "python",
    expectedFiles: [
      {
        fileName: "main.py",
        contains: [
          "summarize_snapshot",
          token,
          "snapshot.json"
        ]
      },
      {
        fileName: "ledger.py",
        contains: [
          "def summarize_snapshot"
        ]
      },
      {
        fileName: "snapshot.json",
        jsonEquals: dataset
      }
    ],
    expectedStdoutLines: [
      token,
      "alpha=12;beta=7;gamma=11;grand=30;signature=59"
    ],
    prompt: [
      "Python으로만 작업해.",
      "정확히 3개 파일만 만들어: main.py, ledger.py, snapshot.json.",
      "세 파일은 처음부터 끝까지 완성된 내용으로 작성해.",
      "snapshot.json 내용은 아래 JSON과 정확히 일치해야 해.",
      "SNAPSHOT_JSON_BEGIN",
      JSON.stringify(dataset, null, 2),
      "SNAPSHOT_JSON_END",
      "ledger.py에는 snapshot 배열을 입력받아 bucket별 합계를 계산하고, bucket 이름 오름차순 기준으로 signature=sum((index+1)*total) 값을 만드는 summarize_snapshot 함수를 작성해.",
      "main.py는 import json으로 시작하고 snapshot.json을 읽고 ledger.py를 import해서 결과를 계산해.",
      `main.py를 실행하면 stdout은 정확히 2줄이어야 하고 첫 줄은 "${token}", 둘째 줄은 "alpha=12;beta=7;gamma=11;grand=30;signature=59" 이어야 한다.`,
      "설명문, 테스트 코드, 추가 파일 생성은 금지한다."
    ].join("\n")
  };
}

function buildComplexJavascriptTask(provider, model) {
  const token = randomToken(`complex-${provider}-js`);
  const dataset = [
    { stream: "core", minutes: 4 },
    { stream: "core", minutes: 7 },
    { stream: "edge", minutes: 2 },
    { stream: "edge", minutes: 5 },
    { stream: "ops", minutes: 9 }
  ];
  return {
    id: "javascript_complex",
    provider,
    model,
    language: "javascript",
    expectedFiles: [
      {
        fileName: "main.js",
        contains: [
          "buildScheduleReport",
          token,
          "schedule.json"
        ]
      },
      {
        fileName: "planner.js",
        contains: [
          "buildScheduleReport",
          "checksum"
        ]
      },
      {
        fileName: "schedule.json",
        jsonEquals: dataset
      }
    ],
    expectedStdoutLines: [
      token,
      "core=11|edge=7|ops=9|total=27|checksum=52"
    ],
    prompt: [
      "JavaScript(Node.js CommonJS)로만 작업해.",
      "정확히 3개 파일만 만들어: main.js, planner.js, schedule.json.",
      "세 파일은 처음부터 끝까지 완성된 내용으로 작성해.",
      "schedule.json 내용은 아래 JSON과 정확히 일치해야 해.",
      "SCHEDULE_JSON_BEGIN",
      JSON.stringify(dataset, null, 2),
      "SCHEDULE_JSON_END",
      "planner.js에는 schedule 배열을 입력받아 stream별 합계, total, stream 이름 오름차순 기준 checksum=sum((index+1)*total)을 계산하는 buildScheduleReport 함수를 작성해.",
      "main.js는 schedule.json을 읽고 planner.js를 require해서 결과를 계산해.",
      `main.js를 실행하면 stdout은 정확히 2줄이어야 하고 첫 줄은 "${token}", 둘째 줄은 "core=11|edge=7|ops=9|total=27|checksum=52" 이어야 한다.`,
      "설명문, 테스트 코드, 추가 파일 생성은 금지한다."
    ].join("\n")
  };
}

function buildComplexJavaTask(provider, model) {
  const token = randomToken(`complex-${provider}-java`);
  const datasetLines = [
    "alpha,3",
    "alpha,4",
    "alpha,5",
    "beta,7",
    "gamma,6",
    "gamma,5"
  ];
  return {
    id: "java_complex",
    provider,
    model,
    language: "java",
    skipExecutionStdoutValidation: true,
    expectedFiles: [
      {
        fileName: "Main.java",
        contains: [
          "class Main",
          "summarizeSnapshot",
          token,
          "snapshot.txt"
        ]
      },
      {
        fileName: "Ledger.java",
        contains: [
          "class Ledger",
          "summarizeSnapshot",
          "signature"
        ]
      },
      {
        fileName: "snapshot.txt",
        textEquals: datasetLines.join("\n") + "\n"
      }
    ],
    expectedRuntimeStdoutLines: [
      token,
      "alpha=12;beta=7;gamma=11;grand=30;signature=59"
    ],
    manualValidation: {
      kind: "java",
      compileArgs: ["-Xlint:none", "Main.java", "Ledger.java"],
      runArgs: ["Main"]
    },
    prompt: [
      "Java로만 작업해.",
      "정확히 3개 파일만 만들어: Main.java, Ledger.java, snapshot.txt.",
      "세 파일은 처음부터 끝까지 완성된 내용으로 작성해.",
      "snapshot.txt 내용은 아래 텍스트와 정확히 일치해야 해.",
      "SNAPSHOT_TXT_BEGIN",
      datasetLines.join("\n"),
      "SNAPSHOT_TXT_END",
      "Ledger.java에는 snapshot 행 목록을 입력받아 bucket별 합계와 signature=sum((index+1)*total) 값을 계산하는 summarizeSnapshot 메서드를 작성해.",
      "Main.java는 snapshot.txt를 읽고 Ledger.summarizeSnapshot을 호출해 결과를 계산해.",
      `javac Main.java Ledger.java && java Main 실행 시 stdout은 정확히 2줄이어야 하고 첫 줄은 "${token}", 둘째 줄은 "alpha=12;beta=7;gamma=11;grand=30;signature=59" 이어야 한다.`,
      "package 선언, 외부 라이브러리, 설명문, 테스트 코드, 추가 파일 생성은 금지한다."
    ].join("\n")
  };
}

function buildComplexCTask(provider, model) {
  const token = randomToken(`complex-${provider}-c`);
  const datasetLines = [
    "alpha,3",
    "alpha,4",
    "alpha,5",
    "beta,7",
    "gamma,6",
    "gamma,5"
  ];
  return {
    id: "c_complex",
    provider,
    model,
    language: "c",
    skipExecutionStdoutValidation: true,
    expectedFiles: [
      {
        fileName: "main.c",
        contains: [
          "#include \"ledger.h\"",
          token,
          "snapshot.txt"
        ]
      },
      {
        fileName: "ledger.c",
        contains: [
          "#include \"ledger.h\"",
          "summarize_snapshot",
          "signature"
        ]
      },
      {
        fileName: "ledger.h",
        contains: [
          "typedef struct",
          "summarize_snapshot"
        ]
      },
      {
        fileName: "snapshot.txt",
        textEquals: datasetLines.join("\n") + "\n"
      }
    ],
    expectedRuntimeStdoutLines: [
      token,
      "alpha=12;beta=7;gamma=11;grand=30;signature=59"
    ],
    manualValidation: {
      kind: "c",
      compileArgs: ["-std=c11", "-O2", "main.c", "ledger.c", "-o", "app"],
      runCommand: "app"
    },
    prompt: [
      "C11로만 작업해.",
      "정확히 4개 파일만 만들어: main.c, ledger.c, ledger.h, snapshot.txt.",
      "네 파일은 처음부터 끝까지 완성된 내용으로 작성해.",
      "snapshot.txt 내용은 아래 텍스트와 정확히 일치해야 해.",
      "SNAPSHOT_TXT_BEGIN",
      datasetLines.join("\n"),
      "SNAPSHOT_TXT_END",
      "ledger.h에는 Summary struct와 summarize_snapshot 선언을 작성해.",
      "ledger.c에는 snapshot.txt 경로를 읽어 bucket별 합계, grand total, bucket 이름 오름차순 기준 signature=sum((index+1)*total) 값을 계산하는 summarize_snapshot 함수를 작성해.",
      "main.c는 summarize_snapshot를 호출해 결과를 출력해.",
      `cc -std=c11 -O2 main.c ledger.c -o app && ./app 실행 시 stdout은 정확히 2줄이어야 하고 첫 줄은 "${token}", 둘째 줄은 "alpha=12;beta=7;gamma=11;grand=30;signature=59" 이어야 한다.`,
      "외부 라이브러리, 설명문, 테스트 코드, 추가 파일 생성은 금지한다."
    ].join("\n")
  };
}

function buildComplexHtmlTask(provider, model) {
  const token = randomToken(`complex-${provider}-html`);
  const summaryLine = "alpha=12;beta=7;gamma=11;grand=30;signature=59";
  return {
    id: "html_complex",
    provider,
    model,
    language: "html",
    skipExecutionStdoutValidation: true,
    expectedFiles: [
      {
        fileName: "index.html",
        contains: [
          "styles.css",
          "app.js",
          "dashboard-root"
        ]
      },
      {
        fileName: "styles.css",
        contains: [
          ".bucket-card",
          "border-radius: 16px"
        ]
      },
      {
        fileName: "app.js",
        contains: [
          token,
          "document.addEventListener",
          "bucket-card",
          "signature"
        ]
      }
    ],
    manualValidation: {
      kind: "html",
      entryFile: "index.html",
      visibleTexts: [token, summaryLine],
      selectorCounts: [
        { selector: ".bucket-card", count: 3 }
      ],
      styleChecks: [
        { selector: ".bucket-card", property: "border-top-left-radius", value: "16px" }
      ]
    },
    prompt: [
      "HTML, CSS, JavaScript로만 작업해.",
      "정확히 3개 파일만 만들어: index.html, styles.css, app.js.",
      "세 파일은 처음부터 끝까지 완성된 내용으로 작성해.",
      "index.html은 styles.css와 app.js를 연결하고 id=\"dashboard-root\" 컨테이너를 포함해.",
      "app.js는 아래 dataset을 코드 안에 직접 선언하고 DOMContentLoaded에서 화면을 렌더링해.",
      "DATASET_BEGIN",
      JSON.stringify([
        { bucket: "alpha", value: 3 },
        { bucket: "alpha", value: 4 },
        { bucket: "alpha", value: 5 },
        { bucket: "beta", value: 7 },
        { bucket: "gamma", value: 6 },
        { bucket: "gamma", value: 5 }
      ], null, 2),
      "DATASET_END",
      "app.js는 bucket별 합계, grand total, bucket 이름 오름차순 기준 signature=sum((index+1)*total) 값을 계산해야 해.",
      `브라우저에서 index.html을 열었을 때 보이는 텍스트에는 반드시 "${token}" 과 "${summaryLine}" 이 포함되어야 한다.`,
      "app.js는 bucket-card 클래스를 가진 카드 3개를 동적으로 렌더링해야 한다.",
      "styles.css는 .bucket-card에 border-radius: 16px를 적용해야 한다.",
      "외부 CDN, 프레임워크, 빌드도구, 설명문, 추가 파일 생성은 금지한다."
    ].join("\n")
  };
}

function filterTasksByLanguages(tasks, languages) {
  if (!Array.isArray(languages) || languages.length === 0) {
    return tasks;
  }
  const selected = new Set(languages);
  return tasks.filter((task) => selected.has(task.language));
}

function buildTaskPlan(provider, profile, languages) {
  const model = resolveModel(provider);
  const requestedLanguages = Array.isArray(languages) ? new Set(languages) : new Set();
  const explicitJavascriptRequested = requestedLanguages.has("javascript");
  if (profile === "complex") {
    const extendedTasks = [
      buildComplexPythonTask(provider, model),
      buildComplexJavaTask(provider, model),
      buildComplexCTask(provider, model),
      buildComplexHtmlTask(provider, model)
    ];
    if (!LEAN_PROVIDERS.has(provider) || explicitJavascriptRequested) {
      extendedTasks.push(buildComplexJavascriptTask(provider, model));
    }
    if (Array.isArray(languages) && languages.length > 0) {
      return filterTasksByLanguages(extendedTasks, languages);
    }
    const defaultTasks = [buildComplexPythonTask(provider, model)];
    if (!LEAN_PROVIDERS.has(provider)) {
      defaultTasks.push(buildComplexJavascriptTask(provider, model));
    }
    return defaultTasks;
  }

  const tasks = [buildPythonStdoutTask(provider, model)];
  if (!LEAN_PROVIDERS.has(provider) || explicitJavascriptRequested) {
    tasks.push(buildJavascriptStdoutTask(provider, model));
  }
  return filterTasksByLanguages(tasks, languages);
}

function expandTasksForModes(tasks, modes) {
  const selectedModes = Array.isArray(modes) && modes.length > 0 ? modes : ["single"];
  return tasks.flatMap((task) =>
    selectedModes.map((mode) => ({
      ...task,
      mode,
      scenarioId: `${mode}_${task.id}`
    }))
  );
}

function buildWorkerModelSelections(task) {
  const disabled = "none";
  return {
    groqModel: task.provider === "groq" ? task.model : disabled,
    geminiModel: task.provider === "gemini" ? task.model : disabled,
    cerebrasModel: task.provider === "cerebras" ? task.model : disabled,
    copilotModel: task.provider === "copilot" ? task.model : disabled,
    codexModel: task.provider === "codex" ? task.model : disabled
  };
}

function pickChangedFile(changedFiles, expectedFileName) {
  return (changedFiles || []).find((item) => path.basename(String(item || "")) === expectedFileName) || "";
}

function trimForReport(text, maxChars) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars) + "...";
}

function normalizeStdoutLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function buildExpectedFiles(task) {
  if (Array.isArray(task.expectedFiles) && task.expectedFiles.length > 0) {
    return task.expectedFiles;
  }

  return [
    {
      fileName: task.expectedFileName,
      contains: Array.isArray(task.expectedFileContains) ? task.expectedFileContains : []
    }
  ];
}

function normalizeComparableText(text) {
  return String(text || "").replace(/\r/g, "").trimEnd();
}

function runCommand(command, args, cwd, timeoutMs) {
  const outcome = spawnSync(command, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    timeout: timeoutMs
  });

  if (outcome.error) {
    throw outcome.error;
  }

  return {
    command: [command, ...(args || [])].join(" ").trim(),
    status: outcome.status,
    signal: outcome.signal,
    stdout: String(outcome.stdout || ""),
    stderr: String(outcome.stderr || "")
  };
}

function assertCommandSucceeded(label, outcome) {
  assert.equal(
    outcome.status,
    0,
    `${label} failed\ncommand: ${outcome.command}\nstdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`
  );
}

function validateRuntimeStdout(task, stdout, label) {
  const stdoutLines = normalizeStdoutLines(stdout);
  if (Array.isArray(task.expectedRuntimeStdoutLines) && task.expectedRuntimeStdoutLines.length > 0) {
    assert.deepEqual(stdoutLines, task.expectedRuntimeStdoutLines, `${task.provider}:${task.id} ${label} stdout lines mismatch`);
  }
  return stdoutLines;
}

function runJavaValidation(task, runDirectory, timeoutMs) {
  const manual = task.manualValidation || {};
  const compile = runCommand("javac", manual.compileArgs || ["-Xlint:none", "Main.java", "Ledger.java"], runDirectory, timeoutMs);
  assertCommandSucceeded(`${task.provider}:${task.id}:javac`, compile);

  const run = runCommand("java", manual.runArgs || ["Main"], runDirectory, timeoutMs);
  assertCommandSucceeded(`${task.provider}:${task.id}:java`, run);
  const stdoutLines = validateRuntimeStdout(task, run.stdout, "java");

  return {
    kind: "java",
    compileCommand: compile.command,
    compileStdout: trimForReport(compile.stdout, 240),
    compileStderr: trimForReport(compile.stderr, 240),
    runCommand: run.command,
    stdout: trimForReport(run.stdout, 240),
    stdoutLines,
    stderr: trimForReport(run.stderr, 240)
  };
}

function runCValidation(task, runDirectory, timeoutMs) {
  const manual = task.manualValidation || {};
  const compile = runCommand("cc", manual.compileArgs || ["-std=c11", "-O2", "main.c", "ledger.c", "-o", "app"], runDirectory, timeoutMs);
  assertCommandSucceeded(`${task.provider}:${task.id}:cc`, compile);

  const runTarget = path.resolve(runDirectory, manual.runCommand || "app");
  const run = runCommand(runTarget, [], runDirectory, timeoutMs);
  assertCommandSucceeded(`${task.provider}:${task.id}:app`, run);
  const stdoutLines = validateRuntimeStdout(task, run.stdout, "c");

  return {
    kind: "c",
    compileCommand: compile.command,
    compileStdout: trimForReport(compile.stdout, 240),
    compileStderr: trimForReport(compile.stderr, 240),
    runCommand: runTarget,
    stdout: trimForReport(run.stdout, 240),
    stdoutLines,
    stderr: trimForReport(run.stderr, 240)
  };
}

async function runHtmlValidation(task, runDirectory) {
  const manual = task.manualValidation || {};
  const { chromium } = require("playwright");
  const entryPath = path.resolve(runDirectory, manual.entryFile || "index.html");
  assert.ok(fs.existsSync(entryPath), `${task.provider}:${task.id} html entry missing: ${entryPath}`);
  const entryContent = fs.readFileSync(entryPath, "utf8");
  assert.ok(/^\s*(<!doctype html\b|<html\b)/i.test(entryContent), `${task.provider}:${task.id} index.html must start with HTML markup`);

  const rawChecks = [];
  for (const fileName of ["index.html", "styles.css", "app.js"]) {
    const filePath = path.resolve(runDirectory, fileName);
    assert.ok(fs.existsSync(filePath), `${task.provider}:${task.id} html asset missing: ${filePath}`);
    const fileContent = fs.readFileSync(filePath, "utf8");
    assert.ok(!fileContent.includes("#!/usr/bin/env bash"), `${task.provider}:${task.id} ${fileName} contains shell wrapper`);
    assert.ok(!fileContent.includes("cat > "), `${task.provider}:${task.id} ${fileName} contains heredoc shell wrapper`);
    rawChecks.push({
      fileName,
      startsWithHtml: fileName !== "index.html" || /^\s*(<!doctype html\b|<html\b)/i.test(fileContent),
      shellWrapperFree: !fileContent.includes("#!/usr/bin/env bash") && !fileContent.includes("cat > ")
    });
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(pathToFileURL(entryPath).href, { waitUntil: "load" });

    const visibleTexts = Array.isArray(manual.visibleTexts) ? manual.visibleTexts : [];
    if (visibleTexts.length > 0) {
      await page.waitForFunction(
        (texts) => texts.every((text) => document.body && document.body.innerText.includes(text)),
        visibleTexts,
        { timeout: 10_000 }
      );
    }

    const pageText = await page.locator("body").innerText();
    for (const expectedText of visibleTexts) {
      assert.ok(pageText.includes(expectedText), `${task.provider}:${task.id} html text missing: ${expectedText}`);
    }

    const selectorCounts = [];
    for (const rule of manual.selectorCounts || []) {
      const count = await page.locator(rule.selector).count();
      assert.equal(count, rule.count, `${task.provider}:${task.id} selector count mismatch for ${rule.selector}`);
      selectorCounts.push({ selector: rule.selector, count });
    }

    const styleChecks = [];
    for (const rule of manual.styleChecks || []) {
      const locator = page.locator(rule.selector).first();
      const value = await locator.evaluate((node, property) => getComputedStyle(node).getPropertyValue(property).trim(), rule.property);
      assert.equal(value, rule.value, `${task.provider}:${task.id} style mismatch for ${rule.selector} ${rule.property}`);
      styleChecks.push({ selector: rule.selector, property: rule.property, value });
    }

    return {
      kind: "html",
      entryPath,
      pageText: trimForReport(pageText, 240),
      selectorCounts,
      styleChecks,
      rawChecks
    };
  } finally {
    await browser.close();
  }
}

async function runManualValidation(task, runDirectory, timeoutMs) {
  if (!task.manualValidation || !runDirectory) {
    return null;
  }

  const kind = task.manualValidation.kind;
  if (kind === "java") {
    return runJavaValidation(task, runDirectory, timeoutMs);
  }
  if (kind === "c") {
    return runCValidation(task, runDirectory, timeoutMs);
  }
  if (kind === "html") {
    return runHtmlValidation(task, runDirectory);
  }
  return null;
}

function resolveValidationRunDirectory(task, result, verifiedFiles) {
  if (task.mode === "multi") {
    const workers = Array.isArray(result.workers) ? result.workers : [];
    const matchedWorker = workers.find(
      (worker) => worker && worker.provider === task.provider && worker.model === task.model
    );
    if (matchedWorker && matchedWorker.execution && toTrimmed(matchedWorker.execution.runDirectory)) {
      return matchedWorker.execution.runDirectory;
    }
  }

  if (toTrimmed(result.execution && result.execution.runDirectory)) {
    return result.execution.runDirectory;
  }

  const firstFile = verifiedFiles.find((file) => file && toTrimmed(file.path));
  return firstFile ? path.dirname(firstFile.path) : "";
}

async function validateCodingResult(task, result, timeoutMs) {
  assert.equal(result.type, "coding_result", `${task.provider}:${task.id} result.type`);
  assert.equal(result.mode, task.mode, `${task.provider}:${task.scenarioId} result.mode`);
  assert.equal(result.provider, task.provider, `${task.provider}:${task.id} result.provider`);
  assert.equal(result.model, task.model, `${task.provider}:${task.id} result.model`);
  assert.equal(result.language, task.language, `${task.provider}:${task.id} result.language`);

  const execution = result.execution || {};
  assert.equal(execution.status, "ok", `${task.provider}:${task.id} execution.status`);
  assert.equal(execution.exitCode, 0, `${task.provider}:${task.id} execution.exitCode`);
  assert.equal(typeof execution.runDirectory, "string", `${task.provider}:${task.id} execution.runDirectory`);
  assert.ok(Array.isArray(result.changedFiles), `${task.provider}:${task.id} changedFiles must be array`);
  assert.ok(result.changedFiles.length > 0, `${task.provider}:${task.id} changedFiles empty`);

  const expectedFiles = buildExpectedFiles(task);
  const verifiedFiles = [];

  for (const expectedFile of expectedFiles) {
    const changedFile = pickChangedFile(result.changedFiles, expectedFile.fileName);
    assert.ok(
      changedFile,
      `${task.provider}:${task.id} expected file missing from changedFiles: ${expectedFile.fileName}`
    );
    assert.ok(fs.existsSync(changedFile), `${task.provider}:${task.id} file not found: ${changedFile}`);

    const fileContent = fs.readFileSync(changedFile, "utf8");
    for (const expectedText of expectedFile.contains || []) {
      assert.ok(
        fileContent.includes(expectedText),
        `${task.provider}:${task.id} ${expectedFile.fileName} missing text: ${expectedText}`
      );
    }
    if (expectedFile.jsonEquals !== undefined) {
      const parsed = JSON.parse(fileContent);
      assert.deepEqual(
        parsed,
        expectedFile.jsonEquals,
        `${task.provider}:${task.id} ${expectedFile.fileName} json mismatch`
      );
    }
    if (expectedFile.textEquals !== undefined) {
      assert.equal(
        normalizeComparableText(fileContent),
        normalizeComparableText(expectedFile.textEquals),
        `${task.provider}:${task.id} ${expectedFile.fileName} text mismatch`
      );
    }

    verifiedFiles.push({
      fileName: expectedFile.fileName,
      path: changedFile,
      fileSize: Buffer.byteLength(fileContent, "utf8"),
      filePreview: trimForReport(fileContent, 240)
    });
  }

  if (task.mode === "orchestration") {
    assert.ok(Array.isArray(result.workers), `${task.provider}:${task.scenarioId} workers must be array`);
    assert.equal(result.workers.length, 4, `${task.provider}:${task.scenarioId} orchestration worker count`);
    for (const worker of result.workers) {
      assert.equal(worker.provider, task.provider, `${task.provider}:${task.scenarioId} orchestration worker provider`);
      assert.equal(worker.model, task.model, `${task.provider}:${task.scenarioId} orchestration worker model`);
      assert.equal(worker.language, task.language, `${task.provider}:${task.scenarioId} orchestration worker language`);
    }
  }

  if (task.mode === "multi") {
    assert.ok(Array.isArray(result.workers), `${task.provider}:${task.scenarioId} workers must be array`);
    assert.equal(result.workers.length, 1, `${task.provider}:${task.scenarioId} multi worker count`);
    const [worker] = result.workers;
    assert.equal(worker.provider, task.provider, `${task.provider}:${task.scenarioId} multi worker provider`);
    assert.equal(worker.model, task.model, `${task.provider}:${task.scenarioId} multi worker model`);
    assert.equal(worker.language, task.language, `${task.provider}:${task.scenarioId} multi worker language`);
    assert.equal(worker.execution.status, "ok", `${task.provider}:${task.scenarioId} multi worker execution.status`);
    if (!task.skipExecutionStdoutValidation) {
      const workerStdoutLines = normalizeStdoutLines(String((worker.execution && worker.execution.stdout) || ""));
      if (Array.isArray(task.expectedStdoutLines) && task.expectedStdoutLines.length > 0) {
        assert.deepEqual(
          workerStdoutLines,
          task.expectedStdoutLines,
          `${task.provider}:${task.scenarioId} multi worker stdout lines mismatch`
        );
      }
      for (const expectedText of task.expectedStdoutContains || []) {
        assert.ok(
          String((worker.execution && worker.execution.stdout) || "").includes(expectedText),
          `${task.provider}:${task.scenarioId} multi worker stdout missing: ${expectedText}`
        );
      }
    }
  }

  const stdout = String(execution.stdout || "");
  const stdoutLines = normalizeStdoutLines(stdout);
  if (!task.skipExecutionStdoutValidation && task.mode !== "multi") {
    for (const expectedText of task.expectedStdoutContains || []) {
      assert.ok(
        stdout.includes(expectedText),
        `${task.provider}:${task.id} stdout missing: ${expectedText}`
      );
    }
    if (Array.isArray(task.expectedStdoutLines) && task.expectedStdoutLines.length > 0) {
      assert.deepEqual(
        stdoutLines,
        task.expectedStdoutLines,
        `${task.provider}:${task.id} stdout lines mismatch`
      );
    }
  }

  const manualValidationRunDirectory = resolveValidationRunDirectory(task, result, verifiedFiles);
  const manualValidation = await runManualValidation(task, manualValidationRunDirectory, timeoutMs);

  return {
    provider: task.provider,
    model: task.model,
    taskId: task.id,
    mode: task.mode,
    language: task.language,
    runDirectory: manualValidationRunDirectory,
    file: verifiedFiles[0]?.path || "",
    fileSize: verifiedFiles[0]?.fileSize || 0,
    files: verifiedFiles,
    stdout: trimForReport(stdout, 240),
    stdoutLines,
    stderr: trimForReport(execution.stderr || "", 240),
    command: trimForReport(execution.command || "", 240),
    summary: trimForReport(result.summary || "", 240),
    filePreview: verifiedFiles[0]?.filePreview || "",
    manualValidation
  };
}

async function waitForCodingTerminalMessage(client, task, timeoutMs) {
  const errorPrefix = task.mode === "single"
    ? "coding_single failed"
    : task.mode === "orchestration"
      ? "coding_orchestration failed"
      : "coding_multi failed";
  return client.waitFor(
    (msg) =>
      (msg.type === "coding_result" && msg.mode === task.mode && msg.provider === task.provider)
      || (msg.type === "error" && String(msg.message || "").includes(errorPrefix)),
    `${task.provider}:${task.scenarioId}:coding_terminal`,
    timeoutMs
  );
}

function buildRunMessage(task) {
  const base = {
    scope: "coding",
    mode: task.mode,
    text: task.prompt,
    project: "smoke",
    category: `smoke-${task.scenarioId}`,
    tags: ["smoke", "coding", task.provider, task.mode, task.id],
    provider: task.provider,
    model: task.model,
    language: task.language,
    memoryNotes: "",
    attachments: [],
    webUrls: [],
    webSearchEnabled: false
  };

  if (task.mode === "single") {
    return {
      type: "coding_run_single",
      ...base
    };
  }

  const workerSelections = buildWorkerModelSelections(task);
  return {
    type: task.mode === "orchestration" ? "coding_run_orchestration" : "coding_run_multi",
    ...base,
    ...workerSelections
  };
}

async function runCodingTask(client, task, timeoutMs) {
  client.send(buildRunMessage(task));

  const terminal = await waitForCodingTerminalMessage(client, task, timeoutMs);
  if (terminal.type === "error") {
    throw new Error(`${task.provider}:${task.scenarioId}: ${terminal.message || "unknown error"}`);
  }

  return validateCodingResult(task, terminal, timeoutMs);
}

async function runScenario(client, providers, timeoutMs, profile, taskLimit, languages, modes) {
  const summary = {
    totals: {
      providers: providers.length,
      tasks: 0,
      passed: 0,
      failed: 0
    },
    profile,
    languages: Array.isArray(languages) ? [...languages] : [],
    modes: Array.isArray(modes) ? [...modes] : ["single"],
    providers: {}
  };

  client.send({ type: "ping" });
  await client.waitFor((msg) => msg.type === "pong", "pong", timeoutMs);

  for (const provider of providers) {
    const plannedTasks = buildTaskPlan(provider, profile, languages);
    const tasks = taskLimit > 0 ? plannedTasks.slice(0, taskLimit) : plannedTasks;
    const providerResult = {
      provider,
      model: resolveModel(provider),
      budget: LEAN_PROVIDERS.has(provider) ? "lean" : "standard",
      profile,
      languages: Array.isArray(languages) ? [...languages] : [],
      modes: Array.isArray(modes) ? [...modes] : ["single"],
      taskLimit,
      tasks: []
    };
    summary.providers[provider] = providerResult;

    const expandedTasks = expandTasksForModes(tasks, modes);
    for (const task of expandedTasks) {
      summary.totals.tasks += 1;
      const startedAt = Date.now();
      try {
        const result = await runCodingTask(client, task, timeoutMs);
        providerResult.tasks.push({
          ok: true,
          elapsedMs: Date.now() - startedAt,
          ...result
        });
        summary.totals.passed += 1;
      } catch (error) {
        providerResult.tasks.push({
          ok: false,
          taskId: task.id,
          language: task.language,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        });
        summary.totals.failed += 1;
      }
    }
  }

  return summary;
}

async function stopMiddleware(bundle) {
  if (!bundle || !bundle.child || bundle.child.killed) {
    return;
  }
  bundle.child.kill("SIGINT");
  for (let i = 0; i < 20; i += 1) {
    if (bundle.state.exited) {
      return;
    }
    await sleep(100);
  }
  if (!bundle.state.exited) {
    bundle.child.kill("SIGKILL");
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const wsPort = await resolvePort(args.wsPort);
  const runtimePaths = createRuntimePaths(args.runtimeDir);
  const result = {
    ok: false,
    wsPort,
    runtimeDir: runtimePaths.runtimeDir,
    workspaceRoot: runtimePaths.workspaceRoot,
    auth: null,
    build: null,
    scenario: null,
    middleware: null
  };

  let middleware = null;
  let client = null;
  try {
    if (!args.skipBuild) {
      result.build = runBuild(args.project);
    }

    middleware = spawnMiddleware(
      args.project,
      buildMiddlewareEnv(process.env, wsPort, runtimePaths)
    );
    result.middleware = {
      project: args.project
    };

    await waitForMiddlewareReady(middleware.state, args.timeoutMs);

    client = new JsonWebSocketClient(`ws://127.0.0.1:${wsPort}/ws/`);
    await client.connect(args.timeoutMs);
    result.auth = await executeAuthFlow(client, middleware.state, args.timeoutMs);
    result.scenario = await runScenario(
      client,
      args.providers,
      args.timeoutMs,
      args.profile,
      args.taskLimit,
      args.languages,
      args.modes
    );
    result.ok = result.scenario.totals.failed === 0;
  } finally {
    if (client) {
      await client.close();
    }
    if (middleware) {
      result.middleware = {
        ...result.middleware,
        stdoutTail: middleware.state.stdoutLines.slice(-20),
        stderrTail: middleware.state.stderrLines.slice(-20),
        exited: middleware.state.exited,
        exitCode: middleware.state.exitCode,
        exitSignal: middleware.state.exitSignal
      };
      await stopMiddleware(middleware);
      result.middleware = {
        ...result.middleware,
        exited: middleware.state.exited,
        exitCode: middleware.state.exitCode,
        exitSignal: middleware.state.exitSignal
      };
    }
  }

  const serialized = JSON.stringify(result, null, 2);
  if (args.writePath) {
    ensureDir(path.dirname(args.writePath));
    fs.writeFileSync(args.writePath, serialized);
  }

  process.stdout.write(serialized + "\n");
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(message + "\n");
  process.exit(1);
});
