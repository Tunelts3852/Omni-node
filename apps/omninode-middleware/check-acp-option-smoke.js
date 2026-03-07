#!/usr/bin/env node

"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_STDIO_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;
const EXPECT_MODES = new Set(["any", "true", "false"]);

function toOptionalTrimmedString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node omninode-middleware/check-acp-option-smoke.js [options]",
      "",
      "Options:",
      "  --adapter <path>                         Path to acp-adapter-acpx-ensure.js",
      "  --acpx-command <command>                 ACPX command path (or use env)",
      "  --acpx-cwd <path>                        ACPX working directory",
      "  --session-prefix <prefix>                Session key prefix",
      "  --model <model>                          Runtime model option",
      "  --thinking <level>                       Runtime thinking option",
      "  --task <text>                            Prompt task text",
      "  --timeout-ms <ms>                        Timeout per adapter execution",
      "  --expect-lightcontext-direct-set <mode>  any | true | false",
      "  --previous-capability-fingerprint <sha>  Previous capability fingerprint (optional)",
      "  --previous-acpx-version <text>           Previous acpx version text (optional)",
      "  --previous-result-file <path>            Previous smoke result JSON path (optional)",
      "  --write-result-file <path>               Write current result JSON to file (optional)",
      "  --promote-write-result-to-previous       Copy current result JSON to previous result file",
      "  --no-promote-write-result-to-previous    Disable promotion even when env default is enabled",
      "  --help                                   Show this help",
      "",
      "Examples:",
      "  node omninode-middleware/check-acp-option-smoke.js \\",
      "    --acpx-command /path/to/acpx \\",
      "    --acpx-cwd /Users/me/workspace \\",
      "    --expect-lightcontext-direct-set false"
    ].join("\n") + "\n"
  );
}

