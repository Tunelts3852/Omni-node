#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_WS_PORT = "18152";
const WS_PORT_AUTO = "auto";
const PROFILE_LIVE_SUCCESS = "live-success";
const LIVE_SUCCESS_HTTP_MAX_ATTEMPTS = 6;
const PROBE_VALIDATION_MAX_ATTEMPTS = 4;
const PROBE_VALIDATION_RETRY_DELAY_MS = 120;
const LISTENER_READY_DEFAULT_TIMEOUT_MS = 5000;
const LISTENER_READY_MIN_POLL_MS = 50;

function parsePositiveInteger(rawValue) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function printUsage() {
  console.error(
    "Usage: node omninode-middleware/run-startup-probe-validation.js " +
      "--runtime-dir <path> [--project <csproj>] [--ws-port <port|auto>] " +
      "[--probe-mode <live|mock>] [--profile <auto|live-success|live-environment-blocked|live-permission-blocked|mock-success>] " +
      "[--timeout-sec <sec>] [--poll-ms <ms>] [--require-hint] " +
      "[--expect-profile <live-success|live-environment-blocked|live-permission-blocked|mock-success>] " +
      "[--expect-validation-hint <live-success|live-environment-blocked|live-permission-blocked|mock-success>] " +
      "[--expect-auto-fallback <true|false>] " +
      "[--expect-allocation-error <present|absent>] " +
      "[--expect-listener-ready <true|false>] " +
      "[--expect-readyz-transition <true|false>] " +
      "[--skip-prebuild]"
  );
}

function parseArgs(argv) {
  const args = {
    runtimeDir: "",
    project: path.resolve(__dirname, "OmniNode.Middleware.csproj"),
    wsPort: process.env.OMNINODE_WS_PORT || DEFAULT_WS_PORT,
    probeMode: process.env.OMNINODE_GATEWAY_STARTUP_PROBE_MODE || "live",
    profile: "auto",
    expectProfile: "",
    expectValidationHint: "",
    expectAutoFallback: "",
    expectAllocationError: "",
    expectListenerReady: "",
    expectReadyzTransition: "",
    timeoutSec: "8",
    pollMs: "150",
    requireHint: false,
    skipPrebuild: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--runtime-dir" && i + 1 < argv.length) {
      args.runtimeDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--project" && i + 1 < argv.length) {
      args.project = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--ws-port" && i + 1 < argv.length) {
      args.wsPort = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--probe-mode" && i + 1 < argv.length) {
      args.probeMode = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--profile" && i + 1 < argv.length) {
      args.profile = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--expect-profile" && i + 1 < argv.length) {
      args.expectProfile = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--expect-validation-hint" && i + 1 < argv.length) {
      args.expectValidationHint = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--expect-auto-fallback" && i + 1 < argv.length) {
      args.expectAutoFallback = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--expect-allocation-error" && i + 1 < argv.length) {
      args.expectAllocationError = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--expect-listener-ready" && i + 1 < argv.length) {
      args.expectListenerReady = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--expect-readyz-transition" && i + 1 < argv.length) {
      args.expectReadyzTransition = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--timeout-sec" && i + 1 < argv.length) {
      args.timeoutSec = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--poll-ms" && i + 1 < argv.length) {
      args.pollMs = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--require-hint") {
      args.requireHint = true;
      continue;
    }

    if (token === "--skip-prebuild") {
      args.skipPrebuild = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return args;
}

async function allocateFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("failed to allocate free port");
  }

  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function resolveDefaultWsPort() {
  const fromEnv = typeof process.env.OMNINODE_WS_PORT === "string"
    ? process.env.OMNINODE_WS_PORT.trim()
    : "";
  if (fromEnv && fromEnv.toLowerCase() !== WS_PORT_AUTO) {
    try {
      return parseWsPort(fromEnv).selected;
    } catch {
      // keep default fallback
    }
  }

  return DEFAULT_WS_PORT;
}

function parseWsPort(rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) {
    throw new Error("ws-port is empty");
  }

  if (value.toLowerCase() === WS_PORT_AUTO) {
    return {
      auto: true,
      requested: WS_PORT_AUTO,
      selected: null,
      autoFallback: false,
      allocationError: null
    };
  }

  const parsed = Number.parseInt(value, 10);
  const isInvalid = !Number.isFinite(parsed) || parsed <= 0 || parsed > 65535;
  if (isInvalid) {
    throw new Error(`invalid ws-port: ${value} (expected 1-65535 or "auto")`);
  }

  return {
    auto: false,
    requested: value,
    selected: String(parsed),
    autoFallback: false,
    allocationError: null
  };
}

async function resolveWsPort(rawValue) {
  const parsed = parseWsPort(rawValue);
  if (!parsed.auto) {
    return parsed;
  }

  try {
    const selectedPort = await allocateFreePort();
    return {
      auto: true,
      requested: parsed.requested,
      selected: String(selectedPort),
      autoFallback: false,
      allocationError: null
    };
  } catch (error) {
    return {
      auto: true,
      requested: parsed.requested,
      selected: resolveDefaultWsPort(),
      autoFallback: true,
      allocationError: error && error.message ? error.message : String(error)
    };
  }
}

function parseJsonFromOutput(text) {
  if (typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.startsWith("{")) {
        continue;
      }
      try {
        return JSON.parse(line);
      } catch {
        // continue
      }
    }
  }

  return null;
}

function parseValidationPayload(validationResult) {
  if (!validationResult) {
    return null;
  }

  const fromStdout = parseJsonFromOutput(validationResult.stdout);
  if (fromStdout) {
    return fromStdout;
  }

  return parseJsonFromOutput(validationResult.stderr);
}

