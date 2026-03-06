const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");

const FLOW_LIMIT = 64;
const ALLOWED_DOMAINS = new Set(["all", "provider", "tool", "rag"]);

function buildOpsFlowItems(providerRuntimeItems, toolResultItems) {
  const providerItems = providerRuntimeItems.map((item) => ({
    id: `provider-${item.id || `${item.capturedAt || ""}-${item.provider || "unknown"}`}`,
    capturedAt: item.capturedAt || "",
    domain: "provider",
    source: item.scope || "runtime",
    statusLabel: item.statusLabel || "-",
    statusTone: item.statusTone || "neutral",
    hasError: !!item.hasError,
    summary: item.summary || `${item.provider || "unknown"} ${item.statusLabel || "-"}`
  }));

  const toolItems = toolResultItems.map((item) => ({
    id: `tool-${item.id || `${item.capturedAt || ""}-${item.type || "unknown"}`}`,
    capturedAt: item.capturedAt || "",
    domain: item.domain === "rag" ? "rag" : "tool",
    source: item.group || "tool",
    statusLabel: item.statusLabel || "-",
    statusTone: item.statusTone || "neutral",
    hasError: !!item.hasError,
    summary: item.summary || "-"
  }));

  return [...providerItems, ...toolItems]
    .sort((a, b) => (b.capturedAt || "").localeCompare(a.capturedAt || ""))
    .slice(0, FLOW_LIMIT);
}

function buildOpsDomainStats(opsFlowItems) {
  const stats = {
    all: { count: 0, errorCount: 0, lastSummary: "-" },
    provider: { count: 0, errorCount: 0, lastSummary: "-" },
    tool: { count: 0, errorCount: 0, lastSummary: "-" },
    rag: { count: 0, errorCount: 0, lastSummary: "-" }
  };

  for (const item of opsFlowItems) {
    const domain = item.domain === "provider" || item.domain === "rag" ? item.domain : "tool";

    const allTarget = stats.all;
    if (allTarget.count === 0) {
      allTarget.lastSummary = item.summary || "-";
    }
    allTarget.count += 1;
    if (item.hasError) {
      allTarget.errorCount += 1;
    }

    const target = stats[domain];
    if (target.count === 0) {
      target.lastSummary = item.summary || "-";
    }
    target.count += 1;
    if (item.hasError) {
      target.errorCount += 1;
    }
  }

  return stats;
}

function filterOpsFlowItems(opsFlowItems, domainFilter) {
  assert.ok(ALLOWED_DOMAINS.has(domainFilter), `지원하지 않는 도메인 필터: ${domainFilter}`);
  if (domainFilter === "all") {
    return opsFlowItems;
  }
  return opsFlowItems.filter((item) => item.domain === domainFilter);
}

function percentile(samples, p) {
  if (!samples.length) {
    return 0;
  }
  const ordered = samples.slice().sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil((p / 100) * ordered.length) - 1));
  return ordered[index];
}

function summarize(samples) {
  if (!samples.length) {
    return { min: 0, avg: 0, p95: 0, max: 0 };
  }
  const sum = samples.reduce((acc, value) => acc + value, 0);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  return {
    min: Number(min.toFixed(4)),
    avg: Number((sum / samples.length).toFixed(4)),
    p95: Number(percentile(samples, 95).toFixed(4)),
    max: Number(max.toFixed(4))
  };
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function createBenchmarkInput(totalEvents) {
  const providerRuntimeItems = [];
  const toolResultItems = [];
  const providerCount = Math.floor(totalEvents / 2);
  const toolCount = totalEvents - providerCount;
  const providers = ["groq", "gemini", "cerebras", "copilot", "auto"];
  const groups = ["sessions", "cron", "browser", "canvas", "nodes", "web", "memory", "telegram"];
  const statuses = ["ok", "success", "running", "ready", "error", "failed", "timeout", "pending", "queued"];
  const seed = createSeededRandom(121);
  const baseMs = Date.parse("2026-03-04T12:00:00.000Z");

  for (let i = 0; i < providerCount; i += 1) {
    const status = statuses[i % statuses.length];
    const hasError = /error|failed|timeout/i.test(status);
    providerRuntimeItems.push({
      id: `pr-${i}`,
      capturedAt: new Date(baseMs - i * 1137).toISOString(),
      provider: providers[i % providers.length],
      scope: i % 2 === 0 ? "chat" : "coding",
      statusLabel: status,
      statusTone: hasError ? "error" : (status === "pending" || status === "queued" ? "warn" : "ok"),
      hasError,
      summary: `runtime.${i % 2 === 0 ? "chat" : "coding"} ${providers[i % providers.length]} ${status}`
    });
  }

  for (let i = 0; i < toolCount; i += 1) {
    const group = groups[i % groups.length];
    const domain = group === "web" || group === "memory" ? "rag" : "tool";
    const jitterMs = Math.floor(seed() * 700);
    const hasError = seed() < 0.13;
    toolResultItems.push({
      id: `tr-${i}`,
      capturedAt: new Date(baseMs - i * 947 - jitterMs).toISOString(),
      group,
      domain,
      type: `${group}_result`,
      statusLabel: hasError ? "error" : "ok",
      statusTone: hasError ? "error" : "ok",
      hasError,
      summary: `${group} ${hasError ? "error" : "ok"} #${i}`
    });
  }

  return { providerRuntimeItems, toolResultItems };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    events: Number.parseInt(process.env.OPS_BENCH_EVENT_COUNT || "1000", 10),
    iterations: Number.parseInt(process.env.OPS_BENCH_ITERATIONS || "500", 10)
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--events") {
      out.events = Number.parseInt(args[i + 1] || "", 10);
      i += 1;
      continue;
    }
    if (token === "--iterations") {
      out.iterations = Number.parseInt(args[i + 1] || "", 10);
      i += 1;
      continue;
    }
  }

  if (!Number.isInteger(out.events) || out.events < 64) {
    throw new Error(`events 값은 64 이상의 정수여야 합니다. 입력=${out.events}`);
  }
  if (!Number.isInteger(out.iterations) || out.iterations < 1) {
    throw new Error(`iterations 값은 1 이상의 정수여야 합니다. 입력=${out.iterations}`);
  }

  return out;
}