function parseNumber(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(raw, fallback, optionName) {
  const text = toOptionalTrimmedString(raw);
  if (!text) {
    return fallback;
  }
  const lowered = text.toLowerCase();
  if (lowered === "1" || lowered === "true" || lowered === "yes" || lowered === "on") {
    return true;
  }
  if (lowered === "0" || lowered === "false" || lowered === "no" || lowered === "off") {
    return false;
  }
  throw new Error(`invalid ${optionName} value: ${text}`);
}

function resolveOptions(argv) {
  const defaults = {
    adapter: path.resolve(__dirname, "tools", "acp-adapter-acpx-ensure.js"),
    acpxCommand: toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_ACPX_COMMAND) || "acpx",
    acpxCwd: toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_ACPX_CWD) || process.cwd(),
    sessionPrefix: "acp-option-smoke",
    model: "gpt-5-mini",
    thinking: "low",
    task: "Respond with a single line: ok.",
    timeoutMs: parseNumber(process.env.OMNINODE_ACP_OPTION_SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    expectLightContextDirectSet: "any",
    previousCapabilityFingerprint:
      toOptionalTrimmedString(process.env.OMNINODE_ACP_OPTION_SMOKE_PREVIOUS_CAPABILITY_FINGERPRINT),
    previousAcpxVersion: toOptionalTrimmedString(process.env.OMNINODE_ACP_OPTION_SMOKE_PREVIOUS_ACPX_VERSION),
    previousResultFile: toOptionalTrimmedString(process.env.OMNINODE_ACP_OPTION_SMOKE_PREVIOUS_RESULT_FILE),
    writeResultFile: toOptionalTrimmedString(process.env.OMNINODE_ACP_OPTION_SMOKE_WRITE_RESULT_FILE),
    promoteWriteResultToPrevious: parseBoolean(
      process.env.OMNINODE_ACP_OPTION_SMOKE_PROMOTE_WRITE_RESULT_TO_PREVIOUS,
      false,
      "OMNINODE_ACP_OPTION_SMOKE_PROMOTE_WRITE_RESULT_TO_PREVIOUS"
    )
  };

  const options = { ...defaults };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--adapter":
        options.adapter = path.resolve(argv[++i] || "");
        break;
      case "--acpx-command":
        options.acpxCommand = toOptionalTrimmedString(argv[++i]) || options.acpxCommand;
        break;
      case "--acpx-cwd":
        options.acpxCwd = path.resolve(argv[++i] || options.acpxCwd);
        break;
      case "--session-prefix":
        options.sessionPrefix = toOptionalTrimmedString(argv[++i]) || options.sessionPrefix;
        break;
      case "--model":
        options.model = toOptionalTrimmedString(argv[++i]) || options.model;
        break;
      case "--thinking":
        options.thinking = toOptionalTrimmedString(argv[++i]) || options.thinking;
        break;
      case "--task":
        options.task = toOptionalTrimmedString(argv[++i]) || options.task;
        break;
      case "--timeout-ms":
        options.timeoutMs = parseNumber(argv[++i], options.timeoutMs);
        break;
      case "--expect-lightcontext-direct-set": {
        const mode = (toOptionalTrimmedString(argv[++i]) || "").toLowerCase();
        if (!EXPECT_MODES.has(mode)) {
          throw new Error(`invalid --expect-lightcontext-direct-set value: ${mode || "<empty>"}`);
        }
        options.expectLightContextDirectSet = mode;
        break;
      }
      case "--previous-capability-fingerprint":
        options.previousCapabilityFingerprint =
          toOptionalTrimmedString(argv[++i]) || options.previousCapabilityFingerprint;
        break;
      case "--previous-acpx-version":
        options.previousAcpxVersion =
          toOptionalTrimmedString(argv[++i]) || options.previousAcpxVersion;
        break;
      case "--previous-result-file":
        options.previousResultFile =
          toOptionalTrimmedString(argv[++i]) || options.previousResultFile;
        if (options.previousResultFile) {
          options.previousResultFile = path.resolve(options.previousResultFile);
        }
        break;
      case "--write-result-file":
        options.writeResultFile =
          toOptionalTrimmedString(argv[++i]) || options.writeResultFile;
        if (options.writeResultFile) {
          options.writeResultFile = path.resolve(options.writeResultFile);
        }
        break;
      case "--promote-write-result-to-previous":
        options.promoteWriteResultToPrevious = true;
        break;
      case "--no-promote-write-result-to-previous":
        options.promoteWriteResultToPrevious = false;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${token}`);
    }
  }

  if (options.writeResultFile) {
    options.writeResultFile = path.resolve(options.writeResultFile);
  }
  if (options.promoteWriteResultToPrevious && !options.writeResultFile) {
    throw new Error("--promote-write-result-to-previous requires --write-result-file");
  }
  if (options.promoteWriteResultToPrevious && !options.previousResultFile && options.writeResultFile) {
    options.previousResultFile = path.resolve(path.dirname(options.writeResultFile), "previous-result.json");
  }
  if (options.previousResultFile) {
    options.previousResultFile = path.resolve(options.previousResultFile);
  }

  return options;
}

function buildSessionKey(prefix, lightContext) {
  const stamp = Date.now().toString(36);
  const suffix = lightContext ? "light-true" : "light-false";
  return `${prefix}-${suffix}-${stamp}`;
}

function parseResultJson(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeConfigOptions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = [];
  for (const option of value) {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      continue;
    }
    const id = toOptionalTrimmedString(option.id);
    if (!id) {
      continue;
    }
    normalized.push({
      id,
      type: toOptionalTrimmedString(option.type),
      name: toOptionalTrimmedString(option.name),
      description: toOptionalTrimmedString(option.description),
      category: toOptionalTrimmedString(option.category),
      values: normalizeStringArray(option.values).sort((a, b) => a.localeCompare(b))
    });
  }
  normalized.sort((a, b) => a.id.localeCompare(b.id));
  return normalized;
}

function normalizeSupportedOptionKey(rawKey) {
  const trimmed = toOptionalTrimmedString(rawKey);
  if (!trimmed) {
    return null;
  }
  const withoutLeading = trimmed.replace(/^[\["'`({\s]+/, "");
  const withoutTrailing = withoutLeading.replace(/[\]"'`)}\s.;:]+$/g, "");
  return toOptionalTrimmedString(withoutTrailing);
}

function parseSupportedKeysFromWarning(warning) {
  const text = toOptionalTrimmedString(warning);
  if (!text) {
    return [];
  }
  const marker = "supported=";
  const index = text.lastIndexOf(marker);
  if (index < 0) {
    return [];
  }
  const rawKeys = text
    .slice(index + marker.length)
    .replace(/\)+\s*$/, "");
  const deduped = new Map();
  return rawKeys
    .split(",")
    .map((token) => normalizeSupportedOptionKey(token))
    .filter((token) => typeof token === "string" && token.length > 0)
    .filter((token) => {
      const lowered = token.toLowerCase();
      if (deduped.has(lowered)) {
        return false;
      }
      deduped.set(lowered, true);
      return true;
    });
}