function extractValidationFailures(validationPayload) {
  if (!validationPayload || !Array.isArray(validationPayload.failures)) {
    return [];
  }

  return validationPayload.failures.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function isRetryableValidationFailure(validationPayload) {
  const failures = extractValidationFailures(validationPayload);
  if (failures.length === 0) {
    return false;
  }

  return failures.every((failure) => failure.startsWith("log must contain "));
}

function evaluateProfileExpectation(expectedProfileRaw, validationPayload, validationExitCode) {
  const expectedProfile = typeof expectedProfileRaw === "string" ? expectedProfileRaw.trim() : "";
  if (!expectedProfile) {
    return {
      enabled: false,
      expectedProfile: null,
      actualProfile: null,
      matched: true,
      reason: null
    };
  }

  const actualProfile = validationPayload && typeof validationPayload.effectiveProfile === "string"
    ? validationPayload.effectiveProfile
    : null;
  if (validationExitCode === null) {
    return {
      enabled: true,
      expectedProfile,
      actualProfile,
      matched: false,
      reason: "validation_not_executed"
    };
  }

  if (!actualProfile) {
    return {
      enabled: true,
      expectedProfile,
      actualProfile,
      matched: false,
      reason: "effective_profile_missing"
    };
  }

  if (actualProfile !== expectedProfile) {
    return {
      enabled: true,
      expectedProfile,
      actualProfile,
      matched: false,
      reason: "effective_profile_mismatch"
    };
  }

  return {
    enabled: true,
    expectedProfile,
    actualProfile,
    matched: true,
    reason: null
  };
}

function parseExpectedBoolean(rawValue, optionName) {
  const normalized = typeof rawValue === "string" ? rawValue.trim().toLowerCase() : "";
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error(`invalid ${optionName}: ${rawValue} (expected true|false)`);
}

function evaluateValidationHintExpectation(expectedHintRaw, probePayload, profileExpectation) {
  const expectedRaw = typeof expectedHintRaw === "string" ? expectedHintRaw.trim() : "";
  const actualHint = probePayload && typeof probePayload.validationProfileHint === "string"
    ? probePayload.validationProfileHint.trim()
    : "";

  let expectedHint = null;
  let enabled = false;
  let inferred = false;

  if (expectedRaw) {
    expectedHint = expectedRaw;
    enabled = true;
  } else if (
    profileExpectation
    && profileExpectation.enabled
    && typeof profileExpectation.expectedProfile === "string"
    && profileExpectation.expectedProfile.trim().length > 0
  ) {
    expectedHint = profileExpectation.expectedProfile.trim();
    enabled = true;
    inferred = true;
  }

  if (!enabled) {
    return {
      enabled: false,
      inferred,
      expectedHint: null,
      actualHint: actualHint || null,
      matched: true,
      reason: null
    };
  }

  if (!actualHint) {
    return {
      enabled: true,
      inferred,
      expectedHint,
      actualHint: null,
      matched: false,
      reason: "probe_validation_hint_missing"
    };
  }

  if (actualHint !== expectedHint) {
    return {
      enabled: true,
      inferred,
      expectedHint,
      actualHint,
      matched: false,
      reason: "probe_validation_hint_mismatch"
    };
  }

  return {
    enabled: true,
    inferred,
    expectedHint,
    actualHint,
    matched: true,
    reason: null
  };
}

function evaluateAutoFallbackExpectation(
  expectedAutoFallbackRaw,
  wsPortResolution,
  validationPayload,
  profileExpectation
) {
  const requestedAuto = wsPortResolution.requested === WS_PORT_AUTO;
  const actualAutoFallback = wsPortResolution.autoFallback === true;
  const expectedRaw = typeof expectedAutoFallbackRaw === "string"
    ? expectedAutoFallbackRaw.trim()
    : "";

  let expectedAutoFallback = null;
  let enabled = false;
  let inferred = false;

  if (expectedRaw) {
    expectedAutoFallback = parseExpectedBoolean(expectedRaw, "--expect-auto-fallback");
    enabled = true;
  } else if (
    requestedAuto &&
    shouldEnableLiveHttpExpectation(validationPayload, profileExpectation)
  ) {
    expectedAutoFallback = false;
    enabled = true;
    inferred = true;
  }

  if (!enabled) {
    return {
      enabled: false,
      inferred,
      expectedAutoFallback: null,
      actualAutoFallback,
      matched: true,
      reason: null
    };
  }

  if (actualAutoFallback !== expectedAutoFallback) {
    return {
      enabled: true,
      inferred,
      expectedAutoFallback,
      actualAutoFallback,
      matched: false,
      reason: "auto_fallback_mismatch"
    };
  }

  return {
    enabled: true,
    inferred,
    expectedAutoFallback,
    actualAutoFallback,
    matched: true,
    reason: null
  };
}

function parseAllocationErrorExpectation(rawValue) {
  const normalized = typeof rawValue === "string" ? rawValue.trim().toLowerCase() : "";
  if (normalized === "present" || normalized === "absent") {
    return normalized;
  }

  throw new Error(`invalid --expect-allocation-error: ${rawValue} (expected present|absent)`);
}

function evaluateAllocationErrorExpectation(
  expectedAllocationErrorRaw,
  wsPortResolution,
  validationPayload,
  profileExpectation
) {
  const expectedRaw = typeof expectedAllocationErrorRaw === "string"
    ? expectedAllocationErrorRaw.trim()
    : "";
  const actualAllocationError = typeof wsPortResolution.allocationError === "string"
    ? wsPortResolution.allocationError.trim()
    : "";
  const actualHasAllocationError = actualAllocationError.length > 0;
  const requestedAuto = wsPortResolution.requested === WS_PORT_AUTO;
  let expectedPresence = null;
  let enabled = false;
  let inferred = false;

  if (expectedRaw) {
    expectedPresence = parseAllocationErrorExpectation(expectedRaw);
    enabled = true;
  } else if (
    requestedAuto &&
    shouldEnableLiveHttpExpectation(validationPayload, profileExpectation)
  ) {
    expectedPresence = "absent";
    enabled = true;
    inferred = true;
  }

  if (!enabled) {
    return {
      enabled: false,
      inferred,
      expectedPresence: null,
      actualHasAllocationError,
      actualAllocationError: actualHasAllocationError ? actualAllocationError : null,
      matched: true,
      reason: null
    };
  }

  const expectedHasAllocationError = expectedPresence === "present";
  if (actualHasAllocationError !== expectedHasAllocationError) {
    return {
      enabled: true,
      inferred,
      expectedPresence,
      actualHasAllocationError,
      actualAllocationError: actualHasAllocationError ? actualAllocationError : null,
      matched: false,
      reason: expectedHasAllocationError ? "allocation_error_missing" : "allocation_error_present"
    };
  }

  return {
    enabled: true,
    inferred,
    expectedPresence,
    actualHasAllocationError,
    actualAllocationError: actualHasAllocationError ? actualAllocationError : null,
    matched: true,
    reason: null
  };
}

function evaluateListenerReadinessExpectation(
  expectedListenerReadyRaw,
  listenerReadiness,
  validationPayload,
  profileExpectation,
  probePayload,
  healthPayload
) {
  const expectedRaw = typeof expectedListenerReadyRaw === "string"
    ? expectedListenerReadyRaw.trim()
    : "";
  const actualReadyFromTcp = listenerReadiness && listenerReadiness.enabled === true
    ? listenerReadiness.ready === true
    : null;
  const allowHealthSnapshotFallback = shouldEnableLiveHttpExpectation(
    validationPayload,
    profileExpectation
  );
  const healthSnapshotEvidence = allowHealthSnapshotFallback
    ? parseHealthListenerReadinessEvidence(probePayload, healthPayload)
    : {
        available: false,
        status: null,
        listenerBound: null,
        degradedMode: null,
        webSocketReady: null,
        readyReason: null,
        probeMode: null,
        probeResult: null,
        probeAllChecksPassed: null,
        probeEnvironmentBlocked: null,
        inferredReadyFromHealthSnapshot: false,
        probeSupportsLiveReady: false,
        readyObserved: false
      };
  const actualReadyFromHealthSnapshot = allowHealthSnapshotFallback
    ? healthSnapshotEvidence.readyObserved
    : null;
  const usedHealthSnapshotFallback = allowHealthSnapshotFallback
    && actualReadyFromTcp !== true
    && actualReadyFromHealthSnapshot === true;
  let actualReady = null;
  if (actualReadyFromTcp === true || actualReadyFromHealthSnapshot === true) {
    actualReady = true;
  } else if (actualReadyFromTcp === false || actualReadyFromHealthSnapshot === false) {
    actualReady = false;
  }

  let expectedReady = null;
  let enabled = false;
  let inferred = false;

  if (expectedRaw) {
    expectedReady = parseExpectedBoolean(expectedRaw, "--expect-listener-ready");
    enabled = true;
  } else if (shouldEnableLiveHttpExpectation(validationPayload, profileExpectation)) {
    expectedReady = true;
    enabled = true;
    inferred = true;
  }

  if (!enabled) {
    return {
      enabled: false,
      inferred,
      expectedReady: null,
      actualReady,
      actualReadyFromTcp,
      actualReadyFromHealthSnapshot,
      usedHealthSnapshotFallback,
      healthSnapshotListenerEvidence: allowHealthSnapshotFallback
        ? {
            available: healthSnapshotEvidence.available,
            status: healthSnapshotEvidence.status,
            listenerBound: healthSnapshotEvidence.listenerBound,
            degradedMode: healthSnapshotEvidence.degradedMode,
            webSocketReady: healthSnapshotEvidence.webSocketReady,
            readyReason: healthSnapshotEvidence.readyReason,
            probeMode: healthSnapshotEvidence.probeMode,
            probeResult: healthSnapshotEvidence.probeResult,
            probeAllChecksPassed: healthSnapshotEvidence.probeAllChecksPassed,
            probeEnvironmentBlocked: healthSnapshotEvidence.probeEnvironmentBlocked,
            inferredReadyFromHealthSnapshot: healthSnapshotEvidence.inferredReadyFromHealthSnapshot,
            probeSupportsLiveReady: healthSnapshotEvidence.probeSupportsLiveReady
          }
        : null,
      matched: true,
      reason: null
    };
  }

  if (actualReady === null) {
    return {
      enabled: true,
      inferred,
      expectedReady,
      actualReady,
      actualReadyFromTcp,
      actualReadyFromHealthSnapshot,
      usedHealthSnapshotFallback,
      healthSnapshotListenerEvidence: allowHealthSnapshotFallback
        ? {
            available: healthSnapshotEvidence.available,
            status: healthSnapshotEvidence.status,
            listenerBound: healthSnapshotEvidence.listenerBound,
            degradedMode: healthSnapshotEvidence.degradedMode,
            webSocketReady: healthSnapshotEvidence.webSocketReady,
            readyReason: healthSnapshotEvidence.readyReason,
            probeMode: healthSnapshotEvidence.probeMode,
            probeResult: healthSnapshotEvidence.probeResult,
            probeAllChecksPassed: healthSnapshotEvidence.probeAllChecksPassed,
            probeEnvironmentBlocked: healthSnapshotEvidence.probeEnvironmentBlocked,
            inferredReadyFromHealthSnapshot: healthSnapshotEvidence.inferredReadyFromHealthSnapshot,
            probeSupportsLiveReady: healthSnapshotEvidence.probeSupportsLiveReady
          }
        : null,
      matched: false,
      reason: "listener_readiness_unavailable"
    };
  }

  if (actualReady !== expectedReady) {
    return {
      enabled: true,
      inferred,
      expectedReady,
      actualReady,
      actualReadyFromTcp,
      actualReadyFromHealthSnapshot,
      usedHealthSnapshotFallback,
      healthSnapshotListenerEvidence: allowHealthSnapshotFallback
        ? {
            available: healthSnapshotEvidence.available,
            status: healthSnapshotEvidence.status,
            listenerBound: healthSnapshotEvidence.listenerBound,
            degradedMode: healthSnapshotEvidence.degradedMode,
            webSocketReady: healthSnapshotEvidence.webSocketReady,
            readyReason: healthSnapshotEvidence.readyReason,
            probeMode: healthSnapshotEvidence.probeMode,
            probeResult: healthSnapshotEvidence.probeResult,
            probeAllChecksPassed: healthSnapshotEvidence.probeAllChecksPassed,
            probeEnvironmentBlocked: healthSnapshotEvidence.probeEnvironmentBlocked,
            inferredReadyFromHealthSnapshot: healthSnapshotEvidence.inferredReadyFromHealthSnapshot,
            probeSupportsLiveReady: healthSnapshotEvidence.probeSupportsLiveReady
          }
        : null,
      matched: false,
      reason: "listener_ready_mismatch"
    };
  }

  return {
    enabled: true,
    inferred,
    expectedReady,
    actualReady,
    actualReadyFromTcp,
    actualReadyFromHealthSnapshot,
    usedHealthSnapshotFallback,
    healthSnapshotListenerEvidence: allowHealthSnapshotFallback
      ? {
          available: healthSnapshotEvidence.available,
          status: healthSnapshotEvidence.status,
          listenerBound: healthSnapshotEvidence.listenerBound,
          degradedMode: healthSnapshotEvidence.degradedMode,
          webSocketReady: healthSnapshotEvidence.webSocketReady,
          readyReason: healthSnapshotEvidence.readyReason,
          probeMode: healthSnapshotEvidence.probeMode,
          probeResult: healthSnapshotEvidence.probeResult,
          probeAllChecksPassed: healthSnapshotEvidence.probeAllChecksPassed,
          probeEnvironmentBlocked: healthSnapshotEvidence.probeEnvironmentBlocked,
          inferredReadyFromHealthSnapshot: healthSnapshotEvidence.inferredReadyFromHealthSnapshot,
          probeSupportsLiveReady: healthSnapshotEvidence.probeSupportsLiveReady
        }
      : null,
    matched: true,
    reason: null
  };
}

function parseHealthListenerReadinessEvidence(probePayload, healthPayload) {
  const status = healthPayload && typeof healthPayload.status === "string"
    ? healthPayload.status.trim()
    : null;
  const listenerBound = healthPayload && typeof healthPayload.listenerBound === "boolean"
    ? healthPayload.listenerBound
    : null;
  const degradedMode = healthPayload && typeof healthPayload.degradedMode === "boolean"
    ? healthPayload.degradedMode
    : null;
  const webSocketReady = healthPayload && typeof healthPayload.webSocketReady === "boolean"
    ? healthPayload.webSocketReady
    : null;
  const readyReason = healthPayload && typeof healthPayload.readyReason === "string"
    ? healthPayload.readyReason
    : null;
  const probeMode = probePayload && typeof probePayload.probeMode === "string"
    ? probePayload.probeMode
    : null;
  const probeResult = probePayload && typeof probePayload.result === "string"
    ? probePayload.result
    : null;
  const probeAllChecksPassed = probePayload && typeof probePayload.allChecksPassed === "boolean"
    ? probePayload.allChecksPassed
    : null;
  const probeEnvironmentBlocked = probePayload && typeof probePayload.environmentBlocked === "boolean"
    ? probePayload.environmentBlocked
    : null;
  const inferredReadyFromHealthSnapshot = status === "ok"
    && listenerBound === true
    && degradedMode === false
    && webSocketReady === true;
  const probeSupportsLiveReady = probeMode === "live"
    && probeResult === "ok"
    && probeAllChecksPassed === true
    && probeEnvironmentBlocked === false;
  return {
    available: status !== null
      || listenerBound !== null
      || degradedMode !== null
      || webSocketReady !== null
      || readyReason !== null
      || probeMode !== null
      || probeResult !== null
      || probeAllChecksPassed !== null
      || probeEnvironmentBlocked !== null,
    status,
    listenerBound,
    degradedMode,
    webSocketReady,
    readyReason,
    probeMode,
    probeResult,
    probeAllChecksPassed,
    probeEnvironmentBlocked,
    inferredReadyFromHealthSnapshot,
    probeSupportsLiveReady,
    readyObserved: inferredReadyFromHealthSnapshot && probeSupportsLiveReady
  };
}

function parseHttpStatusCode(curlStdout) {
  if (typeof curlStdout !== "string" || curlStdout.trim() === "") {
    return null;
  }

  const statusMatches = Array.from(
    curlStdout.matchAll(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})\b/gm)
  );
  if (statusMatches.length === 0) {
    return null;
  }

  const last = statusMatches[statusMatches.length - 1];
  const parsed = Number.parseInt(last[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldEnableLiveHttpExpectation(validationPayload, profileExpectation) {
  const effectiveProfile = validationPayload && typeof validationPayload.effectiveProfile === "string"
    ? validationPayload.effectiveProfile
    : null;
  const expectedProfile = profileExpectation && profileExpectation.enabled
    ? profileExpectation.expectedProfile
    : null;
  return expectedProfile === PROFILE_LIVE_SUCCESS || effectiveProfile === PROFILE_LIVE_SUCCESS;
}

function isExpectedHttpResult(result, expectedStatusCode) {
  return result
    && result.exitCode === 0
    && Number.isInteger(result.httpStatusCode)
    && result.httpStatusCode === expectedStatusCode;
}

function summarizeCurlAttempts(attempts) {
  return attempts.map((attempt, index) => ({
    attempt: index + 1,
    exitCode: attempt.exitCode,
    signal: attempt.signal || null,
    httpStatusCode: Number.isInteger(attempt.httpStatusCode) ? attempt.httpStatusCode : null
  }));
}

function writeCurlAttempts(outputFile, attempts) {
  const blocks = attempts.map((attempt, index) => {
    const lines = [
      `# attempt ${index + 1}`,
      `exitCode=${attempt.exitCode}`,
      `signal=${attempt.signal || "null"}`,
      `httpStatusCode=${Number.isInteger(attempt.httpStatusCode) ? attempt.httpStatusCode : "null"}`,
      "",
      attempt.stdout || "",
      attempt.stderr ? `\n${attempt.stderr}` : ""
    ];
    return lines.join("\n");
  });

  fs.writeFileSync(outputFile, `${blocks.join("\n\n")}\n`, "utf8");
}

function withCurlAttemptMetadata(result, outputFile) {
  const attempts = [result];
  writeCurlAttempts(outputFile, attempts);
  return {
    ...result,
    attemptCount: 1,
    attempts: summarizeCurlAttempts(attempts)
  };
}

async function retryCurlUntilExpectedStatus(
  initialResult,
  url,
  outputFile,
  expectedStatusCode,
  maxAttempts,
  retryDelayMs
) {
  const attempts = [initialResult];
  let latest = initialResult;
  const retryableAttempts = Math.max(1, maxAttempts);
  const delayMs = Math.max(50, retryDelayMs);

  while (attempts.length < retryableAttempts && !isExpectedHttpResult(latest, expectedStatusCode)) {
    await sleep(delayMs);
    latest = runCurl(url, outputFile);
    attempts.push(latest);
  }

  writeCurlAttempts(outputFile, attempts);
  return {
    ...latest,
    attemptCount: attempts.length,
    attempts: summarizeCurlAttempts(attempts)
  };
}

function evaluateLiveHttpExpectation(validationPayload, profileExpectation, healthzResult, readyzResult) {
  const healthzExitCode = healthzResult && Number.isInteger(healthzResult.exitCode)
    ? healthzResult.exitCode
    : null;
  const readyzExitCode = readyzResult && Number.isInteger(readyzResult.exitCode)
    ? readyzResult.exitCode
    : null;
  const healthzStatusCode = healthzResult && Number.isInteger(healthzResult.httpStatusCode)
    ? healthzResult.httpStatusCode
    : null;
  const readyzStatusCode = readyzResult && Number.isInteger(readyzResult.httpStatusCode)
    ? readyzResult.httpStatusCode
    : null;

  const effectiveProfile = validationPayload && typeof validationPayload.effectiveProfile === "string"
    ? validationPayload.effectiveProfile
    : null;
  const expectedProfile = profileExpectation && profileExpectation.enabled
    ? profileExpectation.expectedProfile
    : null;
  const enabled = shouldEnableLiveHttpExpectation(validationPayload, profileExpectation);

  const payload = {
    enabled,
    expectedProfile,
    effectiveProfile,
    required: enabled
      ? {
          healthzExitCode: 0,
          healthzStatusCode: 200,
          readyzExitCode: 0,
          readyzStatusCode: 200
        }
      : null,
    healthzExitCode,
    healthzStatusCode,
    readyzExitCode,
    readyzStatusCode,
    matched: true,
    reason: null
  };

  if (!enabled) {
    return payload;
  }

  const failures = [];
  if (healthzExitCode !== 0) {
    failures.push("healthz_curl_failed");
  } else if (healthzStatusCode !== 200) {
    failures.push("healthz_status_mismatch");
  }

  if (readyzExitCode !== 0) {
    failures.push("readyz_curl_failed");
  } else if (readyzStatusCode !== 200) {
    failures.push("readyz_status_mismatch");
  }

  payload.matched = failures.length === 0;
  payload.reason = failures.length > 0 ? failures.join(",") : null;
  return payload;
}

function parseAttemptHttpStatusSequence(result) {
  if (!result || typeof result !== "object") {
    return [];
  }

  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  const sequence = [];
  for (const attempt of attempts) {
    if (!attempt || typeof attempt !== "object") {
      continue;
    }

    const exitCode = Number.isInteger(attempt.exitCode) ? attempt.exitCode : null;
    const statusCode = Number.isInteger(attempt.httpStatusCode) ? attempt.httpStatusCode : null;
    if (exitCode === 0 && statusCode !== null) {
      sequence.push(statusCode);
    }
  }

  if (sequence.length > 0) {
    return sequence;
  }

  const fallbackExitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
  const fallbackStatusCode = Number.isInteger(result.httpStatusCode) ? result.httpStatusCode : null;
  if (fallbackExitCode === 0 && fallbackStatusCode !== null) {
    return [fallbackStatusCode];
  }

  return [];
}

function hasStatusTransition(sequence, fromStatus, toStatus) {
  let foundFrom = false;
  for (const status of sequence) {
    if (!foundFrom && status === fromStatus) {
      foundFrom = true;
      continue;
    }

    if (foundFrom && status === toStatus) {
      return true;
    }
  }

  return false;
}

function parseProbeReadyzTransitionEvidence(probePayload) {
  if (!probePayload || typeof probePayload !== "object") {
    return {
      available: false,
      readyzBefore: null,
      readyzAfter: null,
      readyzTransitionOk: null,
      inferredTransitionFromCodes: false,
      transitionObserved: false
    };
  }

  const readyzBefore = Number.isInteger(probePayload.readyzBefore)
    ? probePayload.readyzBefore
    : null;
  const readyzAfter = Number.isInteger(probePayload.readyzAfter)
    ? probePayload.readyzAfter
    : null;
  const readyzTransitionOk = typeof probePayload.readyzTransitionOk === "boolean"
    ? probePayload.readyzTransitionOk
    : null;
  const inferredTransitionFromCodes = readyzBefore === 503 && readyzAfter === 200;
  const transitionObserved = readyzTransitionOk === true || inferredTransitionFromCodes;
  return {
    available: readyzTransitionOk !== null || readyzBefore !== null || readyzAfter !== null,
    readyzBefore,
    readyzAfter,
    readyzTransitionOk,
    inferredTransitionFromCodes,
    transitionObserved
  };
}

function evaluateReadyzTransitionExpectation(
  expectedReadyzTransitionRaw,
  readyzResult,
  validationPayload,
  profileExpectation,
  probePayload
) {
  const expectedRaw = typeof expectedReadyzTransitionRaw === "string"
    ? expectedReadyzTransitionRaw.trim()
    : "";
  const observedStatusSequence = parseAttemptHttpStatusSequence(readyzResult);
  const actualTransitionFromHttp = hasStatusTransition(observedStatusSequence, 503, 200);
  const allowProbeSnapshotFallback = shouldEnableLiveHttpExpectation(
    validationPayload,
    profileExpectation
  );
  const probeTransitionEvidence = allowProbeSnapshotFallback
    ? parseProbeReadyzTransitionEvidence(probePayload)
    : {
        available: false,
        readyzBefore: null,
        readyzAfter: null,
        readyzTransitionOk: null,
        inferredTransitionFromCodes: false,
        transitionObserved: false
      };
  const actualTransition = actualTransitionFromHttp || probeTransitionEvidence.transitionObserved;
  const usedProbeSnapshotFallback = allowProbeSnapshotFallback
    && !actualTransitionFromHttp
    && probeTransitionEvidence.transitionObserved;

  let expectedTransition = null;
  let enabled = false;
  let inferred = false;
  if (expectedRaw) {
    expectedTransition = parseExpectedBoolean(expectedRaw, "--expect-readyz-transition");
    enabled = true;
  } else if (shouldEnableLiveHttpExpectation(validationPayload, profileExpectation)) {
    expectedTransition = true;
    enabled = true;
    inferred = true;
  }

  if (!enabled) {
    return {
      enabled: false,
      inferred,
      expectedTransition: null,
      actualTransition,
      actualTransitionFromHttp,
      actualTransitionFromProbeSnapshot: allowProbeSnapshotFallback
        ? probeTransitionEvidence.transitionObserved
        : null,
      usedProbeSnapshotFallback,
      probeSnapshotTransitionEvidence: allowProbeSnapshotFallback
        ? {
            available: probeTransitionEvidence.available,
            readyzBefore: probeTransitionEvidence.readyzBefore,
            readyzAfter: probeTransitionEvidence.readyzAfter,
            readyzTransitionOk: probeTransitionEvidence.readyzTransitionOk,
            inferredTransitionFromCodes: probeTransitionEvidence.inferredTransitionFromCodes
          }
        : null,
      transitionWindow: {
        from: 503,
        to: 200
      },
      observedStatusSequence,
      matched: true,
      reason: null
    };
  }

  if (actualTransition !== expectedTransition) {
    return {
      enabled: true,
      inferred,
      expectedTransition,
      actualTransition,
      actualTransitionFromHttp,
      actualTransitionFromProbeSnapshot: allowProbeSnapshotFallback
        ? probeTransitionEvidence.transitionObserved
        : null,
      usedProbeSnapshotFallback,
      probeSnapshotTransitionEvidence: allowProbeSnapshotFallback
        ? {
            available: probeTransitionEvidence.available,
            readyzBefore: probeTransitionEvidence.readyzBefore,
            readyzAfter: probeTransitionEvidence.readyzAfter,
            readyzTransitionOk: probeTransitionEvidence.readyzTransitionOk,
            inferredTransitionFromCodes: probeTransitionEvidence.inferredTransitionFromCodes
          }
        : null,
      transitionWindow: {
        from: 503,
        to: 200
      },
      observedStatusSequence,
      matched: false,
      reason: expectedTransition
        ? "readyz_transition_not_observed"
        : "readyz_transition_unexpected"
    };
  }

  return {
    enabled: true,
    inferred,
    expectedTransition,
    actualTransition,
    actualTransitionFromHttp,
    actualTransitionFromProbeSnapshot: allowProbeSnapshotFallback
      ? probeTransitionEvidence.transitionObserved
      : null,
    usedProbeSnapshotFallback,
    probeSnapshotTransitionEvidence: allowProbeSnapshotFallback
      ? {
          available: probeTransitionEvidence.available,
          readyzBefore: probeTransitionEvidence.readyzBefore,
          readyzAfter: probeTransitionEvidence.readyzAfter,
          readyzTransitionOk: probeTransitionEvidence.readyzTransitionOk,
          inferredTransitionFromCodes: probeTransitionEvidence.inferredTransitionFromCodes
        }
      : null,
    transitionWindow: {
      from: 503,
      to: 200
    },
    observedStatusSequence,
    matched: true,
    reason: null
  };
}

function summarizeProbePayload(probePayload) {
  if (!probePayload || typeof probePayload !== "object") {
    return null;
  }

  return {
    result: probePayload.result ?? null,
    reasonCode: probePayload.reasonCode ?? null,
    probeMode: probePayload.probeMode ?? null,
    simulated: probePayload.simulated ?? null,
    validationProfileHint: probePayload.validationProfileHint ?? null,
    allChecksPassed: probePayload.allChecksPassed ?? null,
    healthz: probePayload.healthz ?? null,
    healthzOk: probePayload.healthzOk ?? null,
    readyzBefore: probePayload.readyzBefore ?? null,
    readyzBeforeOk: probePayload.readyzBeforeOk ?? null,
    wsPingPong: probePayload.wsPingPong ?? null,
    wsPingPongOk: probePayload.wsPingPongOk ?? null,
    readyzAfter: probePayload.readyzAfter ?? null,
    readyzAfterOk: probePayload.readyzAfterOk ?? null,
    readyzTransitionOk: probePayload.readyzTransitionOk ?? null,
    gatewayWebSocketRoundTripCount: probePayload.gatewayWebSocketRoundTripCount ?? null,
    gatewayWebSocketRoundTripOk: probePayload.gatewayWebSocketRoundTripOk ?? null,
    environmentBlocked: probePayload.environmentBlocked ?? null,
    transition: probePayload.transition ?? null,
    failedChecks: probePayload.failedChecks ?? null
  };
}

function evaluateLiveProbeExpectation(validationPayload, profileExpectation, probePayload) {
  const effectiveProfile = validationPayload && typeof validationPayload.effectiveProfile === "string"
    ? validationPayload.effectiveProfile
    : null;
  const expectedProfile = profileExpectation && profileExpectation.enabled
    ? profileExpectation.expectedProfile
    : null;
  const enabled = shouldEnableLiveHttpExpectation(validationPayload, profileExpectation);
  const observed = summarizeProbePayload(probePayload);

  const payload = {
    enabled,
    expectedProfile,
    effectiveProfile,
    required: enabled
      ? {
          result: "ok",
          reasonCode: "all_checks_passed",
          probeMode: "live",
          simulated: false,
          validationProfileHint: "live-success",
          environmentBlocked: false,
          allChecksPassed: true,
          healthz: 200,
          readyzBefore: 503,
          wsPingPong: "ok",
          readyzAfter: 200,
          readyzTransitionOk: true,
          gatewayWebSocketRoundTripCount: ">0",
          gatewayWebSocketRoundTripOk: true
        }
      : null,
    observed,
    matched: true,
    reason: null,
    failures: []
  };

  if (!enabled) {
    return payload;
  }

  const failures = [];
  if (!observed) {
    failures.push("probe_payload_missing");
  } else {
    if (observed.result !== "ok") {
      failures.push("probe_result_mismatch");
    }
    if (observed.reasonCode !== "all_checks_passed") {
      failures.push("probe_reason_code_mismatch");
    }
    if (observed.probeMode !== "live") {
      failures.push("probe_mode_mismatch");
    }
    if (observed.simulated !== false) {
      failures.push("probe_simulated_mismatch");
    }
    if (observed.validationProfileHint !== "live-success") {
      failures.push("probe_validation_profile_hint_mismatch");
    }
    if (observed.environmentBlocked !== false) {
      failures.push("probe_environment_blocked_mismatch");
    }
    if (observed.allChecksPassed !== true) {
      failures.push("probe_all_checks_failed");
    }
    if (observed.healthz !== 200 || observed.healthzOk !== true) {
      failures.push("probe_healthz_mismatch");
    }
    if (observed.readyzBefore !== 503 || observed.readyzBeforeOk !== true) {
      failures.push("probe_readyz_before_mismatch");
    }
    if (observed.wsPingPong !== "ok" || observed.wsPingPongOk !== true) {
      failures.push("probe_ws_ping_pong_mismatch");
    }
    if (observed.readyzAfter !== 200 || observed.readyzAfterOk !== true) {
      failures.push("probe_readyz_after_mismatch");
    }
    if (observed.readyzTransitionOk !== true) {
      failures.push("probe_readyz_transition_mismatch");
    }
    if (
      typeof observed.gatewayWebSocketRoundTripCount !== "number"
      || observed.gatewayWebSocketRoundTripCount <= 0
    ) {
      failures.push("probe_gateway_roundtrip_count_mismatch");
    }
    if (observed.gatewayWebSocketRoundTripOk !== true) {
      failures.push("probe_gateway_roundtrip_flag_mismatch");
    }
  }

  payload.matched = failures.length === 0;
  payload.reason = failures.length > 0 ? failures.join(",") : null;
  payload.failures = failures;
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeTcpPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = (ok, error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({ ok, error: error || null });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, null));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (error) => {
      const message = error && error.message ? error.message : String(error);
      finish(false, message);
    });
  });
}

