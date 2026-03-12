#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_STDIO_BUFFER = 16 * 1024 * 1024;
const DEFAULT_MODEL = (process.env.OMNINODE_ROUTINE_BROWSER_AGENT_MODEL || "gpt-5.4").trim() || "gpt-5.4";
const DEFAULT_ALLOWED_MODELS = [DEFAULT_MODEL];
const TOOL_PROFILE_PLAYWRIGHT_ONLY = "playwright_only";
const TOOL_PROFILE_DESKTOP_CONTROL = "desktop_control";

function toOptionalTrimmedString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function resolveTimeoutMs(payload) {
  const envRaw = toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_CODEX_TIMEOUT_MS);
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.max(parsed, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
    }
  }

  const runTimeoutSeconds = Number(payload && payload.runTimeoutSeconds);
  if (Number.isFinite(runTimeoutSeconds) && runTimeoutSeconds > 0) {
    return Math.min(Math.max(Math.trunc(runTimeoutSeconds * 1000), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  }

  return DEFAULT_TIMEOUT_MS;
}

function resolveAllowedModels() {
  const raw = toOptionalTrimmedString(process.env.OMNINODE_ROUTINE_BROWSER_AGENT_MODELS);
  if (!raw) {
    return DEFAULT_ALLOWED_MODELS;
  }

  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return values.length > 0 ? values : DEFAULT_ALLOWED_MODELS;
}

function resolveModel(payload) {
  const requested = toOptionalTrimmedString(payload && payload.model)
    || toOptionalTrimmedString(payload && payload.options && payload.options.model)
    || DEFAULT_MODEL;
  const allowed = new Set(resolveAllowedModels().map((item) => item.toLowerCase()));
  if (!allowed.has(requested.toLowerCase())) {
    return {
      ok: false,
      model: requested,
      error: `unsupported model: ${requested}; allowed=${Array.from(allowed).join(", ")}`
    };
  }

  return { ok: true, model: requested, error: null };
}

function resolveWorkspaceCwd() {
  const envCwd = toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_CODEX_CWD);
  return envCwd || process.cwd();
}

function normalizeToolProfile(value) {
  const normalized = toOptionalTrimmedString(value)?.toLowerCase();
  if (!normalized) {
    return TOOL_PROFILE_PLAYWRIGHT_ONLY;
  }

  if (normalized === "desktop_control" || normalized === "desktop-control") {
    return TOOL_PROFILE_DESKTOP_CONTROL;
  }

  if (normalized === "playwright_only" || normalized === "playwright-only" || normalized === "playwright") {
    return TOOL_PROFILE_PLAYWRIGHT_ONLY;
  }

  return normalized;
}

function resolveToolProfile(payload) {
  return normalizeToolProfile(
    payload?.toolProfile
      || payload?.options?.toolProfile
  );
}

function resolveOutputDirectory(payload, workspaceCwd) {
  const requested = toOptionalTrimmedString(
    payload?.outputDirectory
      || payload?.options?.outputDirectory
  );
  if (!requested) {
    return null;
  }

  return path.resolve(workspaceCwd, requested);
}

function ensureDirectoryExists(dirPath) {
  if (!dirPath) {
    return;
  }

  fs.mkdirSync(dirPath, { recursive: true });
}

function formatTomlString(value) {
  return JSON.stringify(String(value));
}

function formatTomlArray(values) {
  return `[${values.map((value) => formatTomlString(value)).join(",")}]`;
}

function buildPlaywrightMcpConfig(outputDirectory) {
  const args = ["@playwright/mcp@latest"];
  if (outputDirectory) {
    args.push("--output-dir", outputDirectory, "--output-mode", "file");
  }

  return [
    ["mcp_servers.playwright.command", formatTomlString("npx")],
    ["mcp_servers.playwright.args", formatTomlArray(args)]
  ];
}

function buildDesktopControlMcpConfig(outputDirectory) {
  const scriptPath = path.resolve(__dirname, "desktop-control-mcp.js");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`desktop control MCP script not found: ${scriptPath}`);
  }

  const args = [scriptPath];
  if (outputDirectory) {
    args.push("--output-dir", outputDirectory);
  }

  return [
    ["mcp_servers.desktop_control.command", formatTomlString(process.execPath)],
    ["mcp_servers.desktop_control.args", formatTomlArray(args)]
  ];
}