function toOptionKeyTokenized(rawId) {
  return String(rawId || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toOptionKeyFlat(rawId) {
  return toOptionKeyTokenized(rawId).replace(/_/g, "");
}

function looksLikeLightContextOptionId(rawId) {
  const normalized = toOptionKeyTokenized(rawId);
  if (!normalized) {
    return false;
  }
  const flattened = toOptionKeyFlat(rawId);
  return (
    normalized.includes("light_context") ||
    normalized.includes("bootstrap_context") ||
    normalized.includes("bootstrap_mode") ||
    normalized.includes("context_mode") ||
    normalized.includes("context_profile") ||
    normalized.includes("context_window") ||
    flattened.includes("lightcontext") ||
    flattened.includes("bootstrapcontextmode") ||
    flattened.includes("contextmode") ||
    (normalized.includes("context") && normalized.includes("light")) ||
    (normalized.includes("context") && normalized.includes("profile"))
  );
}

function looksLikeLightContextHintText(rawText) {
  const normalized = toOptionKeyTokenized(rawText);
  if (!normalized) {
    return false;
  }
  const flattened = toOptionKeyFlat(rawText);
  return (
    normalized.includes("light_context") ||
    normalized.includes("bootstrap_context") ||
    normalized.includes("bootstrap_mode") ||
    normalized.includes("context_mode") ||
    normalized.includes("context_profile") ||
    normalized.includes("context_window") ||
    flattened.includes("lightcontext") ||
    flattened.includes("bootstrapcontextmode") ||
    flattened.includes("contextmode") ||
    (normalized.includes("context") && normalized.includes("light")) ||
    (normalized.includes("context") && normalized.includes("profile"))
  );
}

function collectMetadataHintLightContextOptionIds(configOptions) {
  const matched = [];
  for (const option of configOptions || []) {
    const optionId = toOptionalTrimmedString(option && option.id);
    if (!optionId || looksLikeLightContextOptionId(optionId)) {
      continue;
    }
    const hintTexts = [
      toOptionalTrimmedString(option.name),
      toOptionalTrimmedString(option.description),
      toOptionalTrimmedString(option.category)
    ].filter((entry) => typeof entry === "string" && entry.length > 0);
    if (hintTexts.some((entry) => looksLikeLightContextHintText(entry))) {
      matched.push(optionId);
    }
  }
  return [...new Set(matched)].sort((a, b) => a.localeCompare(b));
}

function mergeConfigOptions(lists) {
  const mergedById = new Map();
  for (const list of lists || []) {
    for (const option of normalizeConfigOptions(list)) {
      const key = option.id.toLowerCase();
      const existing = mergedById.get(key);
      if (!existing) {
        mergedById.set(key, {
          id: option.id,
          type: option.type,
          name: option.name,
          description: option.description,
          category: option.category,
          values: [...option.values]
        });
        continue;
      }
      const mergedValues = [...new Set([...(existing.values || []), ...option.values])].sort((a, b) =>
        a.localeCompare(b)
      );
      mergedById.set(key, {
        id: existing.id || option.id,
        type: existing.type || option.type,
        name: existing.name || option.name,
        description: existing.description || option.description,
        category: existing.category || option.category,
        values: mergedValues
      });
    }
  }
  return [...mergedById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function firstNonEmptyLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[0] || null;
}

function probeAcpxVersion(options) {
  const attempts = [["--version"], ["version"], ["-V"]];
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs, 5_000));
  const failures = [];

  for (const args of attempts) {
    const run = spawnSync(options.acpxCommand, args, {
      cwd: options.acpxCwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_STDIO_BUFFER
    });
    const stdout = String(run.stdout || "");
    const stderr = String(run.stderr || "");
    const text = firstNonEmptyLine(stdout) || firstNonEmptyLine(stderr);
    const exitCode = typeof run.status === "number" ? run.status : null;
    if (run.error) {
      failures.push(`${args.join(" ")}: ${run.error.message || String(run.error)}`);
      continue;
    }
    if (exitCode === 0 && text) {
      return {
        version: text,
        commandArgs: args,
        exitCode,
        warning: null
      };
    }
    if (exitCode === 0) {
      return {
        version: null,
        commandArgs: args,
        exitCode,
        warning: "version probe returned success without output"
      };
    }
    failures.push(`${args.join(" ")}: exit=${String(exitCode)} ${toOptionalTrimmedString(stderr) || ""}`.trim());
  }

  return {
    version: null,
    commandArgs: null,
    exitCode: null,
    warning: failures.length > 0 ? failures.join(" | ") : "version probe failed"
  };
}

function toSha256Hex(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function loadPreviousResultFile(previousResultFile) {
  if (!previousResultFile) {
    return {
      file: null,
      loaded: false,
      warning: null,
      acpxVersion: null,
      capabilityFingerprint: null
    };
  }

  try {
    const raw = fs.readFileSync(previousResultFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        file: previousResultFile,
        loaded: false,
        warning: "previous result file must contain a JSON object",
        acpxVersion: null,
        capabilityFingerprint: null
      };
    }
    const acpxVersion = toOptionalTrimmedString(parsed.acpxVersion);
    const capabilityFingerprint = toOptionalTrimmedString(parsed.capabilityFingerprint);
    if (!acpxVersion && !capabilityFingerprint) {
      return {
        file: previousResultFile,
        loaded: true,
        warning: "previous result file does not include acpxVersion/capabilityFingerprint",
        acpxVersion: null,
        capabilityFingerprint: null
      };
    }
    return {
      file: previousResultFile,
      loaded: true,
      warning: null,
      acpxVersion,
      capabilityFingerprint
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      file: previousResultFile,
      loaded: false,
      warning: message,
      acpxVersion: null,
      capabilityFingerprint: null
    };
  }
}

function writeResultFile(outputPath, payload) {
  if (!outputPath) {
    return {
      file: null,
      written: false,
      warning: null
    };
  }
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    return {
      file: outputPath,
      written: true,
      warning: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      file: outputPath,
      written: false,
      warning: message
    };
  }
}