async function waitForPortOpen(child, portValue, timeoutMs, pollMs) {
  const parsedPort = parsePositiveInteger(portValue);
  if (parsedPort === null) {
    return {
      enabled: false,
      host: "127.0.0.1",
      port: null,
      timeoutMs,
      pollMs,
      ready: false,
      reason: "invalid_port",
      attemptCount: 0,
      elapsedMs: 0,
      firstError: null,
      lastError: null
    };
  }

  const startedAt = Date.now();
  let attemptCount = 0;
  let firstError = null;
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      return {
        enabled: true,
        host: "127.0.0.1",
        port: parsedPort,
        timeoutMs,
        pollMs,
        ready: false,
        reason: `server_exited_early:${child.exitCode}`,
        attemptCount,
        elapsedMs: Date.now() - startedAt,
        firstError,
        lastError
      };
    }

    attemptCount += 1;
    const probe = await probeTcpPort("127.0.0.1", parsedPort, Math.max(100, pollMs));
    if (probe.ok) {
      return {
        enabled: true,
        host: "127.0.0.1",
        port: parsedPort,
        timeoutMs,
        pollMs,
        ready: true,
        reason: "connected",
        attemptCount,
        elapsedMs: Date.now() - startedAt,
        firstError,
        lastError
      };
    }

    if (!firstError) {
      firstError = probe.error;
    }
    lastError = probe.error;
    await sleep(pollMs);
  }

  return {
    enabled: true,
    host: "127.0.0.1",
    port: parsedPort,
    timeoutMs,
    pollMs,
    ready: false,
    reason: "timeout",
    attemptCount,
    elapsedMs: Date.now() - startedAt,
    firstError,
    lastError
  };
}

