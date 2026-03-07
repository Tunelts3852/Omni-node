#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appPath = path.resolve(__dirname, "app.js");
const source = fs.readFileSync(appPath, "utf8");

const requiredPatterns = [
  {
    label: "API 폴링 상수",
    pattern: /const\s+GUARD_RETRY_TIMELINE_API_REFRESH_MS\s*=\s*15000;/
  },
  {
    label: "서버 API 호출 경로",
    pattern: /fetch\(`\/api\/guard\/retry-timeline\?\$\{query\}`,\s*\{/
  },
  {
    label: "서버 스냅샷 정규화",
    pattern: /const\s+guardRetryTimelineServerSnapshot\s*=\s*useMemo\(\s*\(\)\s*=>\s*normalizeGuardRetryTimelineSnapshot\(/s
  },
  {
    label: "서버 우선 선택",
    pattern: /const\s+guardRetryTimeline\s*=\s*useMemo\(\s*\(\)\s*=>\s*guardRetryTimelineServerSnapshot\s*\|\|\s*guardRetryTimelineMemorySnapshot/s
  },
  {
    label: "fallback 소스 라벨",
    pattern: /const\s+guardRetryTimelineSource\s*=\s*guardRetryTimelineServerSnapshot\s*\?\s*"server_api"\s*:\s*"memory_fallback";/
  },
  {
    label: "UI 소스 표시",
    pattern: /retry 시계열 source=\$\{guardRetryTimelineSource\}/
  }
];

const failures = [];
requiredPatterns.forEach((entry) => {
  if (!entry.pattern.test(source)) {
    failures.push(entry.label);
  }
});

assert.equal(failures.length, 0, `retry timeline API 우선 회귀 검증 실패: ${failures.join(", ")}`);

const result = {
  ok: true,
  checkedFile: appPath,
  checks: requiredPatterns.map((entry) => entry.label)
};
console.log(JSON.stringify(result, null, 2));