function promoteWriteResultFileToPrevious(params) {
  const sourceFile = toOptionalTrimmedString(params.sourceFile);
  const targetFile = toOptionalTrimmedString(params.targetFile);
  const state = {
    requested: params.enabled === true,
    sourceFile: sourceFile ? path.resolve(sourceFile) : null,
    targetFile: targetFile ? path.resolve(targetFile) : null,
    saved: false,
    noop: false,
    warning: null
  };

  if (!state.requested) {
    return state;
  }
  if (!state.sourceFile) {
    state.warning = "write result file path is missing";
    return state;
  }
  if (!params.sourceWritten) {
    state.warning = "write result file was not saved";
    return state;
  }
  if (!state.targetFile) {
    state.warning = "previous result file path is missing";
    return state;
  }
  if (state.sourceFile === state.targetFile) {
    state.saved = true;
    state.noop = true;
    return state;
  }

  try {
    fs.mkdirSync(path.dirname(state.targetFile), { recursive: true });
    fs.copyFileSync(state.sourceFile, state.targetFile);
    state.saved = true;
    return state;
  } catch (error) {
    state.warning = error instanceof Error ? error.message : String(error);
    return state;
  }
}

function extractLightContextOutcome(payload, lightContext) {
  const token = `lightContext=${lightContext ? "true" : "false"}`;
  const applied = normalizeStringArray(payload && payload.runtimeOptionApplied);
  const warnings = normalizeStringArray(payload && payload.runtimeOptionWarnings);
  const lightContextCandidatesTried = normalizeStringArray(
    payload && payload.runtimeOptionLightContextCandidatesTried
  );
  const lightContextAttemptLog = normalizeStringArray(
    payload && payload.runtimeOptionLightContextAttemptLog
  );
  const discoveredConfigOptionIds = normalizeStringArray(
    payload && payload.runtimeOptionDiscoveredConfigOptionIds
  );
  const discoveredConfigOptions = normalizeConfigOptions(
    payload && payload.runtimeOptionDiscoveredConfigOptions
  );

  const appliedEntry = applied.find((entry) => entry.startsWith(token));
  const warningEntry = warnings.find((entry) => entry.startsWith(`${token} skipped`));

  let setKey = null;
  let setValue = null;
  if (appliedEntry) {
    const matched = appliedEntry.match(/\(set:([^)=]+)(?:=([^)]*))?\)/);
    if (matched) {
      setKey = toOptionalTrimmedString(matched[1]);
      setValue = toOptionalTrimmedString(matched[2]);
    }
  }

  for (const option of discoveredConfigOptions) {
    if (!discoveredConfigOptionIds.includes(option.id)) {
      discoveredConfigOptionIds.push(option.id);
    }
  }
  discoveredConfigOptionIds.sort((a, b) => a.localeCompare(b));
  const supportedKeys = [
    ...new Set([
      ...parseSupportedKeysFromWarning(warningEntry),
      ...discoveredConfigOptionIds
    ])
  ].sort((a, b) => a.localeCompare(b));
  const advertisedLightContextKeys = supportedKeys.filter((key) => looksLikeLightContextOptionId(key));

  return {
    appliedEntry: appliedEntry || null,
    warningEntry: warningEntry || null,
    directSetApplied: Boolean(appliedEntry),
    setKey,
    setValue,
    supportedKeys,
    advertisedLightContextKeys,
    lightContextCandidatesTried,
    lightContextAttemptLog,
    discoveredConfigOptionIds,
    discoveredConfigOptions
  };
}

