#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const KEY_SOURCE_POLICY = "keychain|secure_file_600";
const GEMINI_KEY_REQUIRED_FOR = ["test", "validation", "regression", "production_run"];
const OPERATIONAL_CHANNELS = ["chat", "coding", "telegram"];
const EXPECTED_TIMELINE_SCHEMA = "guard_retry_timeline.v1";
const COUNT_LOCK_TERMINATION = "count_lock_unsatisfied_after_retries";
const EXPECTED_RETRY_SCOPE = "gemini_grounding_search";

function parseArgs(argv) {
  let smokeReportPath = "";
  let timelineStatePath = "";
  let readinessReportPath = "";
  let writePath = "";
  let enforce = false;

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--smoke-report") {
      const next = argv[i + 1];
      assert(next, "--smoke-report 옵션에는 파일 경로가 필요합니다.");
      smokeReportPath = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--timeline-state") {
      const next = argv[i + 1];
      assert(next, "--timeline-state 옵션에는 파일 경로가 필요합니다.");
      timelineStatePath = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--readiness-report") {
      const next = argv[i + 1];
      assert(next, "--readiness-report 옵션에는 파일 경로가 필요합니다.");
      readinessReportPath = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--write") {
      const next = argv[i + 1];
      assert(next, "--write 옵션에는 파일 경로가 필요합니다.");
      writePath = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--enforce") {
      enforce = true;
      continue;
    }
    throw new Error(`지원하지 않는 인자: ${token}`);
  }

  assert(smokeReportPath, "--smoke-report 옵션은 필수입니다.");
  assert(timelineStatePath, "--timeline-state 옵션은 필수입니다.");

  return {
    smokeReportPath,
    timelineStatePath,
    readinessReportPath,
    writePath,
    enforce
  };
}

