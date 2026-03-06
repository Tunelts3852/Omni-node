#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appPath = path.resolve(__dirname, "app.js");
const defaultSnapshotPath = path.resolve(
  __dirname,
  "../gemini-retriever-plan/loop-automation/runtime/state/P7_GUARD_THRESHOLD_BASELINE.json"
);
const source = fs.readFileSync(appPath, "utf8");

function parseArgs(argv) {
  let snapshotPath = defaultSnapshotPath;
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--snapshot") {
      const next = argv[i + 1];
      assert(next, "--snapshot 옵션에는 파일 경로가 필요합니다.");
      snapshotPath = path.resolve(next);
      i += 1;
      continue;
    }
    throw new Error(`지원하지 않는 인자: ${token}`);
  }
  return { snapshotPath };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberPattern(value) {
  const normalized = Number(value);
  assert(
    Number.isFinite(normalized),
    `임계치 값은 숫자여야 합니다. 입력값: ${value}`
  );
  return escapeRegex(String(normalized));
}

function readSnapshot(snapshotPath) {
  assert(fs.existsSync(snapshotPath), `기준선 스냅샷이 없습니다: ${snapshotPath}`);
  const raw = fs.readFileSync(snapshotPath, "utf8");
  return JSON.parse(raw);
}

function buildRequiredPatterns(snapshot) {
  const channels = snapshot.guardRetryTimelineChannels;
  assert(Array.isArray(channels), "guardRetryTimelineChannels는 배열이어야 합니다.");
  assert.equal(channels.length, 3, "guardRetryTimelineChannels 길이는 3이어야 합니다.");

  const guardRules = snapshot.guardAlertRules;
  assert(Array.isArray(guardRules), "guardAlertRules는 배열이어야 합니다.");
  assert.equal(guardRules.length, 5, "guardAlertRules 길이는 5여야 합니다.");

  const channelTokens = channels.map((channel) => `"${escapeRegex(channel)}"`).join(",\\s*");
  const patterns = [
    {
      label: `retry timeline 채널 고정(${channels.join("/")})`,
      pattern: new RegExp(
        `const\\s+GUARD_RETRY_TIMELINE_CHANNELS\\s*=\\s*\\[${channelTokens}\\];`
      )
    }
  ];

  for (const rule of guardRules) {
    assert(typeof rule.id === "string" && rule.id.length > 0, "guardAlertRules.id는 필수입니다.");
    patterns.push({
      label: `${rule.id} 임계치 고정`,
      pattern: new RegExp(
        `id:\\s*"${escapeRegex(rule.id)}"[\\s\\S]*?warn:\\s*${numberPattern(rule.warn)},[\\s\\S]*?critical:\\s*${numberPattern(rule.critical)},[\\s\\S]*?minTotal:\\s*${numberPattern(rule.minTotal)}`
      )
    });
  }

  return patterns;
}

const args = parseArgs(process.argv);
const snapshot = readSnapshot(args.snapshotPath);

assert.equal(
  snapshot.schemaVersion,
  "guard_threshold_baseline.v1",
  `지원하지 않는 기준선 스키마입니다: ${snapshot.schemaVersion}`
);

const keySourcePolicy = snapshot.policy?.geminiKeySource;
assert.equal(
  keySourcePolicy,
  "keychain|secure_file_600",
  `키 소스 정책이 다릅니다: ${keySourcePolicy}`
);

const requiredFor = snapshot.policy?.geminiKeyRequiredFor;
assert(Array.isArray(requiredFor), "geminiKeyRequiredFor는 배열이어야 합니다.");
assert.deepEqual(
  requiredFor,
  ["test", "validation", "regression", "production_run"],
  `geminiKeyRequiredFor 정책이 다릅니다: ${JSON.stringify(requiredFor)}`
);

const requiredPatterns = buildRequiredPatterns(snapshot);

const failures = [];
for (const entry of requiredPatterns) {
  if (!entry.pattern.test(source)) {
    failures.push(entry.label);
  }
}

assert.equal(
  failures.length,
  0,
  `guard 임계치 고정 회귀 검증 실패: ${failures.join(", ")}`
);

const result = {
  ok: true,
  checkedFile: appPath,
  snapshotPath: args.snapshotPath,
  schemaVersion: snapshot.schemaVersion,
  checks: requiredPatterns.map((entry) => entry.label)
};

console.log(JSON.stringify(result, null, 2));