function runAdapter(options, lightContext) {
  const payload = {
    childSessionKey: buildSessionKey(options.sessionPrefix, lightContext),
    mode: "run",
    task: options.task,
    options: {
      model: options.model,
      thinking: options.thinking,
      lightContext
    }
  };

  const run = spawnSync("node", [options.adapter], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OMNINODE_ACP_ADAPTER_ACPX_COMMAND: options.acpxCommand,
      OMNINODE_ACP_ADAPTER_ACPX_CWD: options.acpxCwd
    },
    encoding: "utf8",
    input: JSON.stringify(payload),
    timeout: options.timeoutMs,
    maxBuffer: MAX_STDIO_BUFFER
  });

  const parsed = parseResultJson(run.stdout);
  const outcome = extractLightContextOutcome(parsed, lightContext);

  return {
    lightContext,
    payload,
    exitCode: typeof run.status === "number" ? run.status : null,
    timedOut: run.error && run.error.code === "ETIMEDOUT",
    processError: run.error ? (run.error.message || String(run.error)) : null,
    stderr: toOptionalTrimmedString(run.stderr),
    stdout: toOptionalTrimmedString(run.stdout),
    parsed,
    parsedStatus: toOptionalTrimmedString(parsed && parsed.status),
    backend: toOptionalTrimmedString(parsed && parsed.backend),
    message: toOptionalTrimmedString(parsed && parsed.message),
    runtimeOptionApplied: normalizeStringArray(parsed && parsed.runtimeOptionApplied),
    runtimeOptionWarnings: normalizeStringArray(parsed && parsed.runtimeOptionWarnings),
    runtimeOptionLightContextCandidatesTried: normalizeStringArray(
      parsed && parsed.runtimeOptionLightContextCandidatesTried
    ),
    runtimeOptionLightContextAttemptLog: normalizeStringArray(
      parsed && parsed.runtimeOptionLightContextAttemptLog
    ),
    runtimeOptionDiscoveredConfigOptionIds: normalizeStringArray(
      parsed && parsed.runtimeOptionDiscoveredConfigOptionIds
    ),
    runtimeOptionDiscoveredConfigOptions: normalizeConfigOptions(
      parsed && parsed.runtimeOptionDiscoveredConfigOptions
    ),
    outcome
  };
}