function readJson(filePath, label) {
  assert(fs.existsSync(filePath), `${label} 파일이 없습니다: ${filePath}`);
  const text = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} JSON 파싱 실패: ${error.message}`);
  }
}

function isSeedEntry(entry) {
  const id = `${entry && entry.id ? entry.id : ""}`.trim().toLowerCase();
  return id.startsWith("seed-");
}

function summarizeTimeline(payload, statePath) {
  assert(payload && typeof payload === "object" && !Array.isArray(payload), "timeline state 루트는 객체여야 합니다.");
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const byChannel = { chat: 0, coding: 0, telegram: 0 };
  const stopReasons = {
    count_lock_unsatisfied: 0,
    count_lock_unsatisfied_after_retries: 0,
    citation_validation_failed: 0,
    max_attempts_reached: 0,
    other: 0
  };

  let totalNonSeedEntries = 0;
  let retryRequiredTotal = 0;
  let latestCapturedAtMs = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (isSeedEntry(entry)) {
      continue;
    }
    const channel = `${entry.channel || ""}`.trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(byChannel, channel)) {
      continue;
    }

    byChannel[channel] += 1;
    totalNonSeedEntries += 1;
    if (entry.retryRequired === true) {
      retryRequiredTotal += 1;
    }

    const stopReason = `${entry.retryStopReason || "-"}`.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(stopReasons, stopReason)) {
      stopReasons[stopReason] += 1;
    } else if (stopReason !== "-") {
      stopReasons.other += 1;
    }

    const capturedAtMs = Date.parse(`${entry.capturedAt || ""}`);
    if (Number.isFinite(capturedAtMs) && capturedAtMs > latestCapturedAtMs) {
      latestCapturedAtMs = capturedAtMs;
    }
  }

  return {
    statePath,
    schemaVersion: `${payload.schemaVersion || ""}`,
    schemaVersionMatched: `${payload.schemaVersion || ""}` === EXPECTED_TIMELINE_SCHEMA,
    totalEntries: entries.length,
    nonSeedEntries: totalNonSeedEntries,
    byChannel,
    retryRequiredTotal,
    retryRequiredRate: totalNonSeedEntries > 0
      ? Number((retryRequiredTotal / totalNonSeedEntries).toFixed(6))
      : 0,
    stopReasons,
    latestCapturedAtUtc: Number.isFinite(latestCapturedAtMs)
      ? new Date(latestCapturedAtMs).toISOString()
      : null
  };
}

function hasCountLockTermination(text) {
  return `${text || ""}`.includes(`termination=${COUNT_LOCK_TERMINATION}`);
}

function isGeminiGroundingRetry(check) {
  return check
    && typeof check === "object"
    && check.retryRequired === true
    && `${check.retryScope || ""}` === EXPECTED_RETRY_SCOPE;
}

function summarizeSmokeRegression(smoke) {
  const checks = smoke && smoke.checks && smoke.checks.checks
    ? smoke.checks.checks
    : {};
  const traces = smoke && smoke.checks && Array.isArray(smoke.checks.traces)
    ? smoke.checks.traces
    : [];

  const chatGuardBlocked = checks.chatGuardBlocked || null;
  const codingGuardBlocked = checks.codingGuardBlocked || null;
  const telegramGuardAuditBlocked = checks.telegramGuardAuditBlocked || null;
  const telegramRouteResult = checks.telegramRouteResult || null;

  const countLockObserved = {
    chat: hasCountLockTermination(chatGuardBlocked && chatGuardBlocked.guardDetail),
    coding: hasCountLockTermination(codingGuardBlocked && codingGuardBlocked.guardDetail),
    telegramAudit: hasCountLockTermination(telegramGuardAuditBlocked && telegramGuardAuditBlocked.message)
  };

  return {
    smokeOk: smoke && smoke.ok === true,
    keySourcePolicy: `${smoke && smoke.key_source_policy ? smoke.key_source_policy : ""}`,
    keySourcePolicyMatched: `${smoke && smoke.key_source_policy ? smoke.key_source_policy : ""}` === KEY_SOURCE_POLICY,
    checks: {
      chatGuardBlocked,
      codingGuardBlocked,
      telegramGuardAuditBlocked,
      telegramRouteResult
    },
    traces,
    searchPathSingleGeminiGrounding: isGeminiGroundingRetry(chatGuardBlocked) && isGeminiGroundingRetry(codingGuardBlocked),
    countLockTerminationObserved: countLockObserved,
    countLockTerminationObservedAllChannels:
      countLockObserved.chat
      && countLockObserved.coding
      && countLockObserved.telegramAudit,
    multiProviderRouteObserved: `${telegramGuardAuditBlocked && telegramGuardAuditBlocked.message ? telegramGuardAuditBlocked.message : ""}`
      .includes("telegram-single:copilot")
  };
}

function buildReport(args, smoke, timeline, readiness) {
  const smokeSummary = summarizeSmokeRegression(smoke);
  const timelineSummary = summarizeTimeline(timeline, args.timelineStatePath);
  const readinessSummary = readiness && typeof readiness === "object" ? readiness : null;

  return {
    ok: true,
    stage: "P7",
    generatedAtUtc: new Date().toISOString(),
    policy: {
      geminiKeySource: KEY_SOURCE_POLICY,
      geminiKeyRequiredFor: [...GEMINI_KEY_REQUIRED_FOR],
      operationalScope: ["local", "telegram_bot"],
      expectedChannels: [...OPERATIONAL_CHANNELS]
    },
    inputs: {
      smokeReportPath: args.smokeReportPath,
      timelineStatePath: args.timelineStatePath,
      readinessReportPath: args.readinessReportPath || null
    },
    regression: {
      smoke: smokeSummary,
      timeline: timelineSummary,
      readiness: readinessSummary
    }
  };
}

function enforceReport(report, smoke) {
  const smokeSummary = report.regression.smoke;
  const timelineSummary = report.regression.timeline;
  const readinessSummary = report.regression.readiness;
  const smokeDelta = smoke && smoke.guardRetryTimelineSamples && smoke.guardRetryTimelineSamples.delta
    ? smoke.guardRetryTimelineSamples.delta
    : null;

  assert.equal(smokeSummary.smokeOk, true, "P3 guard smoke 회귀가 실패했습니다.");
  assert.equal(smokeSummary.keySourcePolicyMatched, true, "GeminiKeySource 정책이 다릅니다.");
  assert.equal(smokeSummary.searchPathSingleGeminiGrounding, true, "검색 retryScope가 gemini_grounding_search 단일 경로가 아닙니다.");
  assert.equal(smokeSummary.countLockTerminationObservedAllChannels, true, "count-lock 종료 근거가 chat/coding/telegram에서 모두 확인되지 않았습니다.");
  assert.equal(smokeSummary.multiProviderRouteObserved, true, "멀티 제공자 경로(copilot) 근거가 없습니다.");

  const chatBlocked = smokeSummary.checks.chatGuardBlocked;
  const codingBlocked = smokeSummary.checks.codingGuardBlocked;
  const telegramAuditBlocked = smokeSummary.checks.telegramGuardAuditBlocked;
  assert(chatBlocked && chatBlocked.ok === true, "chatGuardBlocked 근거가 없습니다.");
  assert(codingBlocked && codingBlocked.ok === true, "codingGuardBlocked 근거가 없습니다.");
  assert(telegramAuditBlocked && telegramAuditBlocked.ok === true, "telegramGuardAuditBlocked 근거가 없습니다.");

  assert.equal(timelineSummary.schemaVersionMatched, true, "guard_retry_timeline schemaVersion이 다릅니다.");
  assert(timelineSummary.nonSeedEntries >= 30, `비-seed 표본이 부족합니다: ${timelineSummary.nonSeedEntries}`);
  for (const channel of OPERATIONAL_CHANNELS) {
    assert(
      timelineSummary.byChannel[channel] >= 1,
      `${channel} 채널 비-seed 표본이 없습니다: ${timelineSummary.byChannel[channel]}`
    );
  }

  if (smokeDelta) {
    assert(smokeDelta.nonSeedEntries >= 1, "smoke 실행 후 비-seed 표본 누적 증가가 없습니다.");
    assert(smokeDelta.byChannel && smokeDelta.byChannel.chat >= 1, "smoke 실행 후 chat 표본 증가가 없습니다.");
    assert(smokeDelta.byChannel && smokeDelta.byChannel.coding >= 1, "smoke 실행 후 coding 표본 증가가 없습니다.");
    assert(smokeDelta.byChannel && smokeDelta.byChannel.telegram >= 1, "smoke 실행 후 telegram 표본 증가가 없습니다.");
  }

  if (readinessSummary) {
    assert.equal(readinessSummary.ok, true, "readiness 점검 결과가 실패입니다.");
    assert(readinessSummary.readiness && readinessSummary.readiness.ready === true, "readiness 상태가 ready=true가 아닙니다.");
  }
}

function main() {
  const args = parseArgs(process.argv);
  const smoke = readJson(args.smokeReportPath, "smoke report");
  const timeline = readJson(args.timelineStatePath, "guard retry timeline state");
  const readiness = args.readinessReportPath
    ? readJson(args.readinessReportPath, "readiness report")
    : null;

  const report = buildReport(args, smoke, timeline, readiness);

  if (args.enforce) {
    enforceReport(report, smoke);
  }

  if (args.writePath) {
    fs.mkdirSync(path.dirname(args.writePath), { recursive: true });
    fs.writeFileSync(args.writePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