function appendConfigOverrides(args, overrides) {
  for (const [key, value] of overrides) {
    args.push("-c", `${key}=${value}`);
  }
}

function normalizeErrorText(stdout, stderr, fallback) {
  const merged = `${String(stderr || "")}\n${String(stdout || "")}`.trim();
  if (!merged) {
    return fallback;
  }

  const lines = merged
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(-6).join(" | ").slice(0, 1200) || fallback;
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function emitError(message, error, extras) {
  emit({
    status: "error",
    backend: "codex_exec",
    message,
    error,
    ...(extras || {})
  });
}

function appendChunk(current, chunk) {
  const next = current + String(chunk || "");
  if (next.length <= MAX_STDIO_BUFFER) {
    return next;
  }
  return next.slice(next.length - MAX_STDIO_BUFFER);
}

function writeLogFile(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, "utf8");
  } catch (_err) {
  }
}

function readLastMessage(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    return String(fs.readFileSync(filePath, "utf8") || "").trim();
  } catch (_err) {
    return "";
  }
}

function tryKillProcessGroup(child, signal) {
  if (!child || !child.pid) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
    return;
  } catch (_err) {
  }

  try {
    child.kill(signal);
  } catch (_err) {
  }
}

function runCodexExec({ codexBin, args, workspaceCwd, timeoutMs, lastMessagePath, stdoutPath, stderrPath }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutId = null;
    let pollId = null;
    let stableOutput = "";
    let stableCount = 0;

    const child = spawn(codexBin, args, {
      cwd: workspaceCwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const finish = (result, shouldTerminate) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (pollId) {
        clearInterval(pollId);
      }

      writeLogFile(stdoutPath, stdout);
      writeLogFile(stderrPath, stderr);

      if (shouldTerminate) {
        tryKillProcessGroup(child, "SIGTERM");
        setTimeout(() => {
          tryKillProcessGroup(child, "SIGKILL");
        }, 1500).unref?.();
      }

      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendChunk(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendChunk(stderr, chunk);
    });

    child.on("error", (runError) => {
      finish({
        ok: false,
        error: runError instanceof Error ? runError.message : String(runError),
        stdout,
        stderr,
        rawOutput: readLastMessage(lastMessagePath)
      }, true);
    });

    child.on("exit", (code, signal) => {
      const rawOutput = readLastMessage(lastMessagePath);
      if (rawOutput) {
        finish({
          ok: true,
          stdout,
          stderr,
          rawOutput,
          exitCode: code,
          signal
        }, false);
        return;
      }

      finish({
        ok: false,
        error: normalizeErrorText(stdout, stderr, signal ? `signal=${String(signal)}` : `exit=${String(code)}`),
        stdout,
        stderr,
        rawOutput: ""
      }, false);
    });

    timeoutId = setTimeout(() => {
      const rawOutput = readLastMessage(lastMessagePath);
      if (rawOutput) {
        finish({
          ok: true,
          stdout,
          stderr,
          rawOutput,
          exitCode: null,
          signal: "timeout_after_output"
        }, true);
        return;
      }

      finish({
        ok: false,
        error: `codex exec timeout after ${timeoutMs}ms`,
        stdout,
        stderr,
        rawOutput: ""
      }, true);
    }, timeoutMs);

    pollId = setInterval(() => {
      const rawOutput = readLastMessage(lastMessagePath);
      if (!rawOutput) {
        stableOutput = "";
        stableCount = 0;
        return;
      }

      if (rawOutput === stableOutput) {
        stableCount += 1;
      } else {
        stableOutput = rawOutput;
        stableCount = 1;
      }

      if (stableCount < 2) {
        return;
      }

      finish({
        ok: true,
        stdout,
        stderr,
        rawOutput,
        exitCode: null,
        signal: "file_ready"
      }, true);
    }, 500);
  });
}