function run() {
  const { events, iterations } = parseArgs();
  const { providerRuntimeItems, toolResultItems } = createBenchmarkInput(events);
  const buildSamples = [];
  const statsSamples = [];
  const filterSamples = [];
  const totalSamples = [];
  let lastStats = null;
  let lastFlowItems = null;

  for (let i = 0; i < iterations; i += 1) {
    const startedAt = performance.now();
    const flowStartedAt = performance.now();
    const opsFlowItems = buildOpsFlowItems(providerRuntimeItems, toolResultItems);
    const flowEndedAt = performance.now();

    const statsStartedAt = performance.now();
    const opsDomainStats = buildOpsDomainStats(opsFlowItems);
    const statsEndedAt = performance.now();

    const filterStartedAt = performance.now();
    const allItems = filterOpsFlowItems(opsFlowItems, "all");
    const providerItems = filterOpsFlowItems(opsFlowItems, "provider");
    const toolItems = filterOpsFlowItems(opsFlowItems, "tool");
    const ragItems = filterOpsFlowItems(opsFlowItems, "rag");
    const filterEndedAt = performance.now();

    buildSamples.push(flowEndedAt - flowStartedAt);
    statsSamples.push(statsEndedAt - statsStartedAt);
    filterSamples.push(filterEndedAt - filterStartedAt);
    totalSamples.push(filterEndedAt - startedAt);

    assert.equal(allItems.length, opsFlowItems.length, "all 필터 길이는 원본과 같아야 합니다.");
    assert.equal(opsDomainStats.all.count, opsFlowItems.length, "all 집계 건수는 flow 길이와 같아야 합니다.");
    assert.equal(
      opsDomainStats.provider.count + opsDomainStats.tool.count + opsDomainStats.rag.count,
      opsDomainStats.all.count,
      "도메인 합계는 all 집계와 같아야 합니다."
    );
    assert.equal(providerItems.length, opsDomainStats.provider.count, "provider 필터/집계 건수가 일치해야 합니다.");
    assert.equal(toolItems.length, opsDomainStats.tool.count, "tool 필터/집계 건수가 일치해야 합니다.");
    assert.equal(ragItems.length, opsDomainStats.rag.count, "rag 필터/집계 건수가 일치해야 합니다.");

    lastStats = opsDomainStats;
    lastFlowItems = opsFlowItems;
  }

  const report = {
    ok: true,
    scenario: {
      events,
      providerEvents: providerRuntimeItems.length,
      toolEvents: toolResultItems.length,
      flowLimit: FLOW_LIMIT,
      iterations
    },
    metricsMs: {
      buildFlow: summarize(buildSamples),
      buildDomainStats: summarize(statsSamples),
      runDomainFilters: summarize(filterSamples),
      totalPipeline: summarize(totalSamples)
    },
    latestSnapshot: {
      flowCount: lastFlowItems ? lastFlowItems.length : 0,
      allCount: lastStats ? lastStats.all.count : 0,
      errorCount: lastStats ? lastStats.all.errorCount : 0,
      providerCount: lastStats ? lastStats.provider.count : 0,
      toolCount: lastStats ? lastStats.tool.count : 0,
      ragCount: lastStats ? lastStats.rag.count : 0,
      latestSummary: lastStats ? lastStats.all.lastSummary : "-"
    }
  };

  console.log(JSON.stringify(report, null, 2));
}

run();