function evaluateExpectation(expectMode, checks) {
  const directSetStates = checks.map((check) => check.outcome.directSetApplied);
  switch (expectMode) {
    case "true":
      return directSetStates.every(Boolean);
    case "false":
      return directSetStates.every((entry) => !entry);
    default:
      return true;
  }
}

function buildCapabilityFingerprintInput(params) {
  return {
    acpxVersion: params.acpxVersion || null,
    supportedKeys: [...(params.supportedKeys || [])].sort((a, b) => a.localeCompare(b)),
    advertisedLightContextKeys: [...(params.advertisedLightContextKeys || [])].sort((a, b) =>
      a.localeCompare(b)
    ),
    metadataHintLightContextOptionIds: [...(params.metadataHintLightContextOptionIds || [])].sort((a, b) =>
      a.localeCompare(b)
    ),
    discoveredConfigOptions: mergeConfigOptions([params.discoveredConfigOptions || []]).map((option) => ({
      id: option.id,
      type: option.type,
      name: option.name,
      description: option.description,
      category: option.category,
      values: [...option.values].sort((a, b) => a.localeCompare(b))
    }))
  };
}

function main() {
  let options;
  try {
    options = resolveOptions(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, message }, null, 2));
    process.exitCode = 1;
    return;
  }

  const previousResultFileState = loadPreviousResultFile(options.previousResultFile);
  const resolvedPreviousAcpxVersion =
    options.previousAcpxVersion || previousResultFileState.acpxVersion || null;
  const resolvedPreviousCapabilityFingerprint =
    options.previousCapabilityFingerprint || previousResultFileState.capabilityFingerprint || null;
  const previousAcpxVersionSource = options.previousAcpxVersion
    ? "cli_or_env"
    : previousResultFileState.acpxVersion
      ? "previous_result_file"
      : null;
  const previousCapabilityFingerprintSource = options.previousCapabilityFingerprint
    ? "cli_or_env"
    : previousResultFileState.capabilityFingerprint
      ? "previous_result_file"
      : null;

  const acpxVersionProbe = probeAcpxVersion(options);
  const checks = [runAdapter(options, true), runAdapter(options, false)];

  const commandSucceeded = checks.every(
    (check) => check.exitCode === 0 && check.parsedStatus === "accepted"
  );
  const expectationMatched = evaluateExpectation(options.expectLightContextDirectSet, checks);
  const baseOk = commandSucceeded && expectationMatched;

  const supportedKeys = [...new Set(checks.flatMap((check) => check.outcome.supportedKeys))].sort((a, b) =>
    a.localeCompare(b)
  );
  const advertisedLightContextKeys = [
    ...new Set(checks.flatMap((check) => check.outcome.advertisedLightContextKeys))
  ].sort((a, b) => a.localeCompare(b));
  const lightContextCandidatesTried = [
    ...new Set(checks.flatMap((check) => check.outcome.lightContextCandidatesTried))
  ].sort((a, b) => a.localeCompare(b));
  const lightContextAttemptLog = checks
    .flatMap((check) =>
      (check.outcome.lightContextAttemptLog || []).map(
        (entry) => `lightContext=${check.lightContext ? "true" : "false"} :: ${entry}`
      )
    );
  const discoveredConfigOptions = mergeConfigOptions(
    checks.map((check) => check.runtimeOptionDiscoveredConfigOptions)
  );
  const metadataHintLightContextOptionIds = collectMetadataHintLightContextOptionIds(
    discoveredConfigOptions
  );
  const capabilityFingerprintInput = buildCapabilityFingerprintInput({
    acpxVersion: acpxVersionProbe.version,
    supportedKeys,
    advertisedLightContextKeys,
    metadataHintLightContextOptionIds,
    discoveredConfigOptions
  });
  const capabilityFingerprint = toSha256Hex(
    JSON.stringify(capabilityFingerprintInput)
  );
  const capabilityFingerprintChanged =
    resolvedPreviousCapabilityFingerprint
      ? resolvedPreviousCapabilityFingerprint !== capabilityFingerprint
      : null;
  const acpxVersionChanged =
    resolvedPreviousAcpxVersion
      ? resolvedPreviousAcpxVersion !== acpxVersionProbe.version
      : null;
  const revalidationTriggerReasons = [];
  if (acpxVersionChanged === true) {
    revalidationTriggerReasons.push("acpx version changed from previous value");
  }
  if (capabilityFingerprintChanged === true) {
    revalidationTriggerReasons.push("capability fingerprint changed from previous value");
  }
  if (advertisedLightContextKeys.length > 0) {
    revalidationTriggerReasons.push("lightContext-like config key advertised");
  }
  if (metadataHintLightContextOptionIds.length > 0) {
    revalidationTriggerReasons.push("metadata hints suggest context-related config option");
  }
  if (checks.every((check) => check.outcome.directSetApplied)) {
    revalidationTriggerReasons.push("lightContext direct set already detected");
  }

  const result = {
    ok: baseOk,
    commandSucceeded,
    expectationMatched,
    expectLightContextDirectSet: options.expectLightContextDirectSet,
    adapter: options.adapter,
    acpxCommand: options.acpxCommand,
    acpxCwd: options.acpxCwd,
    model: options.model,
    thinking: options.thinking,
    task: options.task,
    timeoutMs: options.timeoutMs,
    promoteWriteResultToPrevious: options.promoteWriteResultToPrevious,
    acpxVersion: acpxVersionProbe.version,
    acpxVersionProbe: {
      commandArgs: acpxVersionProbe.commandArgs,
      exitCode: acpxVersionProbe.exitCode,
      warning: acpxVersionProbe.warning
    },
    previousAcpxVersion: resolvedPreviousAcpxVersion,
    previousAcpxVersionSource,
    previousCapabilityFingerprint: resolvedPreviousCapabilityFingerprint,
    previousCapabilityFingerprintSource,
    previousResultFile: previousResultFileState.file,
    previousResultFileLoaded: previousResultFileState.loaded,
    previousResultFileWarning: previousResultFileState.warning,
    acpxVersionChanged,
    capabilityFingerprint,
    capabilityFingerprintChanged,
    capabilityFingerprintInput,
    shouldRevalidateWithDirectSetExpectation: revalidationTriggerReasons.length > 0,
    revalidationTriggerReasons,
    lightContextDirectSetDetected: checks.every((check) => check.outcome.directSetApplied),
    supportedKeys,
    advertisedLightContextKeys,
    lightContextOptionAdvertised: advertisedLightContextKeys.length > 0,
    metadataHintLightContextOptionIds,
    discoveredConfigOptions,
    lightContextCandidatesTried,
    lightContextAttemptLog,
    checks
  };

  const resultFileState = writeResultFile(options.writeResultFile, result);
  result.writeResultFile = resultFileState.file;
  result.writeResultFileSaved = resultFileState.written;
  result.writeResultFileWarning = resultFileState.warning;
  if (options.writeResultFile && !resultFileState.written) {
    result.ok = false;
  }

  const promotedResultState = promoteWriteResultFileToPrevious({
    enabled: options.promoteWriteResultToPrevious,
    sourceFile: resultFileState.file,
    sourceWritten: resultFileState.written,
    targetFile: options.previousResultFile
  });
  result.promoteWriteResultToPreviousSourceFile = promotedResultState.sourceFile;
  result.promoteWriteResultToPreviousTargetFile = promotedResultState.targetFile;
  result.promoteWriteResultToPreviousSaved = promotedResultState.saved;
  result.promoteWriteResultToPreviousNoop = promotedResultState.noop;
  result.promoteWriteResultToPreviousWarning = promotedResultState.warning;
  if (options.promoteWriteResultToPrevious && !promotedResultState.saved) {
    result.ok = false;
  }

  if (!result.ok) {
    process.exitCode = 1;
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main();