async function main() {
  let rawInput = "";
  try {
    rawInput = fs.readFileSync(0, "utf8");
  } catch (readError) {
    emitError(
      "failed to read adapter payload from stdin",
      readError instanceof Error ? readError.message : String(readError),
      {}
    );
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(rawInput || "{}");
  } catch (parseError) {
    emitError(
      "invalid adapter payload json",
      parseError instanceof Error ? parseError.message : String(parseError),
      {}
    );
    return;
  }

  const runId = toOptionalTrimmedString(payload.runId) || `codex-${Date.now().toString(36)}`;
  const childSessionKey = toOptionalTrimmedString(payload.childSessionKey);
  const task = toOptionalTrimmedString(payload.task);
  if (!childSessionKey) {
    emitError("adapter payload requires childSessionKey", "childSessionKey is missing", {});
    return;
  }
  if (!task) {
    emitError("adapter payload requires task", "task is missing", { childSessionKey });
    return;
  }

  const resolvedModel = resolveModel(payload);
  if (!resolvedModel.ok) {
    emitError(
      "codex exec model is not supported in this environment",
      resolvedModel.error,
      { childSessionKey }
    );
    return;
  }

  const codexBin = toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_CODEX_BIN) || "codex";
  const workspaceCwd = resolveWorkspaceCwd();
  const timeoutMs = resolveTimeoutMs(payload);
  const toolProfile = resolveToolProfile(payload);
  const outputDirectory = resolveOutputDirectory(payload, workspaceCwd);
  if (toolProfile !== TOOL_PROFILE_PLAYWRIGHT_ONLY && toolProfile !== TOOL_PROFILE_DESKTOP_CONTROL) {
    emitError(
      "codex exec tool profile is not supported in this environment",
      `unsupported toolProfile: ${toolProfile}`,
      { childSessionKey }
    );
    return;
  }
  if (toolProfile === TOOL_PROFILE_DESKTOP_CONTROL && process.platform !== "darwin") {
    emitError(
      "desktop_control is only supported on macOS",
      `unsupported platform: ${process.platform}`,
      { childSessionKey }
    );
    return;
  }
  if (toolProfile === TOOL_PROFILE_DESKTOP_CONTROL && !outputDirectory) {
    emitError(
      "desktop_control requires an output directory",
      "outputDirectory is missing",
      { childSessionKey }
    );
    return;
  }
  try {
    ensureDirectoryExists(outputDirectory);
  } catch (mkdirError) {
    emitError(
      "failed to prepare ACP output directory",
      mkdirError instanceof Error ? mkdirError.message : String(mkdirError),
      { childSessionKey, outputDirectory }
    );
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omninode-codex-acp-"));
  const lastMessagePath = path.join(tempDir, "last-message.txt");
  const stdoutPath = path.join(tempDir, "codex-stdout.log");
  const stderrPath = path.join(tempDir, "codex-stderr.log");

  const args = [
    "exec",
    "-C", workspaceCwd,
    "--dangerously-bypass-approvals-and-sandbox",
    "--color", "never",
    "-o", lastMessagePath,
    "-m", resolvedModel.model
  ];
  appendConfigOverrides(args, buildPlaywrightMcpConfig(outputDirectory));
  if (toolProfile === TOOL_PROFILE_DESKTOP_CONTROL) {
    try {
      appendConfigOverrides(args, buildDesktopControlMcpConfig(outputDirectory));
    } catch (configError) {
      emitError(
        "failed to configure desktop control MCP",
        configError instanceof Error ? configError.message : String(configError),
        { childSessionKey, outputDirectory }
      );
      return;
    }
  }
  args.push(task);

  const run = await runCodexExec({
    codexBin,
    args,
    workspaceCwd,
    timeoutMs,
    lastMessagePath,
    stdoutPath,
    stderrPath
  });

  const stdout = String(run.stdout || "");
  const stderr = String(run.stderr || "");
  const rawOutput = String(run.rawOutput || "").trim();

  if (!run.ok) {
    emitError(
      "codex exec returned an error",
      normalizeErrorText(stdout, stderr, run.error || "unknown codex exec error"),
      {
        childSessionKey,
        backendSessionId: `codex-exec-${runId.slice(0, 12)}`,
        rawOutput: rawOutput || null
      }
    );
    return;
  }

  if (!rawOutput) {
    emitError(
      "codex exec completed without a final message",
      "last agent message was empty",
      {
        childSessionKey,
        backendSessionId: `codex-exec-${runId.slice(0, 12)}`
      }
    );
    return;
  }

  emit({
    status: "accepted",
    backend: "codex_exec",
    message: `codex exec completed with model ${resolvedModel.model}`,
    backendSessionId: `codex-exec-${runId.slice(0, 12)}`,
    rawOutput: rawOutput
  });
}

main().catch((error) => {
  emitError(
    "unexpected adapter failure",
    error instanceof Error ? error.message : String(error),
    {}
  );
});