function readTail(filePath, maxBytes = 2048) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function runCurl(url, outputFile) {
  const result = spawnSync(
    "curl",
    ["-sS", "-m", "2", "-i", url],
    { encoding: "utf8" }
  );

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  fs.writeFileSync(outputFile, stdout + (stderr ? `\n${stderr}` : ""), "utf8");

  return {
    url,
    exitCode: result.status,
    signal: result.signal || null,
    httpStatusCode: parseHttpStatusCode(stdout),
    stdout,
    stderr
  };
}

function runProbeValidation(args, stateFile, logFile, healthFile) {
  const checkScript = path.resolve(__dirname, "check-startup-probe-state.js");
  const commandArgs = [
    checkScript,
    "--file",
    stateFile,
    "--profile",
    args.profile,
    "--log-file",
    logFile,
    "--health-file",
    healthFile
  ];
  if (args.requireHint) {
    commandArgs.push("--require-hint");
  }

  const result = spawnSync(process.execPath, commandArgs, {
    encoding: "utf8"
  });

  return {
    command: [process.execPath, ...commandArgs].join(" "),
    exitCode: result.status,
    signal: result.signal || null,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function runPrebuild(projectPath) {
  const commandArgs = [
    "build",
    projectPath,
    "-p:NuGetAudit=false",
    "-p:NuGetAuditMode=direct"
  ];
  const result = spawnSync("dotnet", commandArgs, {
    encoding: "utf8"
  });
  return {
    command: ["dotnet", ...commandArgs].join(" "),
    exitCode: result.status,
    signal: result.signal || null,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

async function runProbeValidationWithRetry(args, stateFile, logFile, healthFile) {
  const attempts = [];
  let latestResult = null;
  let latestPayload = null;

  for (let attempt = 1; attempt <= PROBE_VALIDATION_MAX_ATTEMPTS; attempt += 1) {
    latestResult = runProbeValidation(args, stateFile, logFile, healthFile);
    latestPayload = parseValidationPayload(latestResult);
    const failures = extractValidationFailures(latestPayload);
    attempts.push({
      attempt,
      exitCode: latestResult.exitCode,
      signal: latestResult.signal || null,
      ok: latestPayload ? latestPayload.ok === true : null,
      effectiveProfile: latestPayload && typeof latestPayload.effectiveProfile === "string"
        ? latestPayload.effectiveProfile
        : null,
      failureCount: failures.length,
      retryableLogOnlyFailure: isRetryableValidationFailure(latestPayload),
      failures
    });

    if (latestResult.exitCode === 0) {
      break;
    }

    if (!isRetryableValidationFailure(latestPayload) || attempt >= PROBE_VALIDATION_MAX_ATTEMPTS) {
      break;
    }

    await sleep(PROBE_VALIDATION_RETRY_DELAY_MS);
  }

  return {
    ...(latestResult || {
      command: null,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: ""
    }),
    attemptCount: attempts.length,
    attempts
  };
}

function createServerEnv(args, baseDir, stateFile, healthFile) {
  const stateRootDir = path.join(baseDir, "state");
  const memoryNotesDir = path.join(stateRootDir, "memory-notes");
  const codeRunsDir = path.join(stateRootDir, "code-runs");
  const llmUsageStatePath = path.join(stateRootDir, "llm_usage.json");
  const copilotUsageStatePath = path.join(stateRootDir, "copilot_usage.json");
  const conversationStatePath = path.join(stateRootDir, "conversations.json");
  const authSessionStatePath = path.join(stateRootDir, "auth_sessions.json");
  const auditLogPath = path.join(stateRootDir, "audit.log");

  fs.mkdirSync(memoryNotesDir, { recursive: true });
  fs.mkdirSync(codeRunsDir, { recursive: true });
  return {
    ...process.env,
    OMNINODE_WS_PORT: args.wsPort,
    OMNINODE_ENABLE_HEALTH_ENDPOINT: "1",
    OMNINODE_GATEWAY_STARTUP_PROBE: "1",
    OMNINODE_GATEWAY_STARTUP_PROBE_MODE: args.probeMode,
    OMNINODE_GATEWAY_STARTUP_PROBE_DELAY_MS: "300",
    OMNINODE_GATEWAY_STARTUP_PROBE_TIMEOUT_SEC: args.timeoutSec,
    OMNINODE_GATEWAY_STARTUP_PROBE_POLL_INTERVAL_MS: args.pollMs,
    OMNINODE_GATEWAY_STARTUP_PROBE_STATE_PATH: stateFile,
    OMNINODE_GATEWAY_HEALTH_STATE_PATH: healthFile,
    OMNINODE_LLM_USAGE_STATE_PATH: llmUsageStatePath,
    OMNINODE_COPILOT_USAGE_STATE_PATH: copilotUsageStatePath,
    OMNINODE_CONVERSATION_STATE_PATH: conversationStatePath,
    OMNINODE_AUTH_SESSION_STATE_PATH: authSessionStatePath,
    OMNINODE_MEMORY_NOTES_DIR: memoryNotesDir,
    OMNINODE_CODE_RUNS_DIR: codeRunsDir,
    OMNINODE_AUDIT_LOG_PATH: auditLogPath
  };
}

async function waitForProbeSnapshot(stateFile, child, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(stateFile)) {
      return { ok: true, reason: "snapshot_created" };
    }
    if (child.exitCode !== null) {
      return { ok: false, reason: `server_exited_early:${child.exitCode}` };
    }
    await sleep(200);
  }
  return { ok: false, reason: "snapshot_wait_timeout" };
}

async function stopServer(child, timeoutMs) {
  if (child.exitCode !== null) {
    return {
      alreadyStopped: true,
      signalSent: null,
      exitCode: child.exitCode,
      signal: child.signalCode || null,
      forcedKill: false
    };
  }

  const waitForExit = async (waitMs) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
      if (child.exitCode !== null) {
        return true;
      }
      await sleep(100);
    }
    return child.exitCode !== null;
  };

  child.kill("SIGINT");
  if (await waitForExit(Math.min(4000, timeoutMs))) {
    return {
      alreadyStopped: false,
      signalSent: "SIGINT",
      exitCode: child.exitCode,
      signal: child.signalCode || null,
      forcedKill: false
    };
  }

  child.kill("SIGTERM");
  if (await waitForExit(Math.max(1000, timeoutMs - 4000))) {
    return {
      alreadyStopped: false,
      signalSent: "SIGINT->SIGTERM",
      exitCode: child.exitCode,
      signal: child.signalCode || null,
      forcedKill: false
    };
  }

  child.kill("SIGKILL");
  await waitForExit(1000);
  return {
    alreadyStopped: false,
    signalSent: "SIGINT->SIGTERM->SIGKILL",
    exitCode: child.exitCode,
    signal: child.signalCode || null,
    forcedKill: true
  };
}

