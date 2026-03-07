#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROFILE_AUTO = "auto";
const PROFILE_LIVE_SUCCESS = "live-success";
const PROFILE_LIVE_ENVIRONMENT_BLOCKED = "live-environment-blocked";
const PROFILE_LIVE_PERMISSION_BLOCKED = "live-permission-blocked";
const PROFILE_MOCK_SUCCESS = "mock-success";

function printUsage() {
  console.error(
    "Usage: node omninode-middleware/check-startup-probe-state.js --file <path> " +
      "--profile <auto|live-success|live-environment-blocked|live-permission-blocked|mock-success> " +
      "[--require-hint] [--log-file <path>] [--health-file <path>]"
  );
}

function parseArgs(argv) {
  const args = {
    file: "",
    profile: PROFILE_AUTO,
    requireHint: false,
    logFile: "",
    healthFile: ""
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--file" && i + 1 < argv.length) {
      args.file = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--profile" && i + 1 < argv.length) {
      args.profile = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--require-hint") {
      args.requireHint = true;
      continue;
    }

    if (token === "--log-file" && i + 1 < argv.length) {
      args.logFile = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--health-file" && i + 1 < argv.length) {
      args.healthFile = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  if (!args.file) {
    const fromEnv = process.env.OMNINODE_GATEWAY_STARTUP_PROBE_STATE_PATH;
    if (fromEnv) {
      args.file = fromEnv;
    }
  }

  if (!args.healthFile) {
    const healthFromEnv = process.env.OMNINODE_GATEWAY_HEALTH_STATE_PATH;
    if (healthFromEnv) {
      args.healthFile = healthFromEnv;
    }
  }

  return args;
}

function expectedHintsForProfile(profile) {
  if (profile === PROFILE_LIVE_SUCCESS) {
    return new Set([PROFILE_LIVE_SUCCESS]);
  }

  if (profile === PROFILE_LIVE_ENVIRONMENT_BLOCKED) {
    return new Set([PROFILE_LIVE_ENVIRONMENT_BLOCKED]);
  }

  if (profile === PROFILE_LIVE_PERMISSION_BLOCKED) {
    return new Set([PROFILE_LIVE_PERMISSION_BLOCKED, PROFILE_LIVE_ENVIRONMENT_BLOCKED]);
  }

  if (profile === PROFILE_MOCK_SUCCESS) {
    return new Set([PROFILE_MOCK_SUCCESS]);
  }

  return null;
}

function validateRequiredHint(payload, effectiveProfile, failures) {
  const hint = typeof payload.validationProfileHint === "string" ? payload.validationProfileHint.trim() : "";
  if (!hint) {
    failures.push("validationProfileHint is required when --require-hint is set");
    return;
  }

  const expectedHints = expectedHintsForProfile(effectiveProfile);
  if (!expectedHints) {
    failures.push(`cannot validate validationProfileHint for profile=${effectiveProfile}`);
    return;
  }

  if (!expectedHints.has(hint)) {
    failures.push(
      `validationProfileHint must match profile ${effectiveProfile} (actual=${hint}, expected=${Array.from(expectedHints).join("|")})`
    );
  }
}

function pushFailure(failures, condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function parsePositiveRoundTripCount(logText) {
  const matches = logText.match(/startup probe result=ok[^\n]*gateway_roundtrip_count=(\d+)/g);
  if (!matches || matches.length === 0) {
    return null;
  }

  const lastLine = matches[matches.length - 1];
  const countMatch = lastLine.match(/gateway_roundtrip_count=(\d+)/);
  if (!countMatch) {
    return null;
  }

  const parsed = Number.parseInt(countMatch[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function validateLogForProfile(payload, effectiveProfile, logText, failures) {
  if (effectiveProfile === PROFILE_LIVE_SUCCESS) {
    pushFailure(
      failures,
      logText.includes("[web] startup probe result=ok"),
      'log must contain "[web] startup probe result=ok"'
    );
    pushFailure(
      failures,
      logText.includes("healthz=200 readyz_before=503 ws_ping_pong=ok readyz_after=200"),
      "log must contain live probe summary (healthz=200 readyz_before=503 ws_ping_pong=ok readyz_after=200)"
    );
    pushFailure(
      failures,
      parsePositiveRoundTripCount(logText) !== null,
      "log must contain startup probe result=ok line with gateway_roundtrip_count>0"
    );
    return;
  }

  if (
    effectiveProfile === PROFILE_LIVE_ENVIRONMENT_BLOCKED ||
    effectiveProfile === PROFILE_LIVE_PERMISSION_BLOCKED
  ) {
    pushFailure(
      failures,
      logText.includes("[web] startup probe skipped:"),
      'log must contain "[web] startup probe skipped:"'
    );

    if (payload.reasonCode === "listener_permission_denied") {
      pushFailure(
        failures,
        logText.includes("Permission denied"),
        'log must contain "Permission denied" when reasonCode=listener_permission_denied'
      );
    }

    if (payload.reasonCode === "runtime_network_stack_unavailable") {
      pushFailure(
        failures,
        logText.includes("runtime network stack unavailable"),
        'log must contain "runtime network stack unavailable" when reasonCode=runtime_network_stack_unavailable'
      );
    }

    return;
  }

  pushFailure(
    failures,
    logText.includes("[web] startup probe mode=mock"),
    'log must contain "[web] startup probe mode=mock"'
  );
  pushFailure(
    failures,
    logText.includes("[web] startup probe result=ok"),
    'log must contain "[web] startup probe result=ok"'
  );
}

function validateHealthForProfile(payload, effectiveProfile, healthPayload, failures) {
  if (!healthPayload || typeof healthPayload !== "object") {
    failures.push("health payload must be an object");
    return;
  }

  pushFailure(
    failures,
    healthPayload.healthEndpointPath === "/healthz",
    `healthEndpointPath must be "/healthz" (actual=${healthPayload.healthEndpointPath})`
  );
  pushFailure(
    failures,
    healthPayload.readyEndpointPath === "/readyz",
    `readyEndpointPath must be "/readyz" (actual=${healthPayload.readyEndpointPath})`
  );

  if (effectiveProfile === PROFILE_LIVE_SUCCESS) {
    pushFailure(
      failures,
      healthPayload.degradedMode === false,
      `degradedMode must be false (actual=${healthPayload.degradedMode})`
    );
    pushFailure(
      failures,
      healthPayload.listenerErrorCode === null,
      `listenerErrorCode must be null (actual=${healthPayload.listenerErrorCode})`
    );
    pushFailure(
      failures,
      healthPayload.listenerErrorMessage === null,
      `listenerErrorMessage must be null (actual=${healthPayload.listenerErrorMessage})`
    );
    pushFailure(
      failures,
      healthPayload.webSocketReady === true,
      `webSocketReady must be true (actual=${healthPayload.webSocketReady})`
    );
    pushFailure(
      failures,
      healthPayload.readyReason === null,
      `readyReason must be null (actual=${healthPayload.readyReason})`
    );
    pushFailure(
      failures,
      typeof healthPayload.webSocketRoundTripCount === "number" && healthPayload.webSocketRoundTripCount > 0,
      "webSocketRoundTripCount must be > 0"
    );

    const liveSuccessStatus = healthPayload.status;
    pushFailure(
      failures,
      liveSuccessStatus === "ok" || liveSuccessStatus === "stopped",
      `status must be "ok" or "stopped" (actual=${liveSuccessStatus})`
    );
    if (liveSuccessStatus === "ok") {
      pushFailure(
        failures,
        healthPayload.listenerBound === true,
        `listenerBound must be true while status=ok (actual=${healthPayload.listenerBound})`
      );
    }
    if (liveSuccessStatus === "stopped") {
      pushFailure(
        failures,
        healthPayload.listenerBound === false,
        `listenerBound must be false while status=stopped (actual=${healthPayload.listenerBound})`
      );
    }
    return;
  }

  if (
    effectiveProfile === PROFILE_LIVE_ENVIRONMENT_BLOCKED ||
    effectiveProfile === PROFILE_LIVE_PERMISSION_BLOCKED
  ) {
    const blockedStatus = healthPayload.status;
    pushFailure(
      failures,
      blockedStatus === "degraded" || blockedStatus === "stopped",
      `status must be "degraded" or "stopped" (actual=${blockedStatus})`
    );
    pushFailure(
      failures,
      healthPayload.degradedMode === true,
      `degradedMode must be true (actual=${healthPayload.degradedMode})`
    );
    pushFailure(
      failures,
      healthPayload.listenerBound === false,
      `listenerBound must be false (actual=${healthPayload.listenerBound})`
    );
    pushFailure(
      failures,
      typeof healthPayload.webSocketRoundTripCount === "number" && healthPayload.webSocketRoundTripCount === 0,
      `webSocketRoundTripCount must be 0 (actual=${healthPayload.webSocketRoundTripCount})`
    );

    if (payload.reasonCode === "listener_permission_denied") {
      pushFailure(
        failures,
        healthPayload.listenerErrorCode === 13,
        `listenerErrorCode must be 13 when reasonCode=listener_permission_denied (actual=${healthPayload.listenerErrorCode})`
      );
      pushFailure(
        failures,
        typeof healthPayload.listenerErrorMessage === "string"
          && healthPayload.listenerErrorMessage.toLowerCase().includes("permission denied"),
        "listenerErrorMessage must include \"Permission denied\" when reasonCode=listener_permission_denied"
      );
    }
    return;
  }

  pushFailure(
    failures,
    typeof healthPayload.status === "string" && healthPayload.status.length > 0,
    `status must be a non-empty string (actual=${healthPayload.status})`
  );
}

function validateLiveSuccess(payload, failures) {
  pushFailure(failures, payload.result === "ok", `result must be "ok" (actual=${payload.result})`);
  pushFailure(
    failures,
    payload.reasonCode === "all_checks_passed",
    `reasonCode must be "all_checks_passed" (actual=${payload.reasonCode})`
  );
  pushFailure(
    failures,
    payload.probeMode === "live",
    `probeMode must be "live" (actual=${payload.probeMode})`
  );
  pushFailure(
    failures,
    payload.simulated === false,
    `simulated must be false (actual=${payload.simulated})`
  );
  pushFailure(
    failures,
    payload.healthz === 200,
    `healthz must be 200 (actual=${payload.healthz})`
  );
  pushFailure(
    failures,
    payload.healthzOk === true,
    `healthzOk must be true (actual=${payload.healthzOk})`
  );
  pushFailure(
    failures,
    payload.readyzBefore === 503,
    `readyzBefore must be 503 (actual=${payload.readyzBefore})`
  );
  pushFailure(
    failures,
    payload.readyzBeforeOk === true,
    `readyzBeforeOk must be true (actual=${payload.readyzBeforeOk})`
  );
  pushFailure(
    failures,
    payload.wsPingPong === "ok",
    `wsPingPong must be "ok" (actual=${payload.wsPingPong})`
  );
  pushFailure(
    failures,
    payload.wsPingPongOk === true,
    `wsPingPongOk must be true (actual=${payload.wsPingPongOk})`
  );
  pushFailure(
    failures,
    payload.readyzAfter === 200,
    `readyzAfter must be 200 (actual=${payload.readyzAfter})`
  );
  pushFailure(
    failures,
    payload.readyzAfterOk === true,
    `readyzAfterOk must be true (actual=${payload.readyzAfterOk})`
  );
  pushFailure(
    failures,
    payload.readyzTransitionOk === true,
    `readyzTransitionOk must be true (actual=${payload.readyzTransitionOk})`
  );
  pushFailure(
    failures,
    typeof payload.gatewayWebSocketRoundTripCount === "number" && payload.gatewayWebSocketRoundTripCount > 0,
    "gatewayWebSocketRoundTripCount must be > 0"
  );
  pushFailure(
    failures,
    payload.gatewayWebSocketRoundTripOk === true,
    `gatewayWebSocketRoundTripOk must be true (actual=${payload.gatewayWebSocketRoundTripOk})`
  );
  pushFailure(
    failures,
    payload.allChecksPassed === true,
    `allChecksPassed must be true (actual=${payload.allChecksPassed})`
  );
}

function validateLivePermissionBlocked(payload, failures) {
  validateLiveEnvironmentBlocked(payload, failures);
  pushFailure(
    failures,
    payload.reasonCode === "listener_permission_denied",
    `reasonCode must be "listener_permission_denied" (actual=${payload.reasonCode})`
  );
}

function isLiveEnvironmentBlockedReasonCode(reasonCode) {
  return (
    reasonCode === "listener_permission_denied" ||
    reasonCode === "runtime_network_stack_unavailable"
  );
}

function validateLiveEnvironmentBlocked(payload, failures) {
  pushFailure(
    failures,
    payload.result === "skipped",
    `result must be "skipped" (actual=${payload.result})`
  );
  pushFailure(
    failures,
    payload.probeMode === "live",
    `probeMode must be "live" (actual=${payload.probeMode})`
  );
  pushFailure(
    failures,
    payload.simulated === false,
    `simulated must be false (actual=${payload.simulated})`
  );
  pushFailure(
    failures,
    isLiveEnvironmentBlockedReasonCode(payload.reasonCode),
    `reasonCode must be one of listener_permission_denied/runtime_network_stack_unavailable (actual=${payload.reasonCode})`
  );
  pushFailure(
    failures,
    payload.environmentBlocked === true,
    `environmentBlocked must be true (actual=${payload.environmentBlocked})`
  );
}

function validateMockSuccess(payload, failures) {
  pushFailure(failures, payload.result === "ok", `result must be "ok" (actual=${payload.result})`);
  pushFailure(
    failures,
    payload.probeMode === "mock",
    `probeMode must be "mock" (actual=${payload.probeMode})`
  );
  pushFailure(
    failures,
    payload.simulated === true,
    `simulated must be true (actual=${payload.simulated})`
  );
  pushFailure(
    failures,
    payload.reasonCode === "startup_probe_mocked",
    `reasonCode must be "startup_probe_mocked" (actual=${payload.reasonCode})`
  );
  pushFailure(
    failures,
    payload.allChecksPassed === true,
    `allChecksPassed must be true (actual=${payload.allChecksPassed})`
  );
}

function inferProfileFromPayload(payload) {
  if (payload.probeMode === "live" && payload.result === "ok") {
    return PROFILE_LIVE_SUCCESS;
  }

  if (
    payload.probeMode === "live" &&
    payload.result === "skipped" &&
    payload.environmentBlocked === true &&
    isLiveEnvironmentBlockedReasonCode(payload.reasonCode)
  ) {
    return PROFILE_LIVE_ENVIRONMENT_BLOCKED;
  }

  if (payload.probeMode === "mock" && payload.result === "ok") {
    return PROFILE_MOCK_SUCCESS;
  }

  return null;
}

function validateProfile(payload, profile) {
  const failures = [];
  const supportedProfiles = new Set([
    PROFILE_LIVE_SUCCESS,
    PROFILE_LIVE_ENVIRONMENT_BLOCKED,
    PROFILE_LIVE_PERMISSION_BLOCKED,
    PROFILE_MOCK_SUCCESS
  ]);
  let effectiveProfile = profile;

  if (profile === PROFILE_AUTO) {
    if (typeof payload.validationProfileHint === "string" && payload.validationProfileHint.trim() !== "") {
      effectiveProfile = payload.validationProfileHint.trim();
    } else {
      const inferredProfile = inferProfileFromPayload(payload);
      if (!inferredProfile) {
        failures.push("validationProfileHint is missing and profile could not be inferred from payload");
        return {
          effectiveProfile,
          failures
        };
      }

      effectiveProfile = inferredProfile;
    }
  }

  if (!supportedProfiles.has(effectiveProfile)) {
    failures.push(`unknown profile: ${effectiveProfile}`);
    return {
      effectiveProfile,
      failures
    };
  }

  if (effectiveProfile === PROFILE_LIVE_SUCCESS) {
    validateLiveSuccess(payload, failures);
    return {
      effectiveProfile,
      failures
    };
  }

  if (effectiveProfile === PROFILE_LIVE_ENVIRONMENT_BLOCKED) {
    validateLiveEnvironmentBlocked(payload, failures);
    return {
      effectiveProfile,
      failures
    };
  }

  if (effectiveProfile === PROFILE_LIVE_PERMISSION_BLOCKED) {
    validateLivePermissionBlocked(payload, failures);
    return {
      effectiveProfile,
      failures
    };
  }

  validateMockSuccess(payload, failures);
  return {
    effectiveProfile,
    failures
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    printUsage();
    console.error("error: --file is required (or set OMNINODE_GATEWAY_STARTUP_PROBE_STATE_PATH)");
    process.exit(2);
  }

  const absoluteFile = path.resolve(args.file);
  let payloadText = "";
  try {
    payloadText = fs.readFileSync(absoluteFile, "utf8");
  } catch (error) {
    console.error(`error: failed to read file (${absoluteFile}): ${error.message}`);
    process.exit(2);
  }

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    console.error(`error: invalid json (${absoluteFile}): ${error.message}`);
    process.exit(2);
  }

  const absoluteLogFile = args.logFile ? path.resolve(args.logFile) : "";
  let logText = "";
  if (absoluteLogFile) {
    try {
      logText = fs.readFileSync(absoluteLogFile, "utf8");
    } catch (error) {
      console.error(`error: failed to read log file (${absoluteLogFile}): ${error.message}`);
      process.exit(2);
    }
  }

  const absoluteHealthFile = args.healthFile ? path.resolve(args.healthFile) : "";
  let healthPayload = null;
  if (absoluteHealthFile) {
    let healthText = "";
    try {
      healthText = fs.readFileSync(absoluteHealthFile, "utf8");
    } catch (error) {
      console.error(`error: failed to read health file (${absoluteHealthFile}): ${error.message}`);
      process.exit(2);
    }

    try {
      healthPayload = JSON.parse(healthText);
    } catch (error) {
      console.error(`error: invalid json (${absoluteHealthFile}): ${error.message}`);
      process.exit(2);
    }
  }

  const validationResult = validateProfile(payload, args.profile);
  const failures = validationResult.failures;
  if (args.requireHint) {
    validateRequiredHint(payload, validationResult.effectiveProfile, failures);
  }
  if (absoluteLogFile) {
    validateLogForProfile(payload, validationResult.effectiveProfile, logText, failures);
  }
  if (healthPayload) {
    validateHealthForProfile(payload, validationResult.effectiveProfile, healthPayload, failures);
  }
  const result = {
    ok: failures.length === 0,
    profile: args.profile,
    effectiveProfile: validationResult.effectiveProfile,
    requireHint: args.requireHint,
    file: absoluteFile,
    logFile: absoluteLogFile || null,
    healthFile: absoluteHealthFile || null,
    summary: {
      result: payload.result ?? null,
      reasonCode: payload.reasonCode ?? null,
      probeMode: payload.probeMode ?? null,
      simulated: payload.simulated ?? null,
      validationProfileHint: payload.validationProfileHint ?? null,
      allChecksPassed: payload.allChecksPassed ?? null,
      gatewayWebSocketRoundTripCount: payload.gatewayWebSocketRoundTripCount ?? null,
      environmentBlocked: payload.environmentBlocked ?? null
    },
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
    failures
  };

  if (result.ok) {
    console.log(JSON.stringify(result));
    return;
  }

  console.error(JSON.stringify(result));
  process.exit(1);
}

main();