function safeJsonParse(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runtimeDir) {
    printUsage();
    console.error("error: --runtime-dir is required");
    process.exit(2);
  }

  const wsPortResolution = await resolveWsPort(args.wsPort);
  args.wsPort = wsPortResolution.selected;

  const runtimeDir = path.resolve(args.runtimeDir);
  const projectPath = path.resolve(args.project);
  fs.mkdirSync(runtimeDir, { recursive: true });

  const stateFile = path.join(runtimeDir, "gateway_startup_probe.json");
  const healthFile = path.join(runtimeDir, "gateway_health.json");
  const logFile = path.join(runtimeDir, "server.log");
  const healthzFile = path.join(runtimeDir, "healthz_http.txt");
  const readyzFile = path.join(runtimeDir, "readyz_http.txt");
  const summaryFile = path.join(runtimeDir, "startup_probe_run_summary.json");

  const logFd = fs.openSync(logFile, "w");
  const env = createServerEnv(args, runtimeDir, stateFile, healthFile);
  const prebuildResult = args.skipPrebuild
    ? {
        skipped: true,
        command: null,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: ""
      }
    : {
        skipped: false,
        ...runPrebuild(projectPath)
      };
  if (!prebuildResult.skipped && prebuildResult.exitCode !== 0) {
    const summary = {
      ok: false,
      runtimeDir,
      projectPath,
      prebuild: prebuildResult,
      serverCommand: "skipped (prebuild failed)",
      wsPortResolution: {
        requested: wsPortResolution.requested,
        selected: wsPortResolution.selected,
        autoAllocated: wsPortResolution.auto,
        autoFallback: wsPortResolution.autoFallback === true,
        allocationError: wsPortResolution.allocationError ?? null
      },
      files: {
        logFile,
        stateFile,
        healthFile,
        healthzFile,
        readyzFile,
        summaryFile
      }
    };
    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.error(JSON.stringify(summary));
    process.exit(1);
  }

  const dotnetRunArgs = [
    "run",
    "--no-build",
    "--no-restore",
    "--project",
    projectPath
  ];
  const server = spawn(
    "dotnet",
    dotnetRunArgs,
    {
      env,
      stdio: ["ignore", logFd, logFd]
    }
  );
  fs.closeSync(logFd);

  const waitResult = await waitForProbeSnapshot(stateFile, server, 20000);
  const parsedPollMs = parsePositiveInteger(args.pollMs);
  const listenerPollMs = Math.max(
    LISTENER_READY_MIN_POLL_MS,
    parsedPollMs === null ? 150 : parsedPollMs
  );
  const parsedTimeoutSec = parsePositiveInteger(args.timeoutSec);
  const listenerTimeoutMs = Math.max(
    listenerPollMs,
    parsedTimeoutSec === null
      ? LISTENER_READY_DEFAULT_TIMEOUT_MS
      : parsedTimeoutSec * 1000
  );
  const listenerReadiness = waitResult.ok
    ? await waitForPortOpen(server, args.wsPort, listenerTimeoutMs, listenerPollMs)
    : {
        enabled: false,
        host: "127.0.0.1",
        port: parsePositiveInteger(args.wsPort),
        timeoutMs: listenerTimeoutMs,
        pollMs: listenerPollMs,
        ready: false,
        reason: "probe_snapshot_unavailable",
        attemptCount: 0,
        elapsedMs: 0,
        firstError: null,
        lastError: null
      };

  const healthzResult = runCurl(
    `http://127.0.0.1:${args.wsPort}/healthz`,
    healthzFile
  );
  const readyzResult = runCurl(
    `http://127.0.0.1:${args.wsPort}/readyz`,
    readyzFile
  );

  let validationResult = {
    command: null,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    attemptCount: 0,
    attempts: []
  };
  if (waitResult.ok) {
    validationResult = await runProbeValidationWithRetry(args, stateFile, logFile, healthFile);
  }

  const validationPayload = parseValidationPayload(validationResult);
  const profileExpectation = evaluateProfileExpectation(
    args.expectProfile,
    validationPayload,
    validationResult.exitCode
  );
  const autoFallbackExpectation = evaluateAutoFallbackExpectation(
    args.expectAutoFallback,
    wsPortResolution,
    validationPayload,
    profileExpectation
  );
  const allocationErrorExpectation = evaluateAllocationErrorExpectation(
    args.expectAllocationError,
    wsPortResolution,
    validationPayload,
    profileExpectation
  );
  const probePayload = safeJsonParse(stateFile);
  const healthPayload = safeJsonParse(healthFile);
  const listenerReadinessExpectation = evaluateListenerReadinessExpectation(
    args.expectListenerReady,
    listenerReadiness,
    validationPayload,
    profileExpectation,
    probePayload,
    healthPayload
  );

  const enableLiveHttpRetry = shouldEnableLiveHttpExpectation(validationPayload, profileExpectation);
  let finalizedHealthzResult = withCurlAttemptMetadata(healthzResult, healthzFile);
  let finalizedReadyzResult = withCurlAttemptMetadata(readyzResult, readyzFile);
  if (enableLiveHttpRetry) {
    const retryDelayMs = Number.parseInt(args.pollMs, 10);
    const resolvedRetryDelayMs = Number.isFinite(retryDelayMs) ? retryDelayMs : 150;
    finalizedHealthzResult = await retryCurlUntilExpectedStatus(
      healthzResult,
      `http://127.0.0.1:${args.wsPort}/healthz`,
      healthzFile,
      200,
      LIVE_SUCCESS_HTTP_MAX_ATTEMPTS,
      resolvedRetryDelayMs
    );
    finalizedReadyzResult = await retryCurlUntilExpectedStatus(
      readyzResult,
      `http://127.0.0.1:${args.wsPort}/readyz`,
      readyzFile,
      200,
      LIVE_SUCCESS_HTTP_MAX_ATTEMPTS,
      resolvedRetryDelayMs
    );
  }

  const liveHttpExpectation = evaluateLiveHttpExpectation(
    validationPayload,
    profileExpectation,
    finalizedHealthzResult,
    finalizedReadyzResult
  );
  const readyzTransitionExpectation = evaluateReadyzTransitionExpectation(
    args.expectReadyzTransition,
    finalizedReadyzResult,
    validationPayload,
    profileExpectation,
    probePayload
  );

  const stopResult = await stopServer(server, 10000);
  const validationHintExpectation = evaluateValidationHintExpectation(
    args.expectValidationHint,
    probePayload,
    profileExpectation
  );
  const liveProbeExpectation = evaluateLiveProbeExpectation(
    validationPayload,
    profileExpectation,
    probePayload
  );

  const summary = {
    ok: waitResult.ok
      && validationResult.exitCode === 0
      && profileExpectation.matched
      && validationHintExpectation.matched
      && autoFallbackExpectation.matched
      && allocationErrorExpectation.matched
      && listenerReadinessExpectation.matched
      && liveHttpExpectation.matched
      && readyzTransitionExpectation.matched
      && liveProbeExpectation.matched,
    runtimeDir,
    projectPath,
    prebuild: prebuildResult,
    serverCommand: `dotnet ${dotnetRunArgs.join(" ")}`,
    wsPortResolution: {
      requested: wsPortResolution.requested,
      selected: wsPortResolution.selected,
      autoAllocated: wsPortResolution.auto,
      autoFallback: wsPortResolution.autoFallback === true,
      allocationError: wsPortResolution.allocationError ?? null
    },
    environment: {
      OMNINODE_WS_PORT: env.OMNINODE_WS_PORT,
      OMNINODE_ENABLE_HEALTH_ENDPOINT: env.OMNINODE_ENABLE_HEALTH_ENDPOINT,
      OMNINODE_GATEWAY_STARTUP_PROBE: env.OMNINODE_GATEWAY_STARTUP_PROBE,
      OMNINODE_GATEWAY_STARTUP_PROBE_MODE: env.OMNINODE_GATEWAY_STARTUP_PROBE_MODE,
      OMNINODE_GATEWAY_STARTUP_PROBE_DELAY_MS: env.OMNINODE_GATEWAY_STARTUP_PROBE_DELAY_MS,
      OMNINODE_GATEWAY_STARTUP_PROBE_TIMEOUT_SEC: env.OMNINODE_GATEWAY_STARTUP_PROBE_TIMEOUT_SEC,
      OMNINODE_GATEWAY_STARTUP_PROBE_POLL_INTERVAL_MS: env.OMNINODE_GATEWAY_STARTUP_PROBE_POLL_INTERVAL_MS,
      OMNINODE_GATEWAY_STARTUP_PROBE_STATE_PATH: env.OMNINODE_GATEWAY_STARTUP_PROBE_STATE_PATH,
      OMNINODE_GATEWAY_HEALTH_STATE_PATH: env.OMNINODE_GATEWAY_HEALTH_STATE_PATH,
      OMNINODE_LLM_USAGE_STATE_PATH: env.OMNINODE_LLM_USAGE_STATE_PATH,
      OMNINODE_COPILOT_USAGE_STATE_PATH: env.OMNINODE_COPILOT_USAGE_STATE_PATH,
      OMNINODE_CONVERSATION_STATE_PATH: env.OMNINODE_CONVERSATION_STATE_PATH,
      OMNINODE_AUTH_SESSION_STATE_PATH: env.OMNINODE_AUTH_SESSION_STATE_PATH,
      OMNINODE_MEMORY_NOTES_DIR: env.OMNINODE_MEMORY_NOTES_DIR,
      OMNINODE_CODE_RUNS_DIR: env.OMNINODE_CODE_RUNS_DIR,
      OMNINODE_AUDIT_LOG_PATH: env.OMNINODE_AUDIT_LOG_PATH
    },
    files: {
      logFile,
      stateFile,
      healthFile,
      healthzFile,
      readyzFile,
      summaryFile
    },
    waitResult,
    listenerReadiness,
    healthChecks: {
      healthz: finalizedHealthzResult,
      readyz: finalizedReadyzResult
    },
    validation: {
      ...validationResult,
      parsed: validationPayload,
      profileExpectation,
      validationHintExpectation,
      autoFallbackExpectation,
      allocationErrorExpectation,
      listenerReadinessExpectation,
      liveHttpExpectation,
      readyzTransitionExpectation,
      liveProbeExpectation
    },
    serverStop: stopResult,
    probeSummary: summarizeProbePayload(probePayload),
    healthSummary: healthPayload
      ? {
          status: healthPayload.status ?? null,
          listenerBound: healthPayload.listenerBound ?? null,
          degradedMode: healthPayload.degradedMode ?? null,
          listenerErrorCode: healthPayload.listenerErrorCode ?? null,
          webSocketRoundTripCount: healthPayload.webSocketRoundTripCount ?? null,
          webSocketReady: healthPayload.webSocketReady ?? null,
          readyReason: healthPayload.readyReason ?? null
        }
      : null,
    logTail: readTail(logFile)
  };

  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (summary.ok) {
    console.log(JSON.stringify(summary));
    return;
  }

  console.error(JSON.stringify(summary));
  process.exit(1);
}

main().catch((error) => {
  console.error(`error: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
