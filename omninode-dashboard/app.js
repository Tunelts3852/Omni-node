import {
  CHAT_MODES,
  CODING_LANGUAGES,
  CODING_MODES,
  CODEX_MODEL_CHOICES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_MOBILE_PANES,
  DEFAULT_ROUTINE_AGENT_MODEL,
  DEFAULT_ROUTINE_AGENT_PROVIDER,
  ROUTINE_WEEKDAY_OPTIONS
} from "./modules/dashboard-constants.js";
import {
  buildRoutineImagePreviewUrl,
  buildRoutinePayloadFromForm,
  createRoutineFormState,
  formatRoutineExecutionModeLabel,
  formatRoutineSchedulePreview,
  getRoutineAgentModelFallback,
  getRoutineLocalTimezone,
  getViewportSnapshot,
  hydrateRoutineFormFromRoutine,
  normalizeRoutineExecutionModeValue,
  normalizeRoutineNotifyPolicy,
  normalizeRoutineScheduleSourceMode,
  normalizeRoutineWeekdays
  ,
  resolveRoutineVisibleExecutionMode
} from "./modules/routine-utils.js";

(function () {
  const { useEffect, useMemo, useRef, useState } = React;
  const e = React.createElement;
  const NONE_MODEL = "none";
  const DEFAULT_GROQ_SINGLE_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
  const DEFAULT_GROQ_WORKER_MODEL = "openai/gpt-oss-120b";
  const DEFAULT_GEMINI_WORKER_MODEL = "gemini-3-flash-preview";
  const GEMINI_MODEL_CHOICES = [
    { id: "gemini-3-flash-preview", label: "Gemini 기본: gemini-3-flash-preview" },
    { id: "gemini-3.1-flash-lite-preview", label: "Gemini: gemini-3.1-flash-lite-preview" }
  ];
  const DEFAULT_CEREBRAS_MODEL = "gpt-oss-120b";
  const CEREBRAS_MODEL_CHOICES = [
    { id: DEFAULT_CEREBRAS_MODEL, label: `Cerebras 기본: ${DEFAULT_CEREBRAS_MODEL}` },
    { id: "zai-glm-4.7", label: "Cerebras: zai-glm-4.7 (preview)" },
    { id: "qwen-3-235b-a22b-instruct-2507", label: "Cerebras: qwen-3-235b-a22b-instruct-2507" },
    { id: "llama3.1-8b", label: "Cerebras: llama3.1-8b" }
  ];
  const markdownRenderer = (() => {
    try {
      if (typeof window === "undefined" || typeof window.markdownit !== "function") {
        return null;
      }

      const renderer = window.markdownit({
        html: false,
        linkify: true,
        breaks: true,
        typographer: true
      });

      if (typeof window.markdownitFootnote === "function") {
        renderer.use(window.markdownitFootnote);
      }

      const originalLinkOpen = renderer.renderer.rules.link_open
        || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
      renderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        tokens[idx].attrSet("target", "_blank");
        tokens[idx].attrSet("rel", "noopener noreferrer");
        return originalLinkOpen(tokens, idx, options, env, self);
      };

      return renderer;
    } catch (_err) {
      return null;
    }
  })();
  const AUTH_TOKEN_KEY = "omninode_auth_token";
  const AUTH_EXPIRES_KEY = "omninode_auth_expires_utc";
  const CATEGORY_TONES = ["blue", "teal", "green", "amber", "red", "indigo"];
  const TOOL_RESULT_TYPES = new Set([
    "sessions_list_result",
    "sessions_history_result",
    "sessions_send_result",
    "sessions_spawn_result",
    "web_search_result",
    "web_fetch_result",
    "memory_search_result",
    "memory_get_result",
    "cron_result",
    "browser_result",
    "canvas_result",
    "nodes_result",
    "telegram_stub_result"
  ]);
  const TOOL_RESULT_GROUPS = [
    { key: "sessions", label: "sessions" },
    { key: "cron", label: "cron" },
    { key: "browser", label: "browser" },
    { key: "canvas", label: "canvas" },
    { key: "nodes", label: "nodes" },
    { key: "web", label: "web(rag)" },
    { key: "memory", label: "memory(rag)" },
    { key: "telegram", label: "telegram(stub)" }
  ];
  const TOOL_RESULT_GROUP_BY_TYPE = {
    sessions_list_result: "sessions",
    sessions_history_result: "sessions",
    sessions_send_result: "sessions",
    sessions_spawn_result: "sessions",
    web_search_result: "web",
    web_fetch_result: "web",
    memory_search_result: "memory",
    memory_get_result: "memory",
    cron_result: "cron",
    browser_result: "browser",
    canvas_result: "canvas",
    nodes_result: "nodes",
    telegram_stub_result: "telegram"
  };
  const TOOL_RESULT_FILTERS = [
    { key: "all", label: "전체" },
    { key: "sessions", label: "sessions" },
    { key: "cron", label: "cron" },
    { key: "browser", label: "browser" },
    { key: "canvas", label: "canvas" },
    { key: "nodes", label: "nodes" },
    { key: "web", label: "web(rag)" },
    { key: "memory", label: "memory(rag)" },
    { key: "telegram", label: "telegram(stub)" },
    { key: "errors", label: "오류" }
  ];
  const TOOL_RESULT_DOMAIN_BY_GROUP = {
    sessions: "tool",
    cron: "tool",
    browser: "tool",
    canvas: "tool",
    nodes: "tool",
    telegram: "tool",
    web: "rag",
    memory: "rag"
  };
  const TOOL_DOMAIN_FILTERS = [
    { key: "all", label: "전체 도메인" },
    { key: "tool", label: "tool" },
    { key: "rag", label: "rag" }
  ];
  const OPS_DOMAIN_FILTERS = [
    { key: "all", label: "전체 도메인" },
    { key: "provider", label: "provider" },
    { key: "tool", label: "tool" },
    { key: "rag", label: "rag" }
  ];
  const PROVIDER_RUNTIME_KEYS = ["groq", "gemini", "cerebras", "copilot", "codex", "auto", "unknown"];
  const GUARD_OBS_CHANNEL_KEYS = ["chat", "coding", "telegram", "search", "other"];
  const GUARD_RETRY_TIMELINE_SCHEMA_VERSION = "guard_retry_timeline.v1";
  const GUARD_RETRY_TIMELINE_CHANNELS = ["chat", "coding", "telegram"];
  const GUARD_RETRY_TIMELINE_BUCKET_MINUTES = 5;
  const GUARD_RETRY_TIMELINE_WINDOW_MINUTES = 60;
  const GUARD_RETRY_TIMELINE_MAX_ENTRIES = 512;
  const GUARD_RETRY_TIMELINE_MAX_BUCKET_ROWS = 12;
  const GUARD_RETRY_TIMELINE_API_REFRESH_MS = 15000;
  const GUARD_OBS_MESSAGE_TYPES = new Set([
    "llm_chat_result",
    "llm_chat_multi_result",
    "coding_result",
    "telegram_stub_result",
    "web_search_result"
  ]);
  const GUARD_ALERT_RULES = [
    {
      id: "guard_blocked_rate",
      label: "guard 차단 비율",
      metricType: "rate",
      numeratorKey: "blockedTotal",
      warn: 0.45,
      critical: 0.65,
      minTotal: 8
    },
    {
      id: "retry_required_rate",
      label: "retryRequired 비율",
      metricType: "rate",
      numeratorKey: "retryRequiredTotal",
      warn: 0.45,
      critical: 0.7,
      minTotal: 8
    },
    {
      id: "count_lock_unsatisfied_rate",
      label: "count-lock 미충족 비율",
      metricType: "rate",
      numeratorKey: "countLockUnsatisfiedTotal",
      warn: 0.1,
      critical: 0.2,
      minTotal: 4
    },
    {
      id: "citation_validation_failed_rate",
      label: "citation fail 비율",
      metricType: "rate",
      numeratorKey: "citationValidationFailedTotal",
      warn: 0.1,
      critical: 0.2,
      minTotal: 4
    },
    {
      id: "telegram_guard_meta_blocked_count",
      label: "telegram_guard_meta 차단 건수",
      metricType: "count",
      valueKey: "telegramGuardMetaBlockedTotal",
      warn: 1,
      critical: 2,
      minTotal: 1
    }
  ];
  const GUARD_ALERT_PIPELINE_SCHEMA_VERSION = "guard_alert_event.v1";
  const GUARD_ALERT_PIPELINE_EVENT_TYPE = "omninode.guard_alert.summary";
  const GUARD_ALERT_PIPELINE_FIELD_ROWS = [
    {
      path: "schemaVersion",
      type: "string",
      required: "Y",
      description: "고정값 guard_alert_event.v1"
    },
    {
      path: "eventType",
      type: "string",
      required: "Y",
      description: "고정값 omninode.guard_alert.summary"
    },
    {
      path: "emittedAtUtc",
      type: "string(ISO-8601)",
      required: "Y",
      description: "이벤트 생성 시각(UTC)"
    },
    {
      path: "keySourcePolicy",
      type: "string",
      required: "Y",
      description: "keychain|secure_file_600"
    },
    {
      path: "geminiKeyRequiredFor",
      type: "string[]",
      required: "Y",
      description: "test/validation/regression/production_run"
    },
    {
      path: "alertSummary",
      type: "object",
      required: "Y",
      description: "경보 최악 등급/트리거/표본부족 집계"
    },
    {
      path: "guardMetrics",
      type: "object",
      required: "Y",
      description: "guard/retry/count-lock/citation/telegram 핵심 카운터"
    },
    {
      path: "guardMetrics.countLockUnsatisfiedByChannel",
      type: "object",
      required: "Y",
      description: "채널별 count-lock 미충족 건수(chat/coding/telegram/search/other)"
    },
    {
      path: "guardMetrics.countLockUnsatisfiedRateByChannel",
      type: "object",
      required: "Y",
      description: "채널별 count-lock 미충족 비율(chat/coding/telegram/search/other)"
    },
    {
      path: "guardAlertRows[]",
      type: "object[]",
      required: "Y",
      description: "규칙별 observed/warn/critical/status"
    },
    {
      path: "retryTimeline",
      type: "object",
      required: "Y",
      description: "채널 공통 retryAttempt/retryMaxAttempts/retryStopReason 5분 버킷 시계열"
    },
    {
      path: "retryTop",
      type: "object",
      required: "N",
      description: "retryAction/retryReason/retryStopReason 상위 집계"
    }
  ];
  const chatMultiUtils = (typeof globalThis !== "undefined" && globalThis.OmniChatMultiUtils)
    ? globalThis.OmniChatMultiUtils
    : {
        _toText(value) {
          if (typeof value === "string") {
            return value;
          }
          if (value === null || value === undefined) {
            return "";
          }
          return `${value}`;
        },
        _toMetaText(value) {
          return this._toText(value).trim();
        },
        normalizeChatMultiResultMessage(msg) {
          return {
            groq: this._toText(msg && msg.groq),
            gemini: this._toText(msg && msg.gemini),
            cerebras: this._toText(msg && msg.cerebras),
            copilot: this._toText(msg && msg.copilot),
            codex: this._toText(msg && msg.codex),
            summary: this._toText(msg && msg.summary),
            groqModel: this._toMetaText(msg && msg.groqModel),
            geminiModel: this._toMetaText(msg && msg.geminiModel),
            cerebrasModel: this._toMetaText(msg && msg.cerebrasModel),
            copilotModel: this._toMetaText(msg && msg.copilotModel),
            codexModel: this._toMetaText(msg && msg.codexModel),
            requestedSummaryProvider: this._toMetaText(msg && msg.requestedSummaryProvider),
            resolvedSummaryProvider: this._toMetaText(msg && msg.resolvedSummaryProvider)
          };
        },
        buildChatMultiDisplayLabels(value) {
          const result = this.normalizeChatMultiResultMessage(value);
          return {
            groqLabel: result && result.groqModel ? `Groq (${result.groqModel})` : "Groq",
            geminiLabel: result && result.geminiModel ? `Gemini (${result.geminiModel})` : "Gemini",
            cerebrasLabel: result && result.cerebrasModel ? `Cerebras (${result.cerebrasModel})` : "Cerebras",
            copilotLabel: result && result.copilotModel ? `Copilot (${result.copilotModel})` : "Copilot",
            codexLabel: result && result.codexModel ? `Codex (${result.codexModel})` : "Codex",
            summaryLabel: result && (result.requestedSummaryProvider || result.resolvedSummaryProvider)
              ? `요약 (요청=${result.requestedSummaryProvider || "-"}, 실제=${result.resolvedSummaryProvider || "-"})`
              : "요약"
          };
        },
        buildChatMultiRenderSnapshot(value) {
          const normalized = this.normalizeChatMultiResultMessage(value);
          const labels = this.buildChatMultiDisplayLabels(normalized);
          const sections = [
            { provider: "groq", heading: labels.groqLabel, body: normalized.groq || "-" },
            { provider: "gemini", heading: labels.geminiLabel, body: normalized.gemini || "-" },
            { provider: "cerebras", heading: labels.cerebrasLabel, body: normalized.cerebras || "-" },
            { provider: "copilot", heading: labels.copilotLabel, body: normalized.copilot || "-" }
          ];
          if ((normalized.codex || "").trim() || (normalized.codexModel || "").trim()) {
            sections.push({ provider: "codex", heading: labels.codexLabel, body: normalized.codex || "-" });
          }
          sections.push({ provider: "summary", heading: labels.summaryLabel, body: normalized.summary || "-" });
          return {
            normalized,
            labels,
            sections
          };
        }
      };

  function hashText(value) {
    const text = (value || "").trim();
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  function toneForCategory(category) {
    if (!category) {
      return "blue";
    }

    const idx = hashText(category) % CATEGORY_TONES.length;
    return CATEGORY_TONES[idx];
  }

  function localUtcOffsetLabel() {
    const minutes = -new Date().getTimezoneOffset();
    const sign = minutes >= 0 ? "+" : "-";
    const abs = Math.abs(minutes);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `UTC${sign}${hh}:${mm}`;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function buildTimeWindowKeys(timestamp) {
    const now = new Date(timestamp || Date.now());
    const yyyy = now.getFullYear();
    const mm = pad2(now.getMonth() + 1);
    const dd = pad2(now.getDate());
    const hh = pad2(now.getHours());
    const mi = pad2(now.getMinutes());
    return {
      minute: `${yyyy}${mm}${dd}${hh}${mi}`,
      hour: `${yyyy}${mm}${dd}${hh}`,
      day: `${yyyy}${mm}${dd}`
    };
  }

  function formatDecimal(value, digits) {
    const parsed = Number.parseFloat(`${value ?? ""}`);
    if (!Number.isFinite(parsed)) {
      return "-";
    }
    return parsed.toFixed(digits);
  }

  function formatLatencySeconds(ms) {
    const numeric = Number(ms);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return "-";
    }
    return `${formatDecimal(numeric / 1000, numeric >= 1000 ? 2 : 3)}s`;
  }

  function normalizeLatencyMetrics(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const normalized = {
      decisionMs: Number(raw.decisionMs || 0),
      promptBuildMs: Number(raw.promptBuildMs || 0),
      firstChunkMs: Number(raw.firstChunkMs || 0),
      fullResponseMs: Number(raw.fullResponseMs || 0),
      sanitizeMs: Number(raw.sanitizeMs || 0),
      serverTotalMs: Number(raw.serverTotalMs || 0),
      decisionPath: `${raw.decisionPath || ""}`.trim()
    };

    if (!Number.isFinite(normalized.serverTotalMs) || normalized.serverTotalMs <= 0) {
      normalized.serverTotalMs = Math.max(
        0,
        normalized.decisionMs + normalized.promptBuildMs + normalized.fullResponseMs + normalized.sanitizeMs
      );
    }

    return normalized;
  }

  function formatLatencyMeta(latency) {
    const normalized = normalizeLatencyMetrics(latency);
    if (!normalized || normalized.serverTotalMs <= 0) {
      return "";
    }

    const parts = [
      `server ${formatLatencySeconds(normalized.serverTotalMs)}`,
      `first ${formatLatencySeconds(normalized.firstChunkMs)}`,
      `full ${formatLatencySeconds(normalized.fullResponseMs)}`
    ];
    if (normalized.decisionMs > 0) {
      parts.push(`decision ${normalized.decisionMs}ms`);
    }
    if (normalized.sanitizeMs > 0) {
      parts.push(`sanitize ${normalized.sanitizeMs}ms`);
    }
    return parts.join(" · ");
  }

  function attachLatencyMetaToConversation(conversation, msg) {
    if (!conversation || !Array.isArray(conversation.messages)) {
      return conversation;
    }

    const latencyMeta = formatLatencyMeta(msg && msg.latency);
    if (!latencyMeta) {
      return conversation;
    }

    const messages = conversation.messages.slice();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const item = messages[i];
      if (!item || item.role !== "assistant") {
        continue;
      }

      const baseMeta = `${item.meta || ""}`.trim();
      if (baseMeta.includes("server ") || baseMeta.includes("first ")) {
        return conversation;
      }

      messages[i] = {
        ...item,
        meta: baseMeta ? `${baseMeta} · ${latencyMeta}` : latencyMeta
      };
      return { ...conversation, messages };
    }

    return conversation;
  }

  function escapeHtml(value) {
    return `${value ?? ""}`
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function countMatches(text, regex) {
    if (!text) {
      return 0;
    }
    const matches = text.match(regex);
    return matches ? matches.length : 0;
  }

  function canonicalizeMarkdownTableRow(line) {
    const trimmed = `${line ?? ""}`.trim();
    if (!trimmed.includes("|")) {
      return "";
    }
    if (/^https?:\/\//i.test(trimmed)) {
      return "";
    }

    let candidate = trimmed;
    if (!candidate.startsWith("|")) {
      candidate = `| ${candidate}`;
    }
    if (!candidate.endsWith("|")) {
      candidate = `${candidate} |`;
    }

    const cells = candidate
      .slice(1, -1)
      .split("|")
      .map((cell) => `${cell ?? ""}`.trim());
    if (cells.length < 2 || cells.every((cell) => !cell)) {
      return "";
    }

    return `| ${cells.join(" | ")} |`;
  }

  function canonicalizeMarkdownTableSeparatorLine(line, expectedCells = 0) {
    const dashVariantsRegex = /[\u2014\u2013\u2011\u2212\u2500\u2012]/g;
    const normalizedRow = canonicalizeMarkdownTableRow(line);
    if (!normalizedRow) {
      return "";
    }

    const rawCells = normalizedRow
      .slice(1, -1)
      .split("|")
      .map((cell) => `${cell ?? ""}`.trim());
    if (rawCells.length < 2) {
      return "";
    }
    if (expectedCells > 0 && rawCells.length !== expectedCells) {
      return "";
    }

    const normalizedCells = [];
    for (const cell of rawCells) {
      const compact = `${cell ?? ""}`.replace(/\s+/g, "").replace(dashVariantsRegex, "-");
      if (!/^:?-+:?$/.test(compact)) {
        return "";
      }

      const leadingColon = compact.startsWith(":") ? ":" : "";
      const trailingColon = compact.endsWith(":") ? ":" : "";
      const dashCount = Math.max(3, countMatches(compact, /-/g));
      normalizedCells.push(`${leadingColon}${"-".repeat(dashCount)}${trailingColon}`);
    }

    return `| ${normalizedCells.join(" | ")} |`;
  }

  function normalizeMarkdownTableBlocks(text) {
    if (!text) {
      return "";
    }

    const lines = `${text ?? ""}`.split("\n");
    let changed = false;

    for (let i = 0; i + 1 < lines.length; i += 1) {
      const headerRow = canonicalizeMarkdownTableRow(lines[i]);
      if (!headerRow) {
        continue;
      }

      const headerCells = headerRow
        .slice(1, -1)
        .split("|")
        .map((cell) => `${cell ?? ""}`.trim());
      const separatorRow = canonicalizeMarkdownTableSeparatorLine(lines[i + 1], headerCells.length);
      if (!separatorRow) {
        continue;
      }

      if (lines[i] !== headerRow) {
        lines[i] = headerRow;
        changed = true;
      }
      if (lines[i + 1] !== separatorRow) {
        lines[i + 1] = separatorRow;
        changed = true;
      }

      for (let j = i + 2; j < lines.length; j += 1) {
        const bodyRow = canonicalizeMarkdownTableRow(lines[j]);
        if (!bodyRow) {
          break;
        }

        if (lines[j] !== bodyRow) {
          lines[j] = bodyRow;
          changed = true;
        }
      }
    }

    return changed ? lines.join("\n") : text;
  }

  function hasMarkdownTableBlock(text) {
    const lines = `${text ?? ""}`.split("\n");
    for (let i = 0; i + 1 < lines.length; i += 1) {
      const headerRow = canonicalizeMarkdownTableRow(lines[i]);
      if (!headerRow) {
        continue;
      }

      const headerCells = headerRow
        .slice(1, -1)
        .split("|")
        .map((cell) => `${cell ?? ""}`.trim());
      if (canonicalizeMarkdownTableSeparatorLine(lines[i + 1], headerCells.length)) {
        return true;
      }
    }

    return false;
  }

  function normalizeMarkdownTableSeparators(text) {
    if (!text) {
      return "";
    }

    const dashVariantsRegex = /[\u2014\u2013\u2011\u2212\u2500\u2012]/g;
    const lines = text.split("\n");
    let changed = false;

    const normalizedLines = lines.map((line) => {
      const trimmed = `${line ?? ""}`.trim();
      if (!trimmed.includes("|")) {
        return line;
      }

      let candidate = trimmed;
      if (!candidate.startsWith("|")) {
        candidate = `|${candidate}`;
      }
      if (!candidate.endsWith("|")) {
        candidate = `${candidate}|`;
      }

      if (!/^\|\s*[:\-\u2014\u2013\u2011\u2212\u2500\u2012]+\s*(\|\s*[:\-\u2014\u2013\u2011\u2212\u2500\u2012]+\s*)+\|$/.test(candidate)) {
        return line;
      }

      const rawCells = candidate
        .slice(1, -1)
        .split("|")
        .map((cell) => `${cell ?? ""}`.trim());
      if (rawCells.length < 2) {
        return line;
      }

      const normalizedCells = [];
      for (const cell of rawCells) {
        const compact = `${cell ?? ""}`.replace(/\s+/g, "").replace(dashVariantsRegex, "-");
        if (!/^:?-+:?$/.test(compact)) {
          return line;
        }

        const leadingColon = compact.startsWith(":") ? ":" : "";
        const trailingColon = compact.endsWith(":") ? ":" : "";
        const dashCount = Math.max(3, countMatches(compact, /-/g));
        normalizedCells.push(`${leadingColon}${"-".repeat(dashCount)}${trailingColon}`);
      }

      const leadingMatch = `${line ?? ""}`.match(/^\s*/);
      const leadingWhitespace = leadingMatch ? leadingMatch[0] : "";
      const rebuilt = `${leadingWhitespace}| ${normalizedCells.join(" | ")} |`;
      if (rebuilt !== line) {
        changed = true;
      }

      return rebuilt;
    });

    return changed ? normalizedLines.join("\n") : text;
  }

  function isMarkdownTableRow(line) {
    return !!canonicalizeMarkdownTableRow(line);
  }

  function collapseMarkdownTableBlankLines(text) {
    if (!text) {
      return "";
    }

    const lines = text.split("\n");
    if (lines.length < 3) {
      return text;
    }

    const compact = [];
    const findNextNonEmpty = (startIndex) => {
      for (let i = Math.max(0, startIndex); i < lines.length; i += 1) {
        if (`${lines[i] ?? ""}`.trim().length > 0) {
          return lines[i];
        }
      }
      return "";
    };

    lines.forEach((line, index) => {
      if (`${line ?? ""}`.trim().length === 0) {
        const prev = compact.length > 0 ? compact[compact.length - 1] : "";
        const next = findNextNonEmpty(index + 1);
        if (isMarkdownTableRow(prev) && isMarkdownTableRow(next)) {
          return;
        }
      }
      compact.push(line);
    });

    return compact.join("\n");
  }

  function isMarkdownTableSeparatorLine(line) {
    return !!canonicalizeMarkdownTableSeparatorLine(line);
  }

  function renderFallbackInlineMarkdown(value) {
    let html = escapeHtml(`${value ?? ""}`);
    html = html.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_\n][\s\S]*?)__/g, "<strong>$1</strong>");
    return html;
  }

  function autoResizeComposerTextarea(node) {
    if (!node) {
      return;
    }

    node.style.height = "0px";
    const nextHeight = Math.min(Math.max(node.scrollHeight, 46), 168);
    node.style.height = `${nextHeight}px`;
    node.style.overflowY = node.scrollHeight > 168 ? "auto" : "hidden";
  }

  function splitMarkdownTableCells(line) {
    const normalizedRow = canonicalizeMarkdownTableRow(line);
    if (!normalizedRow) {
      return [];
    }

    return normalizedRow
      .slice(1, -1)
      .split("|")
      .map((cell) => renderFallbackInlineMarkdown(`${cell ?? ""}`.trim()));
  }

  function renderTableAwareFallbackHtml(text) {
    const lines = `${text ?? ""}`.split("\n");
    const chunks = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (isMarkdownTableRow(line) && i + 1 < lines.length && isMarkdownTableSeparatorLine(lines[i + 1])) {
        const headerCells = splitMarkdownTableCells(line);
        i += 2;
        const bodyRows = [];
        while (i < lines.length && isMarkdownTableRow(lines[i])) {
          bodyRows.push(splitMarkdownTableCells(lines[i]));
          i += 1;
        }

        if (headerCells.length >= 2) {
          let tableHtml = "<table><thead><tr>";
          headerCells.forEach((cell) => {
            tableHtml += `<th>${cell}</th>`;
          });
          tableHtml += "</tr></thead><tbody>";
          bodyRows.forEach((cells) => {
            tableHtml += "<tr>";
            for (let ci = 0; ci < headerCells.length; ci += 1) {
              tableHtml += `<td>${cells[ci] ?? ""}</td>`;
            }
            tableHtml += "</tr>";
          });
          tableHtml += "</tbody></table>";
          chunks.push(tableHtml);
          continue;
        }
      }

      if (`${line ?? ""}`.trim().length === 0) {
        chunks.push("<br>");
      } else {
        chunks.push(renderFallbackInlineMarkdown(line));
      }
      i += 1;
    }

    return chunks.join("<br>").replace(/(?:<br>){3,}/g, "<br><br>");
  }

  function normalizeStructuredMarkdownArtifacts(value) {
    let text = `${value ?? ""}`;
    text = text.replace(
      /(^|\n)(\d+\.)\s*\n+(?=\s*(?:\*\*[^*\n]+:\*\*|[A-Za-z가-힣0-9('‘’][A-Za-z가-힣0-9()'‘’,.&+_/\-·\s]{0,80}:\s))/g,
      "$1$2 "
    );
    text = text.replace(
      /(^|\n)((?:\*\*[^*\n]+:\*\*)|(?:[A-Za-z가-힣0-9('‘’][A-Za-z가-힣0-9()'‘’,.&+_/\-·\s]{0,80}:))\s+\*\*\s+/g,
      "$1$2 "
    );
    text = text.replace(
      /(^|\n)((?:\*\*[^*\n]+:\*\*)|(?:[A-Za-z가-힣0-9('‘’][A-Za-z가-힣0-9()'‘’,.&+_/\-·\s]{0,80}:))\s+\*\*(?=\n|$)/g,
      "$1$2"
    );
    text = text.replace(
      /(^|\n)(?<lead>[-•▪]\s*)?(?<body>\d+[.)]\s*[^\n:*|]+)(?=\n|$)/g,
      (match, prefix, lead, body) => {
        const normalizedLead = `${lead ?? ""}`;
        const normalizedBody = `${body ?? ""}`.trim();
        if (!normalizedBody || /\*\*/.test(normalizedBody)) {
          return `${prefix}${normalizedLead}${normalizedBody}`;
        }

        const headline = normalizedBody.replace(/^\d+[.)]\s*/, "").trim();
        if (!headline
          || headline.length < 2
          || headline.length > 140
          || /[:：|]/.test(headline)
          || /https?:\/\//i.test(headline)
          || /^(출처|요약|핵심)/i.test(headline)
          || /(니다\.|습니다\.|다\.|요\.|[?!.])$/.test(headline)) {
          return `${prefix}${normalizedLead}${normalizedBody}`;
        }

        return `${prefix}${normalizedLead}**${normalizedBody}**`;
      }
    );
    return text;
  }

  function normalizeMarkdownSource(value) {
    let text = `${value ?? ""}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const rawLineBreakCount = countMatches(text, /\n/g);

    if (rawLineBreakCount <= 1 && /\\n/.test(text)) {
      text = text
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "  ");
    }

    text = normalizeStructuredMarkdownArtifacts(text);
    text = normalizeMarkdownTableSeparators(text);
    text = normalizeMarkdownTableBlocks(text);
    text = collapseMarkdownTableBlankLines(text);

    const markdownSignalCount =
      countMatches(text, /(^|\s)#{1,6}\s/gm)
      + countMatches(text, /(^|\s)>\s/gm)
      + countMatches(text, /(^|\s)(?:[-*+])\s/gm)
      + countMatches(text, /(^|\s)\d+\.\s/gm)
      + countMatches(text, /```/g)
      + countMatches(text, /\|\s*[-:]{3,}\s*\|/g)
      + countMatches(text, /\[[^\]]+\]\([^)]+\)/g);

    if (countMatches(text, /\n/g) <= 2 && markdownSignalCount >= 2) {
      text = text
        .replace(/\s+(?=#{1,6}\s)/g, "\n")
        .replace(/\s+(?=>\s)/g, "\n")
        .replace(/\s+(?=\d+\.\s)/g, "\n")
        .replace(/\s+(?=[*+-]\s)/g, "\n");

      if (/\|\s*[-:]{3,}\s*\|/.test(text)) {
        text = text
          .replace(/\|\s+\|/g, "|\n|")
          .replace(/\n{3,}/g, "\n\n");
      }
    }

    text = text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/([^\n])\n(?=(#{1,6}\s|[-*+]\s|\d+\.\s|>\s))/g, "$1\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return text;
  }

  function renderMarkdownToSafeHtml(value) {
    const text = normalizeMarkdownSource(value);
    let html = "";

    if (markdownRenderer) {
      html = markdownRenderer.render(text);
      if (hasMarkdownTableBlock(text) && !/<table[\s>]/i.test(html)) {
        html = renderTableAwareFallbackHtml(text);
      }
    } else {
      html = renderTableAwareFallbackHtml(text);
    }

    if (typeof window !== "undefined" && window.DOMPurify && typeof window.DOMPurify.sanitize === "function") {
      html = window.DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        ADD_TAGS: ["table", "thead", "tbody", "tr", "th", "td", "img", "hr", "sup", "sub"],
        ADD_ATTR: ["target", "rel", "class", "id"]
      });
    }

    return html;
  }

  function MarkdownBubbleText(props) {
    const hostRef = useRef(null);
    const html = useMemo(() => renderMarkdownToSafeHtml(props && props.text ? props.text : ""), [props && props.text]);

    useEffect(() => {
      if (!hostRef.current) {
        return;
      }

      if (typeof window !== "undefined" && typeof window.renderMathInElement === "function") {
        try {
          window.renderMathInElement(hostRef.current, {
            delimiters: [
              { left: "$$", right: "$$", display: true },
              { left: "$", right: "$", display: false },
              { left: "\\(", right: "\\)", display: false },
              { left: "\\[", right: "\\]", display: true }
            ],
            ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
            throwOnError: false,
            strict: "ignore"
          });
        } catch (_err) {
        }
      }
    }, [html]);

    return e("div", {
      className: "bubble-text markdown",
      ref: hostRef,
      dangerouslySetInnerHTML: { __html: html }
    });
  }

  function inferToolResultGroup(type) {
    return TOOL_RESULT_GROUP_BY_TYPE[type] || "unknown";
  }

  function inferToolResultDomain(group) {
    return TOOL_RESULT_DOMAIN_BY_GROUP[group] || "tool";
  }

  function inferToolResultAction(msg) {
    if (msg && typeof msg.action === "string" && msg.action.trim()) {
      return msg.action.trim();
    }

    switch (msg && msg.type) {
      case "sessions_list_result":
        return "list";
      case "sessions_history_result":
        return "history";
      case "sessions_send_result":
        return "send";
      case "sessions_spawn_result":
        return "spawn";
      case "web_search_result":
        return "search";
      case "web_fetch_result":
        return "fetch";
      case "memory_search_result":
        return "search";
      case "memory_get_result":
        return "get";
      case "telegram_stub_result":
        return "command";
      default:
        return "-";
    }
  }

  function inferToolResultStatus(msg) {
    if (!msg || typeof msg !== "object") {
      return { label: "-", tone: "neutral", hasError: false };
    }

    const errorText = typeof msg.error === "string" ? msg.error.trim() : "";
    const rawStatus = typeof msg.status === "string" ? msg.status.trim() : "";
    const lowerStatus = rawStatus.toLowerCase();
    const hasOkField = typeof msg.ok === "boolean";
    const okValue = hasOkField ? msg.ok : null;

    if (errorText) {
      return { label: rawStatus || "error", tone: "error", hasError: true };
    }

    if (hasOkField) {
      if (okValue) {
        return { label: rawStatus || "ok", tone: "ok", hasError: false };
      }
      return { label: rawStatus || "failed", tone: "error", hasError: true };
    }

    if (rawStatus) {
      if (
        lowerStatus.includes("error")
        || lowerStatus.includes("fail")
        || lowerStatus.includes("timeout")
        || lowerStatus.includes("denied")
        || lowerStatus.includes("invalid")
        || lowerStatus.includes("unavailable")
      ) {
        return { label: rawStatus, tone: "error", hasError: true };
      }

      if (
        lowerStatus === "ok"
        || lowerStatus === "accepted"
        || lowerStatus === "success"
        || lowerStatus === "running"
        || lowerStatus === "ready"
      ) {
        return { label: rawStatus, tone: "ok", hasError: false };
      }

      if (
        lowerStatus === "pending"
        || lowerStatus === "queued"
        || lowerStatus === "processing"
        || lowerStatus === "loading"
      ) {
        return { label: rawStatus, tone: "warn", hasError: false };
      }

      return { label: rawStatus, tone: "neutral", hasError: false };
    }

    if (msg.type === "sessions_list_result") {
      return { label: "ok", tone: "ok", hasError: false };
    }

    if (msg.type === "web_search_result") {
      if (msg.disabled === true) {
        return { label: "disabled", tone: "warn", hasError: false };
      }
      return { label: "ok", tone: "ok", hasError: false };
    }

    if (msg.type === "web_fetch_result") {
      if (msg.disabled === true) {
        return { label: "disabled", tone: "warn", hasError: false };
      }
      if (typeof msg.status === "number" && msg.status >= 400) {
        return { label: `http_${msg.status}`, tone: "error", hasError: true };
      }
      return { label: "ok", tone: "ok", hasError: false };
    }

    if (msg.type === "memory_search_result" || msg.type === "memory_get_result") {
      if (msg.disabled === true) {
        return { label: "disabled", tone: "warn", hasError: false };
      }
      return { label: "ok", tone: "ok", hasError: false };
    }

    if (msg.type === "cron_result" && msg.action === "status") {
      return { label: msg.enabled ? "enabled" : "disabled", tone: msg.enabled ? "ok" : "warn", hasError: false };
    }

    if (msg.disabled === true) {
      return { label: "disabled", tone: "warn", hasError: false };
    }

    return { label: "-", tone: "neutral", hasError: false };
  }

  function normalizeProviderName(value) {
    const lowered = `${value ?? ""}`.trim().toLowerCase();
    if (!lowered) {
      return "unknown";
    }
    if (lowered.includes("groq")) {
      return "groq";
    }
    if (lowered.includes("gemini")) {
      return "gemini";
    }
    if (lowered.includes("cerebras")) {
      return "cerebras";
    }
    if (lowered.includes("copilot")) {
      return "copilot";
    }
    if (lowered.includes("codex")) {
      return "codex";
    }
    if (lowered === "auto") {
      return "auto";
    }
    return "unknown";
  }

  function hasFailureCue(text) {
    const lowered = `${text ?? ""}`.trim().toLowerCase();
    if (!lowered) {
      return false;
    }
    return /(error|fail|timeout|denied|invalid|unavailable|unsupported|exception|오류|실패|미지원|중단|quota)/i.test(lowered);
  }

  function inferProviderExecutionStatusFromExecution(execution) {
    const raw = execution && typeof execution.status === "string" ? execution.status.trim() : "";
    const lowered = raw.toLowerCase();
    if (!raw) {
      return { label: "success", tone: "ok", hasError: false };
    }
    if (/(error|fail|timeout|cancel|killed|aborted)/i.test(lowered)) {
      return { label: raw, tone: "error", hasError: true };
    }
    if (/(running|pending|queued|processing)/i.test(lowered)) {
      return { label: raw, tone: "warn", hasError: false };
    }
    return { label: raw, tone: "ok", hasError: false };
  }

  function summarizeProviderRuntimeEntry(entry) {
    const scope = entry && entry.scope ? entry.scope : "runtime";
    const mode = entry && entry.mode ? entry.mode : "-";
    const provider = entry && entry.provider ? entry.provider : "unknown";
    const statusLabel = entry && entry.statusLabel ? entry.statusLabel : "-";
    const model = entry && entry.model ? entry.model : "-";
    const detail = entry && entry.detail ? entry.detail : "";
    return `${scope}.${mode} ${provider}/${model} ${statusLabel}${detail ? ` ${detail}` : ""}`;
  }

  function buildProviderRuntimeEventsFromMessage(msg) {
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      return [];
    }

    if (msg.type === "llm_chat_result") {
      const provider = normalizeProviderName(msg.provider);
      return [{
        provider,
        scope: "chat",
        mode: msg.mode || "single",
        model: `${msg.model || ""}`.trim(),
        statusLabel: "success",
        statusTone: "ok",
        hasError: false,
        detail: msg.route ? `route=${msg.route}` : ""
      }];
    }

    if (msg.type === "llm_chat_multi_result") {
      const providers = [
        { key: "groq", model: msg.groqModel, text: msg.groq },
        { key: "gemini", model: msg.geminiModel, text: msg.gemini },
        { key: "cerebras", model: msg.cerebrasModel, text: msg.cerebras },
        { key: "copilot", model: msg.copilotModel, text: msg.copilot },
        { key: "codex", model: msg.codexModel, text: msg.codex }
      ];
      const events = [];
      providers.forEach((item) => {
        const model = `${item.model || ""}`.trim();
        const text = `${item.text || ""}`.trim();
        if (!model && !text) {
          return;
        }
        const failed = hasFailureCue(text);
        events.push({
          provider: item.key,
          scope: "chat",
          mode: "multi",
          model,
          statusLabel: failed ? "failed" : "success",
          statusTone: failed ? "error" : "ok",
          hasError: failed,
          detail: `chars=${text.length}`
        });
      });
      return events;
    }

    if (msg.type === "coding_progress") {
      const provider = normalizeProviderName(msg.provider);
      const detailText = `${msg.phase || ""} ${msg.message || ""}`.trim();
      const finished = !!msg.done;
      const failed = finished && hasFailureCue(detailText);
      const statusLabel = finished ? (failed ? "failed" : "success") : "progress";
      const statusTone = finished ? (failed ? "error" : "ok") : "warn";
      return [{
        provider,
        scope: msg.scope || "coding",
        mode: msg.mode || "single",
        model: `${msg.model || ""}`.trim(),
        statusLabel,
        statusTone,
        hasError: failed,
        detail: `phase=${msg.phase || "-"} iter=${Number.isFinite(msg.iteration) ? msg.iteration : "-"}`
      }];
    }

    if (msg.type === "coding_result") {
      const events = [];
      const mainStatus = inferProviderExecutionStatusFromExecution(msg.execution);
      events.push({
        provider: normalizeProviderName(msg.provider),
        scope: "coding",
        mode: msg.mode || "single",
        model: `${msg.model || ""}`.trim(),
        statusLabel: mainStatus.label,
        statusTone: mainStatus.tone,
        hasError: mainStatus.hasError,
        detail: `exit=${Number.isFinite(msg && msg.execution && msg.execution.exitCode) ? msg.execution.exitCode : "-"}`
      });
      if (Array.isArray(msg.workers)) {
        msg.workers.forEach((worker) => {
          if (!worker || typeof worker !== "object") {
            return;
          }
          const workerStatus = inferProviderExecutionStatusFromExecution(worker.execution);
          events.push({
            provider: normalizeProviderName(worker.provider),
            scope: "coding",
            mode: `${msg.mode || "single"}-worker`,
            model: `${worker.model || ""}`.trim(),
            statusLabel: workerStatus.label,
            statusTone: workerStatus.tone,
            hasError: workerStatus.hasError,
            detail: `worker=${normalizeProviderName(worker.provider)}`
          });
        });
      }
      return events;
    }

    if (msg.type === "error") {
      const raw = `${msg.message || ""}`.trim();
      if (!raw) {
        return [];
      }
      if (!/(chat|coding|provider|groq|gemini|cerebras|copilot)/i.test(raw)) {
        return [];
      }
      return [{
        provider: normalizeProviderName(raw),
        scope: /coding/i.test(raw) ? "coding" : "chat",
        mode: "error",
        model: "",
        statusLabel: "failed",
        statusTone: "error",
        hasError: true,
        detail: raw
      }];
    }

    return [];
  }

  function normalizeGuardToken(value) {
    const normalized = `${value ?? ""}`.trim().toLowerCase();
    if (!normalized) {
      return "-";
    }
    return normalized.replace(/\s+/g, "_");
  }

  function isCountLockUnsatisfiedToken(value) {
    return value === "count_lock_unsatisfied"
      || value === "count_lock_unsatisfied_after_retries"
      || value === "target_count_mismatch";
  }

  function normalizeGuardNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return 0;
    }
    return Math.floor(numeric);
  }

  function formatGuardAlertThreshold(metricType, value) {
    if (metricType === "rate") {
      return `${formatDecimal(Number(value || 0) * 100, 1)}%`;
    }
    return `${normalizeGuardNumber(value)}건`;
  }

  function severityRank(severity) {
    if (severity === "critical") {
      return 3;
    }
    if (severity === "warn") {
      return 2;
    }
    if (severity === "ok") {
      return 1;
    }
    return 0;
  }

  function buildGuardAlertRuleResult(rule, metrics) {
    const total = normalizeGuardNumber(metrics && metrics.total);
    const minTotal = normalizeGuardNumber(rule && rule.minTotal);
    const metricType = rule && rule.metricType === "rate" ? "rate" : "count";
    const warn = Number(rule && rule.warn);
    const critical = Number(rule && rule.critical);
    const warnThreshold = Number.isFinite(warn) && warn >= 0 ? warn : 0;
    const criticalThreshold = Number.isFinite(critical) && critical >= 0 ? critical : warnThreshold;

    let observed = 0;
    let numeratorValue = 0;
    let denominatorLabel = "-";
    if (metricType === "rate") {
      const numerator = normalizeGuardNumber(metrics && metrics[rule.numeratorKey]);
      numeratorValue = numerator;
      observed = total > 0 ? numerator / total : 0;
      denominatorLabel = `${total}건`;
    } else {
      observed = normalizeGuardNumber(metrics && metrics[rule.valueKey]);
      numeratorValue = observed;
      denominatorLabel = `표본 ${total}건`;
    }

    if (total < minTotal) {
      return {
        id: rule.id,
        label: rule.label,
        metricType,
        observed,
        numeratorValue,
        sampleCount: total,
        minTotal,
        warnThreshold,
        criticalThreshold,
        valueLabel: metricType === "rate"
          ? `${formatGuardAlertThreshold("rate", observed)} (${denominatorLabel})`
          : formatGuardAlertThreshold("count", observed),
        warnLabel: formatGuardAlertThreshold(metricType, warnThreshold),
        criticalLabel: formatGuardAlertThreshold(metricType, criticalThreshold),
        statusLabel: "sample_pending",
        statusTone: "neutral",
        severity: "neutral",
        note: `표본 부족 (${total}/${minTotal})`
      };
    }

    let severity = "ok";
    if (observed >= criticalThreshold) {
      severity = "critical";
    } else if (observed >= warnThreshold) {
      severity = "warn";
    }

    const statusTone = severity === "critical"
      ? "error"
      : (severity === "warn" ? "warn" : "ok");

    return {
      id: rule.id,
      label: rule.label,
      metricType,
      observed,
      numeratorValue,
      sampleCount: total,
      minTotal,
      warnThreshold,
      criticalThreshold,
      valueLabel: metricType === "rate"
        ? `${formatGuardAlertThreshold("rate", observed)} (${denominatorLabel})`
        : formatGuardAlertThreshold("count", observed),
      warnLabel: formatGuardAlertThreshold(metricType, warnThreshold),
      criticalLabel: formatGuardAlertThreshold(metricType, criticalThreshold),
      statusLabel: severity,
      statusTone,
      severity,
      note: metricType === "rate" ? `분모 ${denominatorLabel}` : denominatorLabel
    };
  }

  function normalizeUtcIso(value) {
    const parsed = Date.parse(`${value || ""}`);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return new Date(parsed).toISOString();
  }

  function pickTopRetryStopReason(stopReasonCounts) {
    const entries = Object.entries(stopReasonCounts || {});
    if (entries.length === 0) {
      return "-";
    }

    entries.sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    });
    return entries[0][0] || "-";
  }

  function buildGuardRetryTimelineEntry(event, capturedAt) {
    if (!event || typeof event !== "object") {
      return null;
    }

    if (!GUARD_RETRY_TIMELINE_CHANNELS.includes(event.channel)) {
      return null;
    }

    const capturedAtUtc = normalizeUtcIso(capturedAt);
    if (!capturedAtUtc) {
      return null;
    }

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      capturedAt: capturedAtUtc,
      channel: event.channel,
      retryRequired: !!event.retryRequired,
      retryAttempt: normalizeGuardNumber(event.retryAttempt),
      retryMaxAttempts: normalizeGuardNumber(event.retryMaxAttempts),
      retryStopReason: normalizeGuardToken(event.retryStopReason)
    };
  }

  function buildGuardRetryTimelineSnapshot(entries, options = {}) {
    const configuredChannels = Array.isArray(options.channels)
      ? options.channels.filter((channel) => GUARD_OBS_CHANNEL_KEYS.includes(channel))
      : [];
    const channels = configuredChannels.length > 0
      ? configuredChannels
      : GUARD_RETRY_TIMELINE_CHANNELS.slice();
    const bucketMinutes = Math.max(
      1,
      normalizeGuardNumber(options.bucketMinutes) || GUARD_RETRY_TIMELINE_BUCKET_MINUTES
    );
    const windowMinutes = Math.max(
      bucketMinutes,
      normalizeGuardNumber(options.windowMinutes) || GUARD_RETRY_TIMELINE_WINDOW_MINUTES
    );
    const maxBucketRows = Math.max(
      1,
      normalizeGuardNumber(options.maxBucketRows) || GUARD_RETRY_TIMELINE_MAX_BUCKET_ROWS
    );
    const bucketSizeMs = bucketMinutes * 60 * 1000;
    const nowMs = Date.now();
    const windowStartMs = nowMs - (windowMinutes * 60 * 1000);

    const byChannel = {};
    channels.forEach((channel) => {
      byChannel[channel] = {
        channel,
        totalSamples: 0,
        retryRequiredSamples: 0,
        maxRetryAttempt: 0,
        maxRetryMaxAttempts: 0,
        lastRetryStopReason: "-",
        buckets: new Map()
      };
    });

    if (Array.isArray(entries)) {
      entries.forEach((entry) => {
        const channel = `${entry && entry.channel ? entry.channel : ""}`;
        if (!Object.prototype.hasOwnProperty.call(byChannel, channel)) {
          return;
        }

        const capturedAtUtc = normalizeUtcIso(entry && entry.capturedAt);
        if (!capturedAtUtc) {
          return;
        }

        const capturedAtMs = Date.parse(capturedAtUtc);
        if (!Number.isFinite(capturedAtMs) || capturedAtMs < windowStartMs) {
          return;
        }

        const retryRequired = !!(entry && entry.retryRequired);
        const retryAttempt = normalizeGuardNumber(entry && entry.retryAttempt);
        const retryMaxAttempts = normalizeGuardNumber(entry && entry.retryMaxAttempts);
        const retryStopReason = normalizeGuardToken(entry && entry.retryStopReason);
        const bucketStartMs = Math.floor(capturedAtMs / bucketSizeMs) * bucketSizeMs;
        const bucketStartUtc = new Date(bucketStartMs).toISOString();
        const channelTarget = byChannel[channel];
        channelTarget.totalSamples += 1;
        if (retryRequired) {
          channelTarget.retryRequiredSamples += 1;
        }
        channelTarget.maxRetryAttempt = Math.max(channelTarget.maxRetryAttempt, retryAttempt);
        channelTarget.maxRetryMaxAttempts = Math.max(channelTarget.maxRetryMaxAttempts, retryMaxAttempts);
        if (channelTarget.lastRetryStopReason === "-" && retryStopReason !== "-") {
          channelTarget.lastRetryStopReason = retryStopReason;
        }

        let bucketTarget = channelTarget.buckets.get(bucketStartUtc);
        if (!bucketTarget) {
          bucketTarget = {
            bucketStartUtc,
            bucketStartMs,
            samples: 0,
            retryRequiredCount: 0,
            maxRetryAttempt: 0,
            maxRetryMaxAttempts: 0,
            stopReasonCounts: {}
          };
          channelTarget.buckets.set(bucketStartUtc, bucketTarget);
        }

        bucketTarget.samples += 1;
        if (retryRequired) {
          bucketTarget.retryRequiredCount += 1;
        }
        bucketTarget.maxRetryAttempt = Math.max(bucketTarget.maxRetryAttempt, retryAttempt);
        bucketTarget.maxRetryMaxAttempts = Math.max(bucketTarget.maxRetryMaxAttempts, retryMaxAttempts);
        if (retryStopReason !== "-") {
          bucketTarget.stopReasonCounts[retryStopReason] = (bucketTarget.stopReasonCounts[retryStopReason] || 0) + 1;
        }
      });
    }

    return {
      schemaVersion: GUARD_RETRY_TIMELINE_SCHEMA_VERSION,
      generatedAtUtc: new Date().toISOString(),
      bucketMinutes,
      windowMinutes,
      channels: channels.map((channel) => {
        const channelTarget = byChannel[channel];
        const buckets = Array.from(channelTarget.buckets.values())
          .sort((a, b) => b.bucketStartMs - a.bucketStartMs)
          .slice(0, maxBucketRows)
          .map((bucket) => ({
            bucketStartUtc: bucket.bucketStartUtc,
            samples: bucket.samples,
            retryRequiredCount: bucket.retryRequiredCount,
            maxRetryAttempt: bucket.maxRetryAttempt,
            maxRetryMaxAttempts: bucket.maxRetryMaxAttempts,
            topRetryStopReason: pickTopRetryStopReason(bucket.stopReasonCounts),
            uniqueRetryStopReasons: Object.keys(bucket.stopReasonCounts).length
          }));

        return {
          channel,
          totalSamples: channelTarget.totalSamples,
          retryRequiredSamples: channelTarget.retryRequiredSamples,
          maxRetryAttempt: channelTarget.maxRetryAttempt,
          maxRetryMaxAttempts: channelTarget.maxRetryMaxAttempts,
          lastRetryStopReason: channelTarget.lastRetryStopReason,
          buckets
        };
      })
    };
  }

  function normalizeGuardRetryTimelineSnapshot(snapshot, defaults = {}) {
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }

    const channels = Array.isArray(defaults.channels)
      ? defaults.channels.filter((channel) => GUARD_RETRY_TIMELINE_CHANNELS.includes(channel))
      : GUARD_RETRY_TIMELINE_CHANNELS.slice();
    const fallbackBucketMinutes = Math.max(
      1,
      normalizeGuardNumber(defaults.bucketMinutes) || GUARD_RETRY_TIMELINE_BUCKET_MINUTES
    );
    const fallbackWindowMinutes = Math.max(
      fallbackBucketMinutes,
      normalizeGuardNumber(defaults.windowMinutes) || GUARD_RETRY_TIMELINE_WINDOW_MINUTES
    );
    const fallbackMaxBucketRows = Math.max(
      1,
      normalizeGuardNumber(defaults.maxBucketRows) || GUARD_RETRY_TIMELINE_MAX_BUCKET_ROWS
    );
    const maxBucketRows = Math.max(1, Math.min(fallbackMaxBucketRows, 288));
    const bucketMinutes = Math.max(
      1,
      normalizeGuardNumber(snapshot.bucketMinutes) || fallbackBucketMinutes
    );
    const windowMinutes = Math.max(
      bucketMinutes,
      normalizeGuardNumber(snapshot.windowMinutes) || fallbackWindowMinutes
    );
    const generatedAtUtc = normalizeUtcIso(snapshot.generatedAtUtc) || new Date().toISOString();
    const byChannel = {};

    channels.forEach((channel) => {
      byChannel[channel] = {
        channel,
        totalSamples: 0,
        retryRequiredSamples: 0,
        maxRetryAttempt: 0,
        maxRetryMaxAttempts: 0,
        lastRetryStopReason: "-",
        buckets: []
      };
    });

    if (Array.isArray(snapshot.channels)) {
      snapshot.channels.forEach((channelRow) => {
        const channel = `${channelRow && channelRow.channel ? channelRow.channel : ""}`;
        if (!Object.prototype.hasOwnProperty.call(byChannel, channel)) {
          return;
        }

        const target = byChannel[channel];
        target.totalSamples = normalizeGuardNumber(channelRow && channelRow.totalSamples);
        target.retryRequiredSamples = normalizeGuardNumber(channelRow && channelRow.retryRequiredSamples);
        target.maxRetryAttempt = normalizeGuardNumber(channelRow && channelRow.maxRetryAttempt);
        target.maxRetryMaxAttempts = normalizeGuardNumber(channelRow && channelRow.maxRetryMaxAttempts);
        target.lastRetryStopReason = normalizeGuardToken(channelRow && channelRow.lastRetryStopReason);

        if (!Array.isArray(channelRow && channelRow.buckets)) {
          return;
        }

        target.buckets = channelRow.buckets
          .map((bucket) => {
            const bucketStartUtc = normalizeUtcIso(bucket && bucket.bucketStartUtc);
            if (!bucketStartUtc) {
              return null;
            }
            return {
              bucketStartUtc,
              samples: normalizeGuardNumber(bucket && bucket.samples),
              retryRequiredCount: normalizeGuardNumber(bucket && bucket.retryRequiredCount),
              maxRetryAttempt: normalizeGuardNumber(bucket && bucket.maxRetryAttempt),
              maxRetryMaxAttempts: normalizeGuardNumber(bucket && bucket.maxRetryMaxAttempts),
              topRetryStopReason: normalizeGuardToken(bucket && bucket.topRetryStopReason),
              uniqueRetryStopReasons: normalizeGuardNumber(bucket && bucket.uniqueRetryStopReasons)
            };
          })
          .filter(Boolean)
          .sort((a, b) => (a.bucketStartUtc < b.bucketStartUtc ? 1 : -1))
          .slice(0, maxBucketRows);
      });
    }

    return {
      schemaVersion: `${snapshot.schemaVersion || GUARD_RETRY_TIMELINE_SCHEMA_VERSION}`,
      generatedAtUtc,
      bucketMinutes,
      windowMinutes,
      channels: channels.map((channel) => byChannel[channel])
    };
  }

  function buildGuardAlertPipelineEvent(guardObsStats, guardAlertSummary, guardRetryTimeline, options = {}) {
    const emittedAtUtc = typeof options.emittedAtUtc === "string" && options.emittedAtUtc.trim()
      ? options.emittedAtUtc.trim()
      : new Date().toISOString();
    const normalizeTopRows = (rows) => {
      if (!Array.isArray(rows)) {
        return [];
      }
      return rows.slice(0, 6).map((item) => ({
        name: `${item && item.name ? item.name : "-"}`,
        count: normalizeGuardNumber(item && item.count)
      }));
    };
    const countLockUnsatisfiedByChannel = {};
    const countLockUnsatisfiedRateByChannel = {};
    GUARD_OBS_CHANNEL_KEYS.forEach((channel) => {
      const channelStat = guardObsStats && guardObsStats.byChannel && guardObsStats.byChannel[channel];
      const count = normalizeGuardNumber(channelStat && channelStat.count);
      const countLockUnsatisfied = normalizeGuardNumber(channelStat && channelStat.countLockUnsatisfiedCount);
      countLockUnsatisfiedByChannel[channel] = countLockUnsatisfied;
      countLockUnsatisfiedRateByChannel[channel] = count > 0
        ? Number((countLockUnsatisfied / count).toFixed(6))
        : 0;
    });

    return {
      schemaVersion: GUARD_ALERT_PIPELINE_SCHEMA_VERSION,
      eventType: GUARD_ALERT_PIPELINE_EVENT_TYPE,
      emittedAtUtc,
      source: "omninode-dashboard",
      pipelineTargets: ["webhook", "log_collector"],
      keySourcePolicy: "keychain|secure_file_600",
      geminiKeyRequiredFor: ["test", "validation", "regression", "production_run"],
      alertSummary: {
        status: `${guardAlertSummary && guardAlertSummary.statusLabel ? guardAlertSummary.statusLabel : "sample_pending"}`,
        tone: `${guardAlertSummary && guardAlertSummary.statusTone ? guardAlertSummary.statusTone : "neutral"}`,
        triggeredCount: normalizeGuardNumber(guardAlertSummary && guardAlertSummary.triggeredCount),
        samplePendingCount: normalizeGuardNumber(guardAlertSummary && guardAlertSummary.samplePendingCount)
      },
      guardMetrics: {
        total: normalizeGuardNumber(guardObsStats && guardObsStats.total),
        blockedTotal: normalizeGuardNumber(guardObsStats && guardObsStats.blockedTotal),
        retryRequiredTotal: normalizeGuardNumber(guardObsStats && guardObsStats.retryRequiredTotal),
        countLockUnsatisfiedTotal: normalizeGuardNumber(guardObsStats && guardObsStats.countLockUnsatisfiedTotal),
        countLockUnsatisfiedByChannel,
        countLockUnsatisfiedRateByChannel,
        citationValidationFailedTotal: normalizeGuardNumber(guardObsStats && guardObsStats.citationValidationFailedTotal),
        citationMappingRetryTotal: normalizeGuardNumber(guardObsStats && guardObsStats.citationMappingRetryTotal),
        citationMappingCountTotal: normalizeGuardNumber(guardObsStats && guardObsStats.citationMappingCountTotal),
        telegramGuardMetaBlockedTotal: normalizeGuardNumber(guardObsStats && guardObsStats.telegramGuardMetaBlockedTotal)
      },
      guardAlertRows: (Array.isArray(guardObsStats && guardObsStats.guardAlertRows) ? guardObsStats.guardAlertRows : []).map((row) => ({
        id: `${row && row.id ? row.id : "-"}`,
        label: `${row && row.label ? row.label : "-"}`,
        metricType: row && row.metricType === "rate" ? "rate" : "count",
        observed: Number.isFinite(Number(row && row.observed)) ? Number(row.observed) : 0,
        numeratorValue: normalizeGuardNumber(row && row.numeratorValue),
        sampleCount: normalizeGuardNumber(row && row.sampleCount),
        minTotal: normalizeGuardNumber(row && row.minTotal),
        warnThreshold: Number.isFinite(Number(row && row.warnThreshold)) ? Number(row.warnThreshold) : 0,
        criticalThreshold: Number.isFinite(Number(row && row.criticalThreshold)) ? Number(row.criticalThreshold) : 0,
        status: `${row && row.statusLabel ? row.statusLabel : "sample_pending"}`,
        severity: `${row && row.severity ? row.severity : "neutral"}`,
        note: `${row && row.note ? row.note : "-"}`
      })),
      retryTimeline: (guardRetryTimeline && typeof guardRetryTimeline === "object")
        ? guardRetryTimeline
        : {
            schemaVersion: GUARD_RETRY_TIMELINE_SCHEMA_VERSION,
            generatedAtUtc: new Date().toISOString(),
            bucketMinutes: GUARD_RETRY_TIMELINE_BUCKET_MINUTES,
            windowMinutes: GUARD_RETRY_TIMELINE_WINDOW_MINUTES,
            channels: []
          },
      retryTop: {
        actions: normalizeTopRows(guardObsStats && guardObsStats.topRetryActions),
        reasons: normalizeTopRows(guardObsStats && guardObsStats.topRetryReasons),
        stopReasons: normalizeTopRows(guardObsStats && guardObsStats.topRetryStopReasons)
      }
    };
  }

  function inferGuardChannel(type) {
    if (type === "llm_chat_result" || type === "llm_chat_multi_result") {
      return "chat";
    }
    if (type === "coding_result") {
      return "coding";
    }
    if (type === "telegram_stub_result") {
      return "telegram";
    }
    if (type === "web_search_result") {
      return "search";
    }
    return "other";
  }

  function buildGuardObsEvent(msg) {
    if (!msg || typeof msg !== "object" || !GUARD_OBS_MESSAGE_TYPES.has(msg.type)) {
      return null;
    }

    const channel = inferGuardChannel(msg.type);
    const guardCategory = normalizeGuardToken(msg.guardCategory);
    const guardReason = normalizeGuardToken(msg.guardReason);
    const retryAction = normalizeGuardToken(msg.retryAction);
    const retryReason = normalizeGuardToken(msg.retryReason);
    const retryStopReason = normalizeGuardToken(msg.retryStopReason);
    const retryRequired = !!msg.retryRequired;
    const retryAttempt = normalizeGuardNumber(msg.retryAttempt);
    const retryMaxAttempts = normalizeGuardNumber(msg.retryMaxAttempts);
    const citationMappingCount = Array.isArray(msg.citationMappings) ? msg.citationMappings.length : 0;
    const citationValidationPassed = (msg.citationValidation && typeof msg.citationValidation.passed === "boolean")
      ? !!msg.citationValidation.passed
      : null;
    const citationValidationReason = normalizeGuardToken(msg.citationValidation && msg.citationValidation.reasonCode);
    const hasGuardFailure = guardCategory !== "-" || guardReason !== "-";
    const hasCountLockUnsatisfied =
      isCountLockUnsatisfiedToken(retryStopReason)
      || isCountLockUnsatisfiedToken(guardReason);
    const hasCitationValidationFailure = citationValidationPassed === false
      || citationValidationReason === "citation_validation_failed"
      || retryReason === "citation_validation_failed";
    const isCitationMappingRetry = retryAction === "retry_with_citation_mapping"
      || retryReason === "citation_mapping";
    const summaryParts = [
      `${channel}/${msg.type}`
    ];

    if (hasGuardFailure) {
      summaryParts.push(`guard=${guardCategory}:${guardReason}`);
    }
    if (retryAction !== "-") {
      summaryParts.push(`retry=${retryAction}`);
    }
    if (retryStopReason !== "-") {
      summaryParts.push(`stop=${retryStopReason}`);
    }
    if (hasCountLockUnsatisfied) {
      summaryParts.push("countLock=unsatisfied");
    }
    if (citationValidationPassed === true) {
      summaryParts.push("citation=pass");
    } else if (citationValidationPassed === false) {
      summaryParts.push("citation=fail");
    }
    if (citationMappingCount > 0) {
      summaryParts.push(`mapping=${citationMappingCount}`);
    }

    return {
      channel,
      type: msg.type,
      guardCategory,
      guardReason,
      retryRequired,
      retryAction,
      retryReason,
      retryAttempt,
      retryMaxAttempts,
      retryStopReason,
      citationMappingCount,
      citationValidationPassed,
      citationValidationReason,
      hasGuardFailure,
      hasCountLockUnsatisfied,
      hasCitationValidationFailure,
      isCitationMappingRetry,
      summary: summaryParts.join(" ")
    };
  }

  function App() {
    const [rootTab, setRootTab] = useState("chat");
    const [chatMode, setChatMode] = useState("single");
    const [codingMode, setCodingMode] = useState("single");

    const [status, setStatus] = useState("연결 대기");
    const [authed, setAuthed] = useState(false);
    const [authExpiry, setAuthExpiry] = useState("");
    const [authLocalOffset, setAuthLocalOffset] = useState(localUtcOffsetLabel());
    const [authTtlHours, setAuthTtlHours] = useState("24");
    const [otp, setOtp] = useState("");
    const [authMeta, setAuthMeta] = useState({ sessionId: "", telegramConfigured: false });

    const [settingsState, setSettingsState] = useState({
      telegramBotTokenSet: false,
      telegramChatIdSet: false,
      groqApiKeySet: false,
      geminiApiKeySet: false,
      cerebrasApiKeySet: false,
      codexApiKeySet: false,
      telegramBotTokenMasked: "",
      telegramChatIdMasked: "",
      groqApiKeyMasked: "",
      geminiApiKeyMasked: "",
      cerebrasApiKeyMasked: "",
      codexApiKeyMasked: ""
    });

    const [telegramBotToken, setTelegramBotToken] = useState("");
    const [telegramChatId, setTelegramChatId] = useState("");
    const [groqApiKey, setGroqApiKey] = useState("");
    const [geminiApiKey, setGeminiApiKey] = useState("");
    const [cerebrasApiKey, setCerebrasApiKey] = useState("");
    const [codexApiKey, setCodexApiKey] = useState("");
    const [persist, setPersist] = useState(true);

    const [copilotStatus, setCopilotStatus] = useState("확인 전");
    const [copilotDetail, setCopilotDetail] = useState("-");
    const [codexStatus, setCodexStatus] = useState("확인 전");
    const [codexDetail, setCodexDetail] = useState("-");
    const [groqModels, setGroqModels] = useState([]);
    const [copilotModels, setCopilotModels] = useState([]);
    const [selectedGroqModel, setSelectedGroqModel] = useState("");
    const [selectedCopilotModel, setSelectedCopilotModel] = useState("");

    const [geminiUsage, setGeminiUsage] = useState({
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      input_price_per_million_usd: "0.5000",
      output_price_per_million_usd: "3.0000",
      estimated_cost_usd: "0.000000"
    });
    const [copilotPremiumUsage, setCopilotPremiumUsage] = useState({
      available: false,
      requires_user_scope: false,
      message: "-",
      username: "",
      plan_name: "-",
      used_requests: "0.0",
      monthly_quota: "0.0",
      percent_used: "0.00",
      refreshed_local: "",
      features_url: "https://github.com/settings/copilot/features",
      billing_url: "https://github.com/settings/billing/premium_requests_usage",
      items: []
    });
    const [copilotLocalUsage, setCopilotLocalUsage] = useState({
      selected_model: "",
      selected_model_requests: 0,
      total_requests: 0,
      items: []
    });

    const [conversationLists, setConversationLists] = useState({});
    const [activeConversationByKey, setActiveConversationByKey] = useState({});
    const [conversationDetails, setConversationDetails] = useState({});
    const [expandedFoldersByKey, setExpandedFoldersByKey] = useState({});
    const [conversationFilterByKey, setConversationFilterByKey] = useState({});
    const [selectionModeByKey, setSelectionModeByKey] = useState({});
    const [selectedConversationIdsByKey, setSelectedConversationIdsByKey] = useState({});
    const [selectedFoldersByKey, setSelectedFoldersByKey] = useState({});
    const [memoryNotes, setMemoryNotes] = useState([]);
    const [selectedMemoryByConversation, setSelectedMemoryByConversation] = useState({});
    const [metaTitle, setMetaTitle] = useState("");
    const [metaProject, setMetaProject] = useState("기본");
    const [metaCategory, setMetaCategory] = useState("일반");
    const [metaTags, setMetaTags] = useState("");
    const [codingResultByConversation, setCodingResultByConversation] = useState({});
    const [memoryPreview, setMemoryPreview] = useState({ open: false, name: "", content: "" });
    const [routineOutputPreview, setRoutineOutputPreview] = useState({ open: false, title: "", content: "", imagePath: "", imageAlt: "" });
    const [memoryPickerOpen, setMemoryPickerOpen] = useState(false);
    const [threadInfoOpenByScope, setThreadInfoOpenByScope] = useState({ chat: false, coding: false });

    const [pendingByKey, setPendingByKey] = useState({});
    const [errorByKey, setErrorByKey] = useState({});
    const [optimisticUserByKey, setOptimisticUserByKey] = useState({});
    const [codingProgressByKey, setCodingProgressByKey] = useState({});
    const [filePreviewByConversation, setFilePreviewByConversation] = useState({});
    const [showExecutionLogsByConversation, setShowExecutionLogsByConversation] = useState({});
    const [attachmentsByKey, setAttachmentsByKey] = useState({});
    const [attachmentPanelOpenByKey, setAttachmentPanelOpenByKey] = useState({});
    const [attachmentDragActiveByKey, setAttachmentDragActiveByKey] = useState({});
    const [clockTick, setClockTick] = useState(Date.now());

    const [chatInputSingle, setChatInputSingle] = useState("");
    const [chatInputOrch, setChatInputOrch] = useState("");
    const [chatInputMulti, setChatInputMulti] = useState("");

    const [chatSingleProvider, setChatSingleProvider] = useState("groq");
    const [chatSingleModel, setChatSingleModel] = useState(DEFAULT_GROQ_SINGLE_MODEL);
    const [chatOrchProvider, setChatOrchProvider] = useState("auto");
    const [chatOrchModel, setChatOrchModel] = useState("");
    const [chatOrchGroqModel, setChatOrchGroqModel] = useState(DEFAULT_GROQ_WORKER_MODEL);
    const [chatOrchGeminiModel, setChatOrchGeminiModel] = useState(DEFAULT_GEMINI_WORKER_MODEL);
    const [chatOrchCerebrasModel, setChatOrchCerebrasModel] = useState(DEFAULT_CEREBRAS_MODEL);
    const [chatOrchCopilotModel, setChatOrchCopilotModel] = useState(NONE_MODEL);
    const [chatOrchCodexModel, setChatOrchCodexModel] = useState(NONE_MODEL);
    const [chatMultiGroqModel, setChatMultiGroqModel] = useState(DEFAULT_GROQ_WORKER_MODEL);
    const [chatMultiGeminiModel, setChatMultiGeminiModel] = useState(DEFAULT_GEMINI_WORKER_MODEL);
    const [chatMultiCerebrasModel, setChatMultiCerebrasModel] = useState(DEFAULT_CEREBRAS_MODEL);
    const [chatMultiCopilotModel, setChatMultiCopilotModel] = useState(NONE_MODEL);
    const [chatMultiCodexModel, setChatMultiCodexModel] = useState(NONE_MODEL);
    const [chatMultiSummaryProvider, setChatMultiSummaryProvider] = useState("gemini");
    const [chatMultiResultByConversation, setChatMultiResultByConversation] = useState({});

    const [codingInputSingle, setCodingInputSingle] = useState("");
    const [codingInputOrch, setCodingInputOrch] = useState("");
    const [codingInputMulti, setCodingInputMulti] = useState("");

    const [codingSingleProvider, setCodingSingleProvider] = useState("copilot");
    const [codingSingleModel, setCodingSingleModel] = useState("");
    const [codingSingleLanguage, setCodingSingleLanguage] = useState("auto");

    const [codingOrchProvider, setCodingOrchProvider] = useState("auto");
    const [codingOrchModel, setCodingOrchModel] = useState("");
    const [codingOrchLanguage, setCodingOrchLanguage] = useState("auto");
    const [codingOrchGroqModel, setCodingOrchGroqModel] = useState(DEFAULT_GROQ_WORKER_MODEL);
    const [codingOrchGeminiModel, setCodingOrchGeminiModel] = useState(DEFAULT_GEMINI_WORKER_MODEL);
    const [codingOrchCerebrasModel, setCodingOrchCerebrasModel] = useState(DEFAULT_CEREBRAS_MODEL);
    const [codingOrchCopilotModel, setCodingOrchCopilotModel] = useState(NONE_MODEL);
    const [codingOrchCodexModel, setCodingOrchCodexModel] = useState(NONE_MODEL);

    const [codingMultiProvider, setCodingMultiProvider] = useState("gemini");
    const [codingMultiModel, setCodingMultiModel] = useState("");
    const [codingMultiLanguage, setCodingMultiLanguage] = useState("auto");
    const [codingMultiGroqModel, setCodingMultiGroqModel] = useState(DEFAULT_GROQ_WORKER_MODEL);
    const [codingMultiGeminiModel, setCodingMultiGeminiModel] = useState(DEFAULT_GEMINI_WORKER_MODEL);
    const [codingMultiCerebrasModel, setCodingMultiCerebrasModel] = useState(DEFAULT_CEREBRAS_MODEL);
    const [codingMultiCopilotModel, setCodingMultiCopilotModel] = useState(NONE_MODEL);
    const [codingMultiCodexModel, setCodingMultiCodexModel] = useState(NONE_MODEL);

    const [command, setCommand] = useState("/metrics");
    const [metrics, setMetrics] = useState("메트릭 대기 중");
    const [logs, setLogs] = useState("");
    const [toolSessionKey, setToolSessionKey] = useState("");
    const [toolSpawnTask, setToolSpawnTask] = useState("상태 확인용 하위 세션 생성");
    const [toolSessionMessage, setToolSessionMessage] = useState("현재 상태를 간단히 요약해줘");
    const [toolCronJobId, setToolCronJobId] = useState("");
    const [toolBrowserUrl, setToolBrowserUrl] = useState("https://example.com");
    const [toolCanvasTarget, setToolCanvasTarget] = useState("main");
    const [toolNodesNode, setToolNodesNode] = useState("");
    const [toolNodesRequestId, setToolNodesRequestId] = useState("");
    const [toolNodesInvokeCommand, setToolNodesInvokeCommand] = useState("status");
    const [toolNodesInvokeParamsJson, setToolNodesInvokeParamsJson] = useState("{}");
    const [toolWebSearchQuery, setToolWebSearchQuery] = useState("오늘 미국 기준 주요 AI 뉴스");
    const [toolWebFetchUrl, setToolWebFetchUrl] = useState("https://example.com");
    const [toolMemorySearchQuery, setToolMemorySearchQuery] = useState("Omni-node 운영");
    const [toolMemoryGetPath, setToolMemoryGetPath] = useState("MEMORY.md");
    const [toolTelegramStubText, setToolTelegramStubText] = useState("/llm status");
    const [toolControlError, setToolControlError] = useState("");
    const [toolResultPreview, setToolResultPreview] = useState("결과 대기 중");
    const [toolResultItems, setToolResultItems] = useState([]);
    const [providerRuntimeItems, setProviderRuntimeItems] = useState([]);
    const [guardObsItems, setGuardObsItems] = useState([]);
    const [guardRetryTimelineItems, setGuardRetryTimelineItems] = useState([]);
    const [guardRetryTimelineApiSnapshot, setGuardRetryTimelineApiSnapshot] = useState(null);
    const [guardRetryTimelineApiFetchedAt, setGuardRetryTimelineApiFetchedAt] = useState("");
    const [guardRetryTimelineApiError, setGuardRetryTimelineApiError] = useState("");
    const [guardAlertDispatchState, setGuardAlertDispatchState] = useState({
      statusLabel: "idle",
      statusTone: "neutral",
      message: "전송 대기",
      attemptedAtUtc: "-",
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      targets: []
    });
    const [toolResultFilter, setToolResultFilter] = useState("all");
    const [toolDomainFilter, setToolDomainFilter] = useState("all");
    const [opsDomainFilter, setOpsDomainFilter] = useState("all");
    const [selectedToolResultId, setSelectedToolResultId] = useState("");
    const [routines, setRoutines] = useState([]);
    const [routineCreateForm, setRoutineCreateForm] = useState(() => createRoutineFormState());
    const [routineEditForm, setRoutineEditForm] = useState(() => createRoutineFormState());
    const [routineSelectedId, setRoutineSelectedId] = useState("");
    const [groqUsageWindowBaseByModel, setGroqUsageWindowBaseByModel] = useState({});
    const [viewportSize, setViewportSize] = useState(() => getViewportSnapshot());
    const [mainShellViewportTop, setMainShellViewportTop] = useState(0);
    const [mobilePaneByTab, setMobilePaneByTab] = useState(() => ({ ...DEFAULT_MOBILE_PANES }));

    const wsRef = useRef(null);
    const workerRef = useRef(null);
    const reconnectTimerRef = useRef(null);
    const unmountedRef = useRef(false);
    const messageListRef = useRef(null);
    const outboundQueueRef = useRef([]);
    const hasOpenedSocketRef = useRef(false);
    const autoCreateConversationRef = useRef({});
    const attachmentDragDepthRef = useRef(0);
    const currentKeyRef = useRef("");
    const groqAutoRefreshWindowRef = useRef({ minute: "", hour: "", day: "" });
    const routineBrowserAgentPreviewRef = useRef("");
    const mainShellRef = useRef(null);

    const scope = rootTab === "coding" ? "coding" : "chat";
    const mode = rootTab === "coding" ? codingMode : chatMode;
    const currentKey = `${scope}:${mode}`;
    const currentConversationList = conversationLists[currentKey] || [];
    const currentConversationId = activeConversationByKey[currentKey] || "";
    const currentConversation = currentConversationId ? conversationDetails[currentConversationId] : null;
    const currentMessages = currentConversation?.messages || [];
    const currentConversationTitle = currentConversation?.title || "대화를 선택하세요";
    const currentMemoryNotes = currentConversationId
      ? (selectedMemoryByConversation[currentConversationId] || currentConversation?.linkedMemoryNotes || [])
      : [];
    const currentCheckedMemoryNotes = memoryNotes
      .filter((note) => currentMemoryNotes.includes(note.name))
      .map((note) => note.name);
    const currentAttachments = attachmentsByKey[currentKey] || [];
    const attachmentPanelOpen = !!attachmentPanelOpenByKey[currentKey];
    const attachmentDragActive = !!attachmentDragActiveByKey[currentKey];
    const attachmentPanelVisible = attachmentPanelOpen || attachmentDragActive;
    const currentConversationFilter = conversationFilterByKey[currentKey] || "";
    const selectionMode = !!selectionModeByKey[currentKey];
    const currentSelectedConversationIds = Array.isArray(selectedConversationIdsByKey[currentKey])
      ? selectedConversationIdsByKey[currentKey]
      : [];
    const currentSelectedFolders = Array.isArray(selectedFoldersByKey[currentKey])
      ? selectedFoldersByKey[currentKey]
      : [];
    const attachmentFileInputId = `attachment-file-input-${currentKey.replace(/[^a-z0-9_-]/gi, "-")}`;
    const threadInfoScopeKey = rootTab === "coding" ? "coding" : "chat";
    const threadInfoOpen = !!threadInfoOpenByScope[threadInfoScopeKey];
    const responsiveWorkspaceKey = rootTab === "coding" ? "coding" : "chat";
    const isPortraitMobileLayout = viewportSize.width <= 920 && viewportSize.height > viewportSize.width;
    const mobileWorkspaceHeight = isPortraitMobileLayout
      ? Math.max(360, viewportSize.height - Math.max(0, mainShellViewportTop) - 12)
      : 0;
    const currentWorkspacePane = mobilePaneByTab[responsiveWorkspaceKey]
      || (currentConversationId ? "thread" : "list");
    const currentRoutinePane = mobilePaneByTab.routine || (routineSelectedId ? "detail" : "overview");
    const currentSettingsPane = mobilePaneByTab.settings || "auth";
    const groupedConversationList = useMemo(() => {
      const keyword = currentConversationFilter.trim().toLowerCase();
      const groups = {};
      currentConversationList.forEach((item) => {
        const detail = conversationDetails[item.id] || null;
        const merged = {
          ...item,
          project: detail?.project ?? item.project,
          category: detail?.category ?? item.category,
          tags: Array.isArray(detail?.tags) ? detail.tags : item.tags
        };
        const project = (merged.project || "기본").trim() || "기본";
        const category = (merged.category || "일반").trim() || "일반";
        const tags = Array.isArray(merged.tags) ? merged.tags.filter(Boolean).map((x) => `${x}`.trim()).filter(Boolean) : [];
        const title = `${merged.title || ""}`.toLowerCase();
        const preview = `${merged.preview || ""}`.toLowerCase();
        const searchable = [project.toLowerCase(), category.toLowerCase(), ...tags.map((x) => x.toLowerCase()), title, preview];
        if (keyword && !searchable.some((text) => text.includes(keyword))) {
          return;
        }

        if (!groups[project]) {
          groups[project] = [];
        }
        groups[project].push(merged);
      });

      return Object.keys(groups)
        .sort((a, b) => a.localeCompare(b, "ko"))
        .map((project) => ({
          project,
          items: groups[project].slice().sort((a, b) => (b.updatedUtc || "").localeCompare(a.updatedUtc || ""))
        }));
    }, [conversationDetails, currentConversationFilter, currentConversationList]);
    const selectedDeleteConversationIds = useMemo(() => {
      const ids = new Set();
      currentSelectedConversationIds.forEach((id) => {
        if (id) {
          ids.add(id);
        }
      });

      if (currentSelectedFolders.length > 0) {
        currentConversationList.forEach((item) => {
          const detail = conversationDetails[item.id] || null;
          const project = (detail?.project ?? item.project ?? "기본").trim() || "기본";
          if (currentSelectedFolders.includes(project)) {
            ids.add(item.id);
          }
        });
      }

      return Array.from(ids);
    }, [conversationDetails, currentConversationList, currentSelectedConversationIds, currentSelectedFolders]);

    useEffect(() => {
      if (typeof window === "undefined") {
        return undefined;
      }

      let frameId = 0;
      const syncViewportMetrics = () => {
        setViewportSize(getViewportSnapshot());
        const top = Math.max(0, Math.round(mainShellRef.current?.getBoundingClientRect().top || 0));
        setMainShellViewportTop(top);
      };
      const handleResize = () => {
        if (frameId) {
          window.cancelAnimationFrame(frameId);
        }
        frameId = window.requestAnimationFrame(() => {
          syncViewportMetrics();
        });
      };

      syncViewportMetrics();
      window.addEventListener("resize", handleResize);
      return () => {
        if (frameId) {
          window.cancelAnimationFrame(frameId);
        }
        window.removeEventListener("resize", handleResize);
      };
    }, []);

    useEffect(() => {
      if (typeof window === "undefined") {
        return;
      }
      const frameId = window.requestAnimationFrame(() => {
        const top = Math.max(0, Math.round(mainShellRef.current?.getBoundingClientRect().top || 0));
        setMainShellViewportTop(top);
      });
      return () => window.cancelAnimationFrame(frameId);
    }, [rootTab, isPortraitMobileLayout, currentWorkspacePane]);

    useEffect(() => {
      if (!isPortraitMobileLayout) {
        return;
      }

      if (currentWorkspacePane === "composer") {
        setMobilePaneByTab((prev) => ({ ...prev, [responsiveWorkspaceKey]: "thread" }));
      }

      if (!routineSelectedId && currentRoutinePane === "detail") {
        setMobilePaneByTab((prev) => ({ ...prev, routine: "overview" }));
      }
    }, [
      currentRoutinePane,
      currentWorkspacePane,
      isPortraitMobileLayout,
      responsiveWorkspaceKey,
      routineSelectedId
    ]);

    function setResponsivePane(tabKey, paneKey) {
      if (!tabKey || !paneKey) {
        return;
      }
      setMobilePaneByTab((prev) => {
        if (prev[tabKey] === paneKey) {
          return prev;
        }
        return {
          ...prev,
          [tabKey]: paneKey
        };
      });
    }

    function renderResponsiveSectionTabs(items, activeKey, onSelect, extraClassName = "") {
      return e(
        "div",
        { className: `responsive-section-tabs ${extraClassName}`.trim() },
        items.map((item) => e(
          "button",
          {
            key: item.key,
            type: "button",
            className: `responsive-section-tab-btn ${activeKey === item.key ? "active" : ""}`,
            onClick: () => onSelect(item.key)
          },
          item.label
        ))
      );
    }

    function toggleThreadInfoPanel() {
      const next = !threadInfoOpen;
      setThreadInfoOpenByScope((prev) => ({
        ...prev,
        [threadInfoScopeKey]: next
      }));
      if (isPortraitMobileLayout && next) {
        setResponsivePane(responsiveWorkspaceKey, "support");
      }
    }

    function toggleAttachmentPanel() {
      const nextValue = !attachmentPanelOpen;
      setAttachmentPanelOpenByKey((prev) => ({
        ...prev,
        [currentKey]: nextValue
      }));
      if (isPortraitMobileLayout && nextValue) {
        setResponsivePane(responsiveWorkspaceKey, "thread");
      }
    }

    function hasDraggedFiles(dataTransfer) {
      if (!dataTransfer) {
        return false;
      }

      const types = Array.from(dataTransfer.types || []);
      return (dataTransfer.files && dataTransfer.files.length > 0)
        || types.includes("Files")
        || types.includes("application/x-moz-file");
    }

    function setAttachmentDragActive(key, active) {
      const normalizedKey = `${key || currentKey}`.trim() || currentKey;
      setAttachmentDragActiveByKey((prev) => {
        const current = !!prev[normalizedKey];
        if (current === !!active) {
          return prev;
        }

        return {
          ...prev,
          [normalizedKey]: !!active
        };
      });
    }

    function clearAttachmentDragState(key) {
      attachmentDragDepthRef.current = 0;
      setAttachmentDragActive(key || currentKeyRef.current || currentKey, false);
    }

    function formatConversationUpdatedLabel(updatedUtc) {
      const raw = `${updatedUtc || ""}`.trim();
      if (!raw) {
        return "";
      }

      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        return "";
      }

      const now = new Date();
      const sameDay = parsed.toDateString() === now.toDateString();
      if (sameDay) {
        return parsed.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
      }

      const sameYear = parsed.getFullYear() === now.getFullYear();
      return sameYear
        ? parsed.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })
        : parsed.toLocaleDateString("ko-KR", { year: "numeric", month: "numeric", day: "numeric" });
    }

    function buildConversationAvatarText(item) {
      const seeds = [
        item && item.title ? `${item.title}` : "",
        item && item.project ? `${item.project}` : "",
        item && item.category ? `${item.category}` : "",
        "O"
      ];

      for (const seed of seeds) {
        const chars = Array.from(seed.trim());
        const hit = chars.find((char) => /[A-Za-z가-힣0-9]/.test(char));
        if (hit) {
          return hit.toUpperCase();
        }
      }

      return "O";
    }
    const toolResultStats = useMemo(() => {
      const byGroup = {};
      TOOL_RESULT_GROUPS.forEach((group) => {
        byGroup[group.key] = {
          count: 0,
          errorCount: 0,
          lastAction: "-",
          lastStatus: "-"
        };
      });

      let errors = 0;
      for (const item of toolResultItems) {
        if (item.hasError) {
          errors += 1;
        }

        const target = byGroup[item.group];
        if (!target) {
          continue;
        }

        if (target.count === 0) {
          target.lastAction = item.action || "-";
          target.lastStatus = item.statusLabel || "-";
        }
        target.count += 1;
        if (item.hasError) {
          target.errorCount += 1;
        }
      }

      return {
        total: toolResultItems.length,
        errors,
        byGroup
      };
    }, [toolResultItems]);
    const providerRuntimeStats = useMemo(() => {
      const byProvider = {};
      PROVIDER_RUNTIME_KEYS.forEach((provider) => {
        byProvider[provider] = {
          count: 0,
          successCount: 0,
          errorCount: 0,
          progressCount: 0,
          lastStatus: "-",
          lastScope: "-",
          lastMode: "-"
        };
      });

      for (const item of providerRuntimeItems) {
        const provider = byProvider[item.provider] ? item.provider : "unknown";
        const target = byProvider[provider];
        if (target.count === 0) {
          target.lastStatus = item.statusLabel || "-";
          target.lastScope = item.scope || "-";
          target.lastMode = item.mode || "-";
        }
        target.count += 1;
        if (item.hasError) {
          target.errorCount += 1;
        } else if (item.statusLabel === "progress") {
          target.progressCount += 1;
        } else {
          target.successCount += 1;
        }
      }

      const total = providerRuntimeItems.length;
      const errorCount = providerRuntimeItems.filter((x) => x.hasError).length;
      const progressCount = providerRuntimeItems.filter((x) => x.statusLabel === "progress").length;
      const successCount = total - errorCount - progressCount;
      const latest = total > 0 ? providerRuntimeItems[0] : null;
      return {
        total,
        errorCount,
        successCount,
        progressCount,
        latest,
        byProvider
      };
    }, [providerRuntimeItems]);
    const guardObsStats = useMemo(() => {
      const createChannelStat = () => ({
        count: 0,
        blockedCount: 0,
        retryRequiredCount: 0,
        countLockUnsatisfiedCount: 0,
        citationValidationFailedCount: 0,
        citationMappingRetryCount: 0,
        citationMappingCount: 0,
        maxRetryAttempt: 0,
        maxRetryMaxAttempts: 0,
        lastRetryAction: "-",
        lastRetryReason: "-",
        lastRetryStopReason: "-"
      });

      const byChannel = {};
      GUARD_OBS_CHANNEL_KEYS.forEach((channel) => {
        byChannel[channel] = createChannelStat();
      });

      const retryActionCounts = {};
      const retryReasonCounts = {};
      const retryStopReasonCounts = {};

      let blockedTotal = 0;
      let retryRequiredTotal = 0;
      let countLockUnsatisfiedTotal = 0;
      let citationValidationFailedTotal = 0;
      let citationMappingRetryTotal = 0;
      let citationMappingCountTotal = 0;

      for (const item of guardObsItems) {
        const channel = byChannel[item.channel] ? item.channel : "other";
        const target = byChannel[channel];
        target.count += 1;

        if (item.hasGuardFailure) {
          target.blockedCount += 1;
          blockedTotal += 1;
        }
        if (item.retryRequired) {
          target.retryRequiredCount += 1;
          retryRequiredTotal += 1;
        }
        if (item.hasCountLockUnsatisfied) {
          target.countLockUnsatisfiedCount += 1;
          countLockUnsatisfiedTotal += 1;
        }
        if (item.hasCitationValidationFailure) {
          target.citationValidationFailedCount += 1;
          citationValidationFailedTotal += 1;
        }
        if (item.isCitationMappingRetry) {
          target.citationMappingRetryCount += 1;
          citationMappingRetryTotal += 1;
        }

        if (item.citationMappingCount > 0) {
          target.citationMappingCount += item.citationMappingCount;
          citationMappingCountTotal += item.citationMappingCount;
        }

        target.maxRetryAttempt = Math.max(target.maxRetryAttempt, item.retryAttempt);
        target.maxRetryMaxAttempts = Math.max(target.maxRetryMaxAttempts, item.retryMaxAttempts);

        if (target.lastRetryAction === "-" && item.retryAction !== "-") {
          target.lastRetryAction = item.retryAction;
        }
        if (target.lastRetryReason === "-" && item.retryReason !== "-") {
          target.lastRetryReason = item.retryReason;
        }
        if (target.lastRetryStopReason === "-" && item.retryStopReason !== "-") {
          target.lastRetryStopReason = item.retryStopReason;
        }

        if (item.retryAction !== "-") {
          retryActionCounts[item.retryAction] = (retryActionCounts[item.retryAction] || 0) + 1;
        }
        if (item.retryReason !== "-") {
          retryReasonCounts[item.retryReason] = (retryReasonCounts[item.retryReason] || 0) + 1;
        }
        if (item.retryStopReason !== "-") {
          retryStopReasonCounts[item.retryStopReason] = (retryStopReasonCounts[item.retryStopReason] || 0) + 1;
        }
      }

      const toTopRows = (entries) => Object.entries(entries)
        .sort((a, b) => {
          if (b[1] !== a[1]) {
            return b[1] - a[1];
          }
          return a[0].localeCompare(b[0]);
        })
        .slice(0, 6)
        .map(([name, count]) => ({ name, count }));

      return {
        total: guardObsItems.length,
        blockedTotal,
        retryRequiredTotal,
        countLockUnsatisfiedTotal,
        citationValidationFailedTotal,
        citationMappingRetryTotal,
        citationMappingCountTotal,
        telegramGuardMetaBlockedTotal: byChannel.telegram ? byChannel.telegram.blockedCount : 0,
        byChannel,
        topRetryActions: toTopRows(retryActionCounts),
        topRetryReasons: toTopRows(retryReasonCounts),
        topRetryStopReasons: toTopRows(retryStopReasonCounts),
        guardAlertRows: (() => {
          const metrics = {
            total: guardObsItems.length,
            blockedTotal,
            retryRequiredTotal,
            countLockUnsatisfiedTotal,
            citationValidationFailedTotal,
            telegramGuardMetaBlockedTotal: byChannel.telegram ? byChannel.telegram.blockedCount : 0
          };
          return GUARD_ALERT_RULES.map((rule) => buildGuardAlertRuleResult(rule, metrics));
        })()
      };
    }, [guardObsItems]);
    const guardRetryTimelineMemorySnapshot = useMemo(
      () => buildGuardRetryTimelineSnapshot(
        guardRetryTimelineItems,
        {
          channels: GUARD_RETRY_TIMELINE_CHANNELS,
          bucketMinutes: GUARD_RETRY_TIMELINE_BUCKET_MINUTES,
          windowMinutes: GUARD_RETRY_TIMELINE_WINDOW_MINUTES,
          maxBucketRows: GUARD_RETRY_TIMELINE_MAX_BUCKET_ROWS
        }
      ),
      [guardRetryTimelineItems]
    );
    const guardRetryTimelineServerSnapshot = useMemo(
      () => normalizeGuardRetryTimelineSnapshot(
        guardRetryTimelineApiSnapshot,
        {
          channels: GUARD_RETRY_TIMELINE_CHANNELS,
          bucketMinutes: GUARD_RETRY_TIMELINE_BUCKET_MINUTES,
          windowMinutes: GUARD_RETRY_TIMELINE_WINDOW_MINUTES,
          maxBucketRows: GUARD_RETRY_TIMELINE_MAX_BUCKET_ROWS
        }
      ),
      [guardRetryTimelineApiSnapshot]
    );
    const guardRetryTimeline = useMemo(
      () => guardRetryTimelineServerSnapshot || guardRetryTimelineMemorySnapshot,
      [guardRetryTimelineMemorySnapshot, guardRetryTimelineServerSnapshot]
    );
    const guardRetryTimelineSource = guardRetryTimelineServerSnapshot ? "server_api" : "memory_fallback";
    const guardRetryTimelineRows = useMemo(() => {
      const rows = [];
      if (!guardRetryTimeline || !Array.isArray(guardRetryTimeline.channels)) {
        return rows;
      }

      guardRetryTimeline.channels.forEach((channelRow) => {
        const channel = `${channelRow && channelRow.channel ? channelRow.channel : "-"}`;
        if (!Array.isArray(channelRow && channelRow.buckets)) {
          return;
        }

        channelRow.buckets.forEach((bucket) => {
          rows.push({
            channel,
            bucketStartUtc: `${bucket && bucket.bucketStartUtc ? bucket.bucketStartUtc : "-"}`,
            samples: normalizeGuardNumber(bucket && bucket.samples),
            retryRequiredCount: normalizeGuardNumber(bucket && bucket.retryRequiredCount),
            maxRetryAttempt: normalizeGuardNumber(bucket && bucket.maxRetryAttempt),
            maxRetryMaxAttempts: normalizeGuardNumber(bucket && bucket.maxRetryMaxAttempts),
            topRetryStopReason: `${bucket && bucket.topRetryStopReason ? bucket.topRetryStopReason : "-"}`,
            uniqueRetryStopReasons: normalizeGuardNumber(bucket && bucket.uniqueRetryStopReasons)
          });
        });
      });

      rows.sort((a, b) => {
        if (a.bucketStartUtc !== b.bucketStartUtc) {
          return a.bucketStartUtc < b.bucketStartUtc ? 1 : -1;
        }
        return a.channel.localeCompare(b.channel);
      });
      return rows;
    }, [guardRetryTimeline]);
    const guardAlertSummary = useMemo(() => {
      if (!Array.isArray(guardObsStats.guardAlertRows) || guardObsStats.guardAlertRows.length === 0) {
        return {
          statusLabel: "sample_pending",
          statusTone: "neutral",
          triggeredCount: 0,
          samplePendingCount: 0
        };
      }

      let worstSeverity = "neutral";
      let triggeredCount = 0;
      let samplePendingCount = 0;

      guardObsStats.guardAlertRows.forEach((row) => {
        if (row.statusLabel === "warn" || row.statusLabel === "critical") {
          triggeredCount += 1;
        }
        if (row.statusLabel === "sample_pending") {
          samplePendingCount += 1;
        }
        if (severityRank(row.severity) > severityRank(worstSeverity)) {
          worstSeverity = row.severity;
        }
      });

      if (worstSeverity === "critical") {
        return { statusLabel: "critical", statusTone: "error", triggeredCount, samplePendingCount };
      }
      if (worstSeverity === "warn") {
        return { statusLabel: "warn", statusTone: "warn", triggeredCount, samplePendingCount };
      }
      if (worstSeverity === "ok") {
        return { statusLabel: "ok", statusTone: "ok", triggeredCount, samplePendingCount };
      }
      return { statusLabel: "sample_pending", statusTone: "neutral", triggeredCount, samplePendingCount };
    }, [guardObsStats.guardAlertRows]);
    const guardAlertPipelineEvent = useMemo(() => {
      const latestCapturedAt = guardObsItems[0] && guardObsItems[0].capturedAt
        ? guardObsItems[0].capturedAt
        : null;
      return buildGuardAlertPipelineEvent(
        guardObsStats,
        guardAlertSummary,
        guardRetryTimeline,
        latestCapturedAt ? { emittedAtUtc: latestCapturedAt } : {}
      );
    }, [guardAlertSummary, guardObsItems, guardObsStats, guardRetryTimeline]);
    const guardAlertPipelinePreview = useMemo(
      () => JSON.stringify(guardAlertPipelineEvent, null, 2),
      [guardAlertPipelineEvent]
    );
    const providerHealthRows = useMemo(() => {
      const copilotText = (copilotStatus || "").trim();
      const copilotReady = copilotText.startsWith("설치/인증 완료");
      const copilotAuthRequired = copilotText.includes("미인증");
      const copilotMissing = copilotText === "미설치";
      const codexText = (codexStatus || "").trim();
      const codexReady = codexText.startsWith("설치/인증 완료");
      const codexAuthRequired = codexText.includes("미인증");
      const codexMissing = codexText === "미설치";
      return [
        {
          provider: "groq",
          statusLabel: settingsState.groqApiKeySet ? "ready" : "api_key_missing",
          statusTone: settingsState.groqApiKeySet ? "ok" : "error",
          ready: !!settingsState.groqApiKeySet,
          reason: settingsState.groqApiKeySet ? "configured" : "Groq API 키 필요"
        },
        {
          provider: "gemini",
          statusLabel: settingsState.geminiApiKeySet ? "ready" : "api_key_missing",
          statusTone: settingsState.geminiApiKeySet ? "ok" : "error",
          ready: !!settingsState.geminiApiKeySet,
          reason: settingsState.geminiApiKeySet ? "configured" : "Gemini API 키 필요"
        },
        {
          provider: "cerebras",
          statusLabel: settingsState.cerebrasApiKeySet ? "ready" : "api_key_missing",
          statusTone: settingsState.cerebrasApiKeySet ? "ok" : "error",
          ready: !!settingsState.cerebrasApiKeySet,
          reason: settingsState.cerebrasApiKeySet ? "configured" : "Cerebras API 키 필요"
        },
        {
          provider: "copilot",
          statusLabel: copilotReady ? "ready" : (copilotAuthRequired ? "auth_required" : (copilotMissing ? "not_installed" : "unavailable")),
          statusTone: copilotReady ? "ok" : (copilotAuthRequired ? "warn" : "error"),
          ready: copilotReady,
          reason: copilotReady
            ? "설치/인증 완료"
            : (copilotAuthRequired
              ? "GitHub 인증 필요"
              : (copilotMissing ? "Copilot 미설치" : (copilotText || "상태 확인 필요")))
        },
        {
          provider: "codex",
          statusLabel: codexReady ? "ready" : (codexAuthRequired ? "auth_required" : (codexMissing ? "not_installed" : "unavailable")),
          statusTone: codexReady ? "ok" : (codexAuthRequired ? "warn" : "error"),
          ready: codexReady,
          reason: codexReady
            ? "설치/인증 완료"
            : (codexAuthRequired
              ? "Codex OAuth 또는 API Key 필요"
              : (codexMissing ? "Codex 미설치" : (codexText || "상태 확인 필요")))
        }
      ];
    }, [
      copilotStatus,
      codexStatus,
      settingsState.groqApiKeySet,
      settingsState.geminiApiKeySet,
      settingsState.cerebrasApiKeySet
    ]);
    const providerRuntimeRows = useMemo(() => {
      return providerHealthRows.map((row) => {
        const runtime = providerRuntimeStats.byProvider[row.provider] || {
          count: 0,
          successCount: 0,
          errorCount: 0,
          progressCount: 0
        };
        return {
          ...row,
          runtimeCount: runtime.count,
          runtimeSuccessCount: runtime.successCount,
          runtimeErrorCount: runtime.errorCount,
          runtimeProgressCount: runtime.progressCount
        };
      });
    }, [providerHealthRows, providerRuntimeStats]);
    const providerHealthSummary = useMemo(() => {
      const total = providerHealthRows.length;
      const readyCount = providerHealthRows.filter((row) => row.ready).length;
      const setupErrorCount = total - readyCount;
      const runtimeErrorCount = providerRuntimeStats.errorCount;
      const latest = providerRuntimeStats.latest;
      const latestText = latest
        ? `${latest.provider}:${latest.statusLabel}:${latest.scope}/${latest.mode}`
        : "-";
      const lastStatus = [
        providerHealthRows.map((row) => `${row.provider}:${row.statusLabel}`).join(", "),
        `runtime_latest=${latestText}`
      ].join(" | ");
      return {
        count: total,
        setupErrorCount,
        runtimeErrorCount,
        runtimeTotal: providerRuntimeStats.total,
        runtimeSuccessCount: providerRuntimeStats.successCount,
        runtimeProgressCount: providerRuntimeStats.progressCount,
        lastStatus,
        mainLabel: `${readyCount}/${total} ready · 실행 ${providerRuntimeStats.total}건`
      };
    }, [providerHealthRows, providerRuntimeStats]);
    const toolDomainStats = useMemo(() => {
      const byDomain = {
        tool: { count: 0, errorCount: 0, lastType: "-", lastStatus: "-" },
        rag: { count: 0, errorCount: 0, lastType: "-", lastStatus: "-" }
      };

      for (const item of toolResultItems) {
        const domain = item.domain === "rag" ? "rag" : "tool";
        const target = byDomain[domain];
        if (target.count === 0) {
          target.lastType = item.type || "-";
          target.lastStatus = item.statusLabel || "-";
        }
        target.count += 1;
        if (item.hasError) {
          target.errorCount += 1;
        }
      }

      return byDomain;
    }, [toolResultItems]);
    const opsFlowItems = useMemo(() => {
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
        .slice(0, 64);
    }, [providerRuntimeItems, toolResultItems]);
    const opsDomainStats = useMemo(() => {
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
    }, [opsFlowItems]);
    const filteredOpsFlowItems = useMemo(() => {
      return opsFlowItems.filter((item) => {
        if (opsDomainFilter === "all") {
          return true;
        }
        return item.domain === opsDomainFilter;
      });
    }, [opsDomainFilter, opsFlowItems]);
    const filteredToolResultItems = useMemo(() => {
      return toolResultItems.filter((item) => {
        if (toolResultFilter === "errors") {
          if (!item.hasError) {
            return false;
          }
        } else if (toolResultFilter !== "all" && item.group !== toolResultFilter) {
          return false;
        }

        if (toolDomainFilter !== "all" && item.domain !== toolDomainFilter) {
          return false;
        }
        return true;
      });
    }, [toolDomainFilter, toolResultFilter, toolResultItems]);

    useEffect(() => {
      if (!authed) {
        setGuardRetryTimelineApiSnapshot(null);
        setGuardRetryTimelineApiFetchedAt("");
        setGuardRetryTimelineApiError("");
        return undefined;
      }

      let cancelled = false;
      let timerId = null;
      const query = new URLSearchParams({
        bucketMinutes: String(GUARD_RETRY_TIMELINE_BUCKET_MINUTES),
        windowMinutes: String(GUARD_RETRY_TIMELINE_WINDOW_MINUTES),
        maxBucketRows: String(GUARD_RETRY_TIMELINE_MAX_BUCKET_ROWS),
        channels: GUARD_RETRY_TIMELINE_CHANNELS.join(",")
      }).toString();

      const pollRetryTimeline = async () => {
        try {
          const response = await fetch(`/api/guard/retry-timeline?${query}`, {
            method: "GET",
            cache: "no-store",
            headers: { Accept: "application/json" }
          });
          if (!response.ok) {
            throw new Error(`http_${response.status}`);
          }

          const payload = await response.json();
          const normalized = normalizeGuardRetryTimelineSnapshot(
            payload,
            {
              channels: GUARD_RETRY_TIMELINE_CHANNELS,
              bucketMinutes: GUARD_RETRY_TIMELINE_BUCKET_MINUTES,
              windowMinutes: GUARD_RETRY_TIMELINE_WINDOW_MINUTES,
              maxBucketRows: GUARD_RETRY_TIMELINE_MAX_BUCKET_ROWS
            }
          );
          if (!normalized) {
            throw new Error("invalid_schema");
          }

          if (cancelled) {
            return;
          }
          setGuardRetryTimelineApiSnapshot(normalized);
          setGuardRetryTimelineApiFetchedAt(new Date().toISOString());
          setGuardRetryTimelineApiError("");
        } catch (error) {
          if (cancelled) {
            return;
          }
          setGuardRetryTimelineApiSnapshot(null);
          setGuardRetryTimelineApiError(error instanceof Error ? error.message : "fetch_failed");
        } finally {
          if (!cancelled) {
            timerId = window.setTimeout(pollRetryTimeline, GUARD_RETRY_TIMELINE_API_REFRESH_MS);
          }
        }
      };

      pollRetryTimeline();
      return () => {
        cancelled = true;
        if (timerId !== null) {
          window.clearTimeout(timerId);
        }
      };
    }, [authed]);

    function applyDomainFocus(domain) {
      const normalized = domain === "provider" || domain === "tool" || domain === "rag" ? domain : "all";
      setOpsDomainFilter(normalized);
      if (normalized === "provider") {
        setToolDomainFilter("all");
        return;
      }
      setToolDomainFilter(normalized);
    }

    useEffect(() => {
      unmountedRef.current = false;
      setAuthExpiry(getSavedAuthExpiry());

      const worker = new Worker("/worker.js");
      worker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === "logs_updated") {
          setLogs(msg.payload || "");
          return;
        }

        if (msg.type === "ws_message") {
          handleServerMessage(msg.payload || {});
        }
      };

      workerRef.current = worker;
      connect();

      return () => {
        unmountedRef.current = true;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }

        const ws = wsRef.current;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }

        wsRef.current = null;
        outboundQueueRef.current = [];
        hasOpenedSocketRef.current = false;
        worker.terminate();
      };
    }, []);

    useEffect(() => {
      if (!chatSingleModel && selectedGroqModel) {
        setChatSingleModel(selectedGroqModel);
      }
      if (!chatOrchModel && selectedGroqModel) {
        setChatOrchModel(selectedGroqModel);
      }
      if (!chatOrchGroqModel && selectedGroqModel) {
        setChatOrchGroqModel(selectedGroqModel);
      }
      if (!chatMultiGroqModel && selectedGroqModel) {
        setChatMultiGroqModel(selectedGroqModel);
      }
      if (codingSingleProvider === "groq" && !codingSingleModel && selectedGroqModel) {
        setCodingSingleModel(selectedGroqModel);
      }
      if (codingOrchProvider === "groq" && !codingOrchModel && selectedGroqModel) {
        setCodingOrchModel(selectedGroqModel);
      }
      if (!codingOrchGroqModel && selectedGroqModel) {
        setCodingOrchGroqModel(selectedGroqModel);
      }
      if (codingMultiProvider === "groq" && !codingMultiModel && selectedGroqModel) {
        setCodingMultiModel(selectedGroqModel);
      }
    }, [
      selectedGroqModel,
      chatSingleModel,
      chatOrchModel,
      chatOrchGroqModel,
      chatMultiGroqModel,
      codingSingleProvider,
      codingSingleModel,
      codingOrchProvider,
      codingOrchModel,
      codingOrchGroqModel,
      codingMultiProvider,
      codingMultiModel
    ]);

    useEffect(() => {
      if (!chatMultiCopilotModel && selectedCopilotModel) {
        setChatMultiCopilotModel(selectedCopilotModel);
      }
      if (!chatMultiCodexModel) {
        setChatMultiCodexModel(DEFAULT_CODEX_MODEL);
      }
      if (!chatOrchCopilotModel && selectedCopilotModel) {
        setChatOrchCopilotModel(selectedCopilotModel);
      }
      if (!chatOrchCodexModel) {
        setChatOrchCodexModel(DEFAULT_CODEX_MODEL);
      }
      if (codingSingleProvider === "copilot" && !codingSingleModel && selectedCopilotModel) {
        setCodingSingleModel(selectedCopilotModel);
      }
      if (codingOrchProvider === "copilot" && !codingOrchModel && selectedCopilotModel) {
        setCodingOrchModel(selectedCopilotModel);
      }
      if (!codingOrchCopilotModel && selectedCopilotModel) {
        setCodingOrchCopilotModel(selectedCopilotModel);
      }
      if (!codingOrchCodexModel) {
        setCodingOrchCodexModel(DEFAULT_CODEX_MODEL);
      }
      if (codingMultiProvider === "copilot" && !codingMultiModel && selectedCopilotModel) {
        setCodingMultiModel(selectedCopilotModel);
      }
      if (!codingMultiCodexModel) {
        setCodingMultiCodexModel(DEFAULT_CODEX_MODEL);
      }
    }, [
      selectedCopilotModel,
      chatMultiCopilotModel,
      chatMultiCodexModel,
      chatOrchCopilotModel,
      chatOrchCodexModel,
      codingSingleProvider,
      codingSingleModel,
      codingOrchProvider,
      codingOrchModel,
      codingOrchCopilotModel,
      codingOrchCodexModel,
      codingMultiProvider,
      codingMultiModel,
      codingMultiCodexModel
    ]);

    useEffect(() => {
      requestConversations(scope, mode);
    }, [scope, mode]);

    useEffect(() => {
      currentKeyRef.current = currentKey;
      attachmentDragDepthRef.current = 0;

      function handleWindowDragEnter(event) {
        if (!hasDraggedFiles(event.dataTransfer)) {
          return;
        }

        event.preventDefault();
        attachmentDragDepthRef.current += 1;
        setAttachmentDragActive(currentKey, true);
      }

      function handleWindowDragOver(event) {
        if (!hasDraggedFiles(event.dataTransfer)) {
          return;
        }

        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "copy";
        }

        if (attachmentDragDepthRef.current <= 0) {
          attachmentDragDepthRef.current = 1;
        }
        setAttachmentDragActive(currentKey, true);
      }

      function handleWindowDragLeave(event) {
        if (!hasDraggedFiles(event.dataTransfer)) {
          return;
        }

        event.preventDefault();
        attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
        if (attachmentDragDepthRef.current === 0) {
          setAttachmentDragActive(currentKey, false);
        }
      }

      function handleWindowDrop(event) {
        if (!hasDraggedFiles(event.dataTransfer)) {
          return;
        }

        event.preventDefault();
        clearAttachmentDragState(currentKey);
      }

      window.addEventListener("dragenter", handleWindowDragEnter);
      window.addEventListener("dragover", handleWindowDragOver);
      window.addEventListener("dragleave", handleWindowDragLeave);
      window.addEventListener("drop", handleWindowDrop);

      return () => {
        window.removeEventListener("dragenter", handleWindowDragEnter);
        window.removeEventListener("dragover", handleWindowDragOver);
        window.removeEventListener("dragleave", handleWindowDragLeave);
        window.removeEventListener("drop", handleWindowDrop);
        attachmentDragDepthRef.current = 0;
        setAttachmentDragActive(currentKey, false);
      };
    }, [currentKey]);

    useEffect(() => {
      if (!currentConversation) {
        setMetaTitle("");
        setMetaProject("기본");
        setMetaCategory("일반");
        setMetaTags("");
        return;
      }

      setMetaTitle(currentConversation.title || "");
      setMetaProject(currentConversation.project || "기본");
      setMetaCategory(currentConversation.category || "일반");
      setMetaTags(Array.isArray(currentConversation.tags) ? currentConversation.tags.join(", ") : "");
    }, [currentConversationId, currentConversation]);

    useEffect(() => {
      const panel = messageListRef.current;
      if (!panel) {
        return;
      }

      panel.scrollTop = panel.scrollHeight;
    }, [currentConversationId, currentMessages, optimisticUserByKey[currentKey], pendingByKey[currentKey], errorByKey[currentKey]]);

    useEffect(() => {
      const timer = setInterval(() => setClockTick(Date.now()), 1000);
      return () => clearInterval(timer);
    }, []);

    useEffect(() => {
      if (!Array.isArray(groqModels) || groqModels.length === 0) {
        return;
      }

      const windowKeys = buildTimeWindowKeys(clockTick);
      setGroqUsageWindowBaseByModel((prev) => {
        let changed = false;
        const next = { ...prev };

        groqModels.forEach((item) => {
          const modelId = (item && item.id ? item.id : "").trim();
          if (!modelId) {
            return;
          }

          const totalRequests = Number(item.usage_requests || 0);
          const totalTokens = Number(item.usage_total_tokens || 0);
          const current = next[modelId] ? { ...next[modelId] } : {};

          if (current.minuteKey !== windowKeys.minute) {
            current.minuteKey = windowKeys.minute;
            current.minuteRequests = totalRequests;
            current.minuteTokens = totalTokens;
            changed = true;
          }
          if (current.hourKey !== windowKeys.hour) {
            current.hourKey = windowKeys.hour;
            current.hourRequests = totalRequests;
            current.hourTokens = totalTokens;
            changed = true;
          }
          if (current.dayKey !== windowKeys.day) {
            current.dayKey = windowKeys.day;
            current.dayRequests = totalRequests;
            current.dayTokens = totalTokens;
            changed = true;
          }

          next[modelId] = current;
        });

        return changed ? next : prev;
      });
    }, [clockTick, groqModels]);

    useEffect(() => {
      if (!authed) {
        return;
      }

      const windowKeys = buildTimeWindowKeys(clockTick);
      const previous = groqAutoRefreshWindowRef.current || { minute: "", hour: "", day: "" };
      const changed = previous.minute !== windowKeys.minute
        || previous.hour !== windowKeys.hour
        || previous.day !== windowKeys.day;

      if (!changed) {
        return;
      }

      groqAutoRefreshWindowRef.current = windowKeys;
      send({ type: "get_groq_models" }, { silent: true, queueIfClosed: false });
    }, [authed, clockTick]);

    function getSavedAuthToken() {
      try {
        return window.localStorage.getItem(AUTH_TOKEN_KEY) || "";
      } catch (_err) {
        return "";
      }
    }

    function getSavedAuthExpiry() {
      try {
        return window.localStorage.getItem(AUTH_EXPIRES_KEY) || "";
      } catch (_err) {
        return "";
      }
    }

    function saveAuthToken(token, expiresAtUtc) {
      try {
        if (token) {
          window.localStorage.setItem(AUTH_TOKEN_KEY, token);
        }
        if (expiresAtUtc) {
          window.localStorage.setItem(AUTH_EXPIRES_KEY, expiresAtUtc);
        }
      } catch (_err) {
      }

      setAuthExpiry(expiresAtUtc || "");
    }

    function clearAuthToken() {
      try {
        window.localStorage.removeItem(AUTH_TOKEN_KEY);
        window.localStorage.removeItem(AUTH_EXPIRES_KEY);
      } catch (_err) {
      }

      setAuthExpiry("");
    }

    function log(text, level) {
      if (workerRef.current) {
        workerRef.current.postMessage({ type: "log", payload: text, level: level || "info" });
      }
    }

    function wsUrl() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      return `${proto}://${window.location.host}/ws/`;
    }

    function connect() {
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        return;
      }

      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      setStatus("연결 중");

      ws.onopen = () => {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }

        const token = getSavedAuthToken();
        setStatus(token ? "연결됨 / 세션 인증 확인 중" : "연결됨 / OTP 대기");
        setAuthed(false);
        hasOpenedSocketRef.current = true;
        flushQueuedMessages();
        sendInitialRequests();
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (unmountedRef.current) {
          return;
        }

        setStatus("연결 끊김 / 재연결 중");
        setAuthed(false);
        setAuthMeta({ sessionId: "", telegramConfigured: false });
        scheduleReconnect();
      };

      ws.onerror = () => {
        log("WebSocket 에러", "error");
      };

      ws.onmessage = (event) => {
        if (workerRef.current) {
          workerRef.current.postMessage({ type: "parse_ws", payload: event.data });
        }
      };
    }

    function sendInitialRequests() {
      const token = getSavedAuthToken();
      if (token) {
        send({ type: "resume_auth", authToken: token });
      }

      send({ type: "get_settings" });
      send({ type: "get_copilot_status" });
      send({ type: "get_codex_status" });
      send({ type: "get_groq_models" });
      send({ type: "get_copilot_models" });
      send({ type: "get_usage_stats" });
      send({ type: "list_memory_notes" });
      ["chat", "coding"].forEach((s) => {
        ["single", "orchestration", "multi"].forEach((m) => {
          send({ type: "list_conversations", scope: s, mode: m });
        });
      });
    }

    function flushQueuedMessages() {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (outboundQueueRef.current.length === 0) {
        return;
      }

      const queued = outboundQueueRef.current.splice(0, outboundQueueRef.current.length);
      queued.forEach((payload) => {
        try {
          ws.send(JSON.stringify(payload));
        } catch (_err) {
        }
      });
    }

    function scheduleReconnect() {
      if (unmountedRef.current || reconnectTimerRef.current) {
        return;
      }

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, 1200);
    }

    function send(payload, options = {}) {
      const ws = wsRef.current;
      const silent = !!options.silent;
      const queueIfClosed = !!options.queueIfClosed;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (queueIfClosed) {
          outboundQueueRef.current.push(payload);
        }
        if (!silent && hasOpenedSocketRef.current) {
          log("WS 연결이 필요합니다.", "error");
        }
        return false;
      }

      ws.send(JSON.stringify(payload));
      return true;
    }

    function setError(key, value) {
      setErrorByKey((prev) => ({ ...prev, [key]: value || "" }));
    }

    function beginPendingRequest(key, userText, isCoding, conversationId) {
      const now = Date.now();
      const normalizedConversationId = (conversationId || "").trim();
      setPendingByKey((prev) => ({
        ...prev,
        [key]: {
          active: true,
          conversationId: normalizedConversationId,
          startedUtc: new Date(now).toISOString(),
          updatedAt: now,
          draftText: "",
          provider: "",
          model: "",
          route: "",
          chunkIndex: 0
        }
      }));
      setError(key, "");
      setOptimisticUserByKey((prev) => ({
        ...prev,
        [key]: {
          text: userText,
          createdUtc: new Date(now).toISOString(),
          conversationId: normalizedConversationId
        }
      }));

      if (isCoding) {
        setCodingProgressByKey((prev) => ({
          ...prev,
          [key]: {
            phase: "queued",
            message: "요청 접수됨",
            iteration: 0,
            maxIterations: 0,
            percent: 1,
            done: false,
            provider: "",
            model: "",
            conversationId: normalizedConversationId,
            startedAt: now,
            updatedAt: now
          }
        }));
      }
    }

    function finishPendingRequest(key) {
      setPendingByKey((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setOptimisticUserByKey((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setCodingProgressByKey((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }

    function isRequestPending(key) {
      const pendingEntry = pendingByKey[key];
      return !!(pendingEntry && pendingEntry.active);
    }

    function isConversationBoundEntryVisible(entry, conversationId) {
      if (!entry) {
        return false;
      }

      const entryConversationId = (entry.conversationId || "").trim();
      const targetConversationId = (conversationId || "").trim();
      if (!entryConversationId && !targetConversationId) {
        return true;
      }
      return entryConversationId === targetConversationId;
    }

    function elapsedSeconds(progress) {
      if (!progress || !progress.startedAt) {
        return 0;
      }

      return Math.max(0, Math.floor((clockTick - progress.startedAt) / 1000));
    }

    function humanPath(pathValue, runDir) {
      const value = pathValue || "";
      if (!value) {
        return "-";
      }

      if (runDir && value.startsWith(runDir)) {
        return value.slice(runDir.length).replace(/^\/+/, "");
      }

      return value;
    }

    function sanitizeCodingAssistantText(text) {
      const value = (text || "").replace(/\r\n/g, "\n");
      if (!value) {
        return "";
      }

      return value.replace(/\n{3,}/g, "\n\n").trim();
    }

    function requestWorkspaceFilePreview(filePath, conversationId) {
      if (!filePath) {
        return;
      }

      send({
        type: "read_workspace_file",
        filePath,
        conversationId: conversationId || undefined
      });
    }

    function inferErrorKey(messageText) {
      const text = (messageText || "").toLowerCase();
      if (text.includes("routine")) {
        return "routine:main";
      }
      if (text.includes("chat_single")) {
        return "chat:single";
      }
      if (text.includes("chat_orchestration")) {
        return "chat:orchestration";
      }
      if (text.includes("chat_multi")) {
        return "chat:multi";
      }
      if (text.includes("coding_single") || text.includes("coding_run_single")) {
        return "coding:single";
      }
      if (text.includes("coding_orchestration") || text.includes("coding_run_orchestration")) {
        return "coding:orchestration";
      }
      if (text.includes("coding_multi") || text.includes("coding_run_multi")) {
        return "coding:multi";
      }

      return currentKey;
    }

    function requestConversations(targetScope, targetMode) {
      send(
        { type: "list_conversations", scope: targetScope, mode: targetMode },
        { silent: true, queueIfClosed: false }
      );
    }

    function requestConversationDetail(conversationId) {
      if (!conversationId) {
        return;
      }

      send({ type: "get_conversation", conversationId });
    }

    function parseTags(value) {
      if (!value) {
        return [];
      }

      return value
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
    }

    function createConversation(targetScope, targetMode, title, project, category, tags) {
      return send({
        type: "create_conversation",
        scope: targetScope,
        mode: targetMode,
        conversationTitle: title || `${targetScope}-${targetMode}-${new Date().toLocaleTimeString("ko-KR", { hour12: false })}`,
        project: (project || "").trim() || undefined,
        category: (category || "").trim() || undefined,
        tags: Array.isArray(tags) && tags.length > 0 ? tags : undefined
      });
    }

    function requestAutoCreateConversation(targetScope, targetMode, title, project, category, tags) {
      const normalizedScope = targetScope || "chat";
      const normalizedMode = targetMode || "single";
      const key = `${normalizedScope}:${normalizedMode}`;
      if (autoCreateConversationRef.current[key]) {
        return;
      }

      autoCreateConversationRef.current[key] = true;
      const sent = createConversation(normalizedScope, normalizedMode, title, project, category, tags);
      if (!sent) {
        autoCreateConversationRef.current[key] = false;
      }
    }

    function saveConversationMeta() {
      if (!currentConversationId) {
        return;
      }

      const baseTitle = (currentConversation && currentConversation.title ? currentConversation.title : "").trim();
      const nextTitle = metaTitle.trim() || baseTitle || "제목 없음";
      const nextProject = metaProject.trim() || "기본";
      const nextCategory = metaCategory.trim() || "일반";
      const nextTags = parseTags(metaTags);
      setMetaTitle(nextTitle);

      setConversationDetails((prev) => {
        const base = prev[currentConversationId];
        if (!base) {
          return prev;
        }

        return {
          ...prev,
          [currentConversationId]: {
            ...base,
            title: nextTitle,
            project: nextProject,
            category: nextCategory,
            tags: nextTags
          }
        };
      });
      setConversationLists((prev) => {
        let changed = false;
        const next = {};
        Object.keys(prev).forEach((key) => {
          const list = Array.isArray(prev[key]) ? prev[key] : [];
          const updated = list.map((item) => {
            if (item.id !== currentConversationId) {
              return item;
            }
            changed = true;
            return {
              ...item,
              title: nextTitle,
              project: nextProject,
              category: nextCategory,
              tags: nextTags
            };
          });
          next[key] = updated;
        });
        return changed ? next : prev;
      });

      send({
        type: "update_conversation_meta",
        conversationId: currentConversationId,
        conversationTitle: nextTitle,
        project: nextProject,
        category: nextCategory,
        tags: nextTags
      });
    }

    function deleteConversation() {
      const targetIds = selectionMode
        ? selectedDeleteConversationIds
        : (currentConversationId ? [currentConversationId] : []);
      if (targetIds.length === 0) {
        return;
      }

      const folderCount = currentSelectedFolders.length;
      const conversationCount = currentSelectedConversationIds.length;
      const message = selectionMode
        ? `선택한 항목을 삭제할까요?\n폴더 ${folderCount}개, 대화 ${conversationCount}개 선택됨\n실제 삭제 대상 대화 ${targetIds.length}개`
        : "현재 대화를 삭제할까요?";
      const confirmed = window.confirm(message);
      if (!confirmed) {
        return;
      }

      targetIds.forEach((conversationId) => {
        send({
          type: "delete_conversation",
          scope,
          mode,
          conversationId
        }, { silent: true, queueIfClosed: false });
      });

      if (selectionMode) {
        setSelectedConversationIdsByKey((prev) => ({ ...prev, [currentKey]: [] }));
        setSelectedFoldersByKey((prev) => ({ ...prev, [currentKey]: [] }));
      }
    }

    function clearScopeMemory(targetScope) {
      if (!ensureAuthed()) {
        return;
      }

      const normalizedScope = String(targetScope || scope || "chat").toLowerCase();
      const label = normalizedScope === "coding" ? "코딩 탭" : "대화 탭(+텔레그램)";
      const confirmed = window.confirm(`${label} 메모리를 초기화할까요?\n대화 이력과 메모리 노트가 삭제됩니다.`);
      if (!confirmed) {
        return;
      }

      send({
        type: "clear_memory",
        scope: normalizedScope
      });
    }

    function createManualMemoryNote(compactConversation = false) {
      if (!currentConversationId) {
        return;
      }

      send({
        type: "create_memory_note",
        conversationId: currentConversationId,
        compactConversation
      });
    }

    function renameMemoryNote(noteName) {
      const currentName = String(noteName || "").trim();
      if (!currentName) {
        return;
      }

      const nextName = window.prompt("새 메모리 노트 이름", currentName);
      if (typeof nextName !== "string") {
        return;
      }

      const trimmed = nextName.trim();
      if (!trimmed || trimmed === currentName) {
        return;
      }

      send({
        type: "rename_memory_note",
        noteName: currentName,
        newName: trimmed
      });
    }

    function deleteSelectedMemoryNotes() {
      if (currentCheckedMemoryNotes.length === 0) {
        return;
      }

      const confirmed = window.confirm(`체크된 메모리 노트 ${currentCheckedMemoryNotes.length}개를 삭제할까요?`);
      if (!confirmed) {
        return;
      }

      send({
        type: "delete_memory_notes",
        memoryNotes: currentCheckedMemoryNotes
      });
    }

    function selectConversation(item) {
      const key = `${item.scope}:${item.mode}`;
      setActiveConversationByKey((prev) => ({ ...prev, [key]: item.id }));
      if (isPortraitMobileLayout) {
        setResponsivePane(item.scope === "coding" ? "coding" : "chat", "thread");
      }
      requestConversationDetail(item.id);
    }

    function buildThreadPreviewMeta() {
      const previewTags = parseTags(metaTags).slice(0, 6);
      const previewProject = metaProject.trim() || "기본";
      const previewCategory = metaCategory.trim() || "일반";
      return {
        previewTags,
        previewProject,
        previewCategory
      };
    }

    function toggleSelectionMode() {
      const nextValue = !selectionMode;
      setSelectionModeByKey((prev) => ({ ...prev, [currentKey]: nextValue }));
      if (!nextValue) {
        setSelectedConversationIdsByKey((prev) => ({ ...prev, [currentKey]: [] }));
        setSelectedFoldersByKey((prev) => ({ ...prev, [currentKey]: [] }));
      }
    }

    function toggleFolderSelection(projectName) {
      const normalized = (projectName || "기본").trim() || "기본";
      setSelectedFoldersByKey((prev) => {
        const base = Array.isArray(prev[currentKey]) ? prev[currentKey] : [];
        const next = base.includes(normalized)
          ? base.filter((item) => item !== normalized)
          : base.concat([normalized]);
        return { ...prev, [currentKey]: next };
      });
    }

    function toggleConversationSelection(conversationId) {
      const normalized = String(conversationId || "").trim();
      if (!normalized) {
        return;
      }

      setSelectedConversationIdsByKey((prev) => {
        const base = Array.isArray(prev[currentKey]) ? prev[currentKey] : [];
        const next = base.includes(normalized)
          ? base.filter((item) => item !== normalized)
          : base.concat([normalized]);
        return { ...prev, [currentKey]: next };
      });
    }

    function buildFolderKey(scopeModeKey, projectName) {
      const project = (projectName || "기본").trim() || "기본";
      return `${scopeModeKey}::${project}`;
    }

    function toggleFolder(scopeModeKey, projectName) {
      const key = buildFolderKey(scopeModeKey, projectName);
      setExpandedFoldersByKey((prev) => ({ ...prev, [key]: !prev[key] }));
    }

    function isFolderExpanded(scopeModeKey, projectName) {
      return !!expandedFoldersByKey[buildFolderKey(scopeModeKey, projectName)];
    }

    function ensureAuthed() {
      if (authed) {
        return true;
      }

      setError(rootTab === "routine" ? "routine:main" : currentKey, "OTP 인증 후 사용 가능합니다.");
      return false;
    }

    function sendChatSingle() {
      if (!ensureAuthed()) {
        return;
      }

      const text = chatInputSingle.trim();
      const rich = getRichInputPayload(text);
      const effectiveText = text || (rich.attachments.length > 0 ? "첨부 파일을 분석해줘" : "");
      if (!effectiveText) {
        return;
      }

      const model = chatSingleProvider === "groq"
        ? (chatSingleModel || selectedGroqModel || undefined)
        : chatSingleProvider === "copilot"
          ? (chatSingleModel || selectedCopilotModel || undefined)
          : chatSingleProvider === "codex"
            ? (chatSingleModel || DEFAULT_CODEX_MODEL)
          : chatSingleProvider === "gemini"
            ? (isNoneModel(chatSingleModel) ? DEFAULT_GEMINI_WORKER_MODEL : (chatSingleModel || DEFAULT_GEMINI_WORKER_MODEL))
          : chatSingleProvider === "cerebras"
            ? (chatSingleModel || DEFAULT_CEREBRAS_MODEL)
          : undefined;
      const conversationId = activeConversationByKey["chat:single"] || "";
      beginPendingRequest("chat:single", effectiveText, false, conversationId);
      setChatInputSingle("");

      const ok = send({
        type: "llm_chat_single",
        scope: "chat",
        mode: "single",
        conversationId: conversationId || undefined,
        text: effectiveText,
        project: metaProject.trim() || "기본",
        category: metaCategory.trim() || "일반",
        tags: parseTags(metaTags),
        provider: chatSingleProvider,
        model,
        memoryNotes: currentMemoryNotes,
        attachments: rich.attachments,
        webUrls: rich.webUrls,
        webSearchEnabled: rich.webSearchEnabled
      });

      if (!ok) {
        finishPendingRequest("chat:single");
        setError("chat:single", "오류: WebSocket 연결이 끊어졌습니다.");
      } else {
        clearRichInputDraft("chat:single");
      }
    }

    function sendChatOrchestration() {
      if (!ensureAuthed()) {
        return;
      }

      const text = chatInputOrch.trim();
      const rich = getRichInputPayload(text);
      const effectiveText = text || (rich.attachments.length > 0 ? "첨부 파일을 분석해줘" : "");
      if (!effectiveText) {
        return;
      }

      const model = chatOrchProvider === "groq"
        ? (chatOrchModel || selectedGroqModel || undefined)
        : chatOrchProvider === "copilot"
          ? (chatOrchModel || selectedCopilotModel || undefined)
          : chatOrchProvider === "codex"
            ? (chatOrchModel || chatOrchCodexModel || DEFAULT_CODEX_MODEL)
          : chatOrchProvider === "gemini"
            ? ((!isNoneModel(chatOrchModel) ? chatOrchModel : "")
              || (!isNoneModel(chatOrchGeminiModel) ? chatOrchGeminiModel : DEFAULT_GEMINI_WORKER_MODEL))
            : chatOrchProvider === "cerebras"
              ? (chatOrchModel || chatOrchCerebrasModel || DEFAULT_CEREBRAS_MODEL)
            : undefined;
      const workerGroqModel = normalizeModelChoice(chatOrchGroqModel, DEFAULT_GROQ_WORKER_MODEL);
      const workerGeminiModel = normalizeModelChoice(chatOrchGeminiModel, DEFAULT_GEMINI_WORKER_MODEL);
      const workerCerebrasModel = normalizeModelChoice(chatOrchCerebrasModel, DEFAULT_CEREBRAS_MODEL);
      const workerCopilotModel = normalizeModelChoice(chatOrchCopilotModel, NONE_MODEL);
      const workerCodexModel = normalizeModelChoice(chatOrchCodexModel, DEFAULT_CODEX_MODEL);
      const conversationId = activeConversationByKey["chat:orchestration"] || "";
      beginPendingRequest("chat:orchestration", effectiveText, false, conversationId);
      setChatInputOrch("");

      const ok = send({
        type: "llm_chat_orchestration",
        scope: "chat",
        mode: "orchestration",
        conversationId: conversationId || undefined,
        text: effectiveText,
        project: metaProject.trim() || "기본",
        category: metaCategory.trim() || "일반",
        tags: parseTags(metaTags),
        provider: chatOrchProvider,
        model,
        groqModel: workerGroqModel,
        geminiModel: workerGeminiModel,
        cerebrasModel: workerCerebrasModel,
        copilotModel: workerCopilotModel,
        codexModel: workerCodexModel,
        memoryNotes: currentMemoryNotes,
        attachments: rich.attachments,
        webUrls: rich.webUrls,
        webSearchEnabled: rich.webSearchEnabled
      });

      if (!ok) {
        finishPendingRequest("chat:orchestration");
        setError("chat:orchestration", "오류: WebSocket 연결이 끊어졌습니다.");
      } else {
        clearRichInputDraft("chat:orchestration");
      }
    }

    function sendChatMulti() {
      if (!ensureAuthed()) {
        return;
      }

      const text = chatInputMulti.trim();
      const rich = getRichInputPayload(text);
      const effectiveText = text || (rich.attachments.length > 0 ? "첨부 파일을 분석해줘" : "");
      if (!effectiveText) {
        return;
      }

      const conversationId = activeConversationByKey["chat:multi"] || "";
      beginPendingRequest("chat:multi", effectiveText, false, conversationId);
      setChatInputMulti("");

      const ok = send({
        type: "llm_chat_multi",
        scope: "chat",
        mode: "multi",
        conversationId: conversationId || undefined,
        text: effectiveText,
        project: metaProject.trim() || "기본",
        category: metaCategory.trim() || "일반",
        tags: parseTags(metaTags),
        groqModel: normalizeModelChoice(chatMultiGroqModel, DEFAULT_GROQ_WORKER_MODEL),
        geminiModel: normalizeModelChoice(chatMultiGeminiModel, DEFAULT_GEMINI_WORKER_MODEL),
        cerebrasModel: normalizeModelChoice(chatMultiCerebrasModel, DEFAULT_CEREBRAS_MODEL),
        copilotModel: normalizeModelChoice(chatMultiCopilotModel, NONE_MODEL),
        codexModel: normalizeModelChoice(chatMultiCodexModel, DEFAULT_CODEX_MODEL),
        summaryProvider: chatMultiSummaryProvider,
        memoryNotes: currentMemoryNotes,
        attachments: rich.attachments,
        webUrls: rich.webUrls,
        webSearchEnabled: rich.webSearchEnabled
      });

      if (!ok) {
        finishPendingRequest("chat:multi");
        setError("chat:multi", "오류: WebSocket 연결이 끊어졌습니다.");
      } else {
        clearRichInputDraft("chat:multi");
      }
    }

    function sendCodingSingle() {
      if (!ensureAuthed()) {
        return;
      }

      const text = codingInputSingle.trim();
      const rich = getRichInputPayload(text);
      const effectiveText = text || (rich.attachments.length > 0 ? "첨부 파일을 반영해 코딩해줘" : "");
      if (!effectiveText) {
        return;
      }

      const conversationId = activeConversationByKey["coding:single"] || "";
      beginPendingRequest("coding:single", effectiveText, true, conversationId);
      setCodingInputSingle("");

      const ok = send({
        type: "coding_run_single",
        scope: "coding",
        mode: "single",
        conversationId: conversationId || undefined,
        text: effectiveText,
        project: metaProject.trim() || "기본",
        category: metaCategory.trim() || "일반",
        tags: parseTags(metaTags),
        provider: codingSingleProvider,
        model: codingSingleProvider === "gemini"
          ? (isNoneModel(codingSingleModel) ? DEFAULT_GEMINI_WORKER_MODEL : (codingSingleModel || DEFAULT_GEMINI_WORKER_MODEL))
          : codingSingleProvider === "codex"
            ? (codingSingleModel || DEFAULT_CODEX_MODEL)
            : (codingSingleModel || undefined),
        language: codingSingleLanguage,
        memoryNotes: currentMemoryNotes,
        attachments: rich.attachments,
        webUrls: rich.webUrls,
        webSearchEnabled: rich.webSearchEnabled
      });

      if (!ok) {
        finishPendingRequest("coding:single");
        setError("coding:single", "오류: WebSocket 연결이 끊어졌습니다.");
      } else {
        clearRichInputDraft("coding:single");
      }
    }

    function sendCodingOrchestration() {
      if (!ensureAuthed()) {
        return;
      }

      const text = codingInputOrch.trim();
      const rich = getRichInputPayload(text);
      const pendingLabel = text || (rich.attachments.length > 0 ? "첨부 파일 반영 코딩" : "(입력 없음) 워커 자동 역할 협의 모드");

      const aggregateModel = codingOrchProvider === "groq"
        ? (codingOrchModel || selectedGroqModel || undefined)
        : codingOrchProvider === "copilot"
          ? (codingOrchModel || selectedCopilotModel || undefined)
          : codingOrchProvider === "codex"
            ? (codingOrchModel || codingOrchCodexModel || DEFAULT_CODEX_MODEL)
          : codingOrchProvider === "cerebras"
            ? (codingOrchModel || codingOrchCerebrasModel || DEFAULT_CEREBRAS_MODEL)
          : codingOrchProvider === "gemini"
            ? ((!isNoneModel(codingOrchModel) ? codingOrchModel : "")
              || (!isNoneModel(codingOrchGeminiModel) ? codingOrchGeminiModel : DEFAULT_GEMINI_WORKER_MODEL))
            : undefined;
      const effectiveText = text || (rich.attachments.length > 0 ? "첨부 파일을 반영해 코딩해줘" : "");

      const conversationId = activeConversationByKey["coding:orchestration"] || "";
      beginPendingRequest("coding:orchestration", pendingLabel, true, conversationId);
      setCodingInputOrch("");

      const ok = send({
        type: "coding_run_orchestration",
        scope: "coding",
        mode: "orchestration",
        conversationId: conversationId || undefined,
        text: effectiveText,
        project: metaProject.trim() || "기본",
        category: metaCategory.trim() || "일반",
        tags: parseTags(metaTags),
        provider: codingOrchProvider,
        model: aggregateModel,
        groqModel: normalizeModelChoice(codingOrchGroqModel, DEFAULT_GROQ_WORKER_MODEL),
        geminiModel: normalizeModelChoice(codingOrchGeminiModel, DEFAULT_GEMINI_WORKER_MODEL),
        cerebrasModel: normalizeModelChoice(codingOrchCerebrasModel, DEFAULT_CEREBRAS_MODEL),
        copilotModel: normalizeModelChoice(codingOrchCopilotModel, NONE_MODEL),
        codexModel: normalizeModelChoice(codingOrchCodexModel, DEFAULT_CODEX_MODEL),
        language: codingOrchLanguage,
        memoryNotes: currentMemoryNotes,
        attachments: rich.attachments,
        webUrls: rich.webUrls,
        webSearchEnabled: rich.webSearchEnabled
      });

      if (!ok) {
        finishPendingRequest("coding:orchestration");
        setError("coding:orchestration", "오류: WebSocket 연결이 끊어졌습니다.");
      } else {
        clearRichInputDraft("coding:orchestration");
      }
    }

    function sendCodingMulti() {
      if (!ensureAuthed()) {
        return;
      }

      const text = codingInputMulti.trim();
      const rich = getRichInputPayload(text);
      const effectiveText = text || (rich.attachments.length > 0 ? "첨부 파일을 반영해 코딩해줘" : "");
      if (!effectiveText) {
        return;
      }

      const conversationId = activeConversationByKey["coding:multi"] || "";
      beginPendingRequest("coding:multi", effectiveText, true, conversationId);
      setCodingInputMulti("");

      const ok = send({
        type: "coding_run_multi",
        scope: "coding",
        mode: "multi",
        conversationId: conversationId || undefined,
        text: effectiveText,
        project: metaProject.trim() || "기본",
        category: metaCategory.trim() || "일반",
        tags: parseTags(metaTags),
        provider: codingMultiProvider,
        model: codingMultiProvider === "gemini"
          ? (isNoneModel(codingMultiModel) ? DEFAULT_GEMINI_WORKER_MODEL : (codingMultiModel || DEFAULT_GEMINI_WORKER_MODEL))
          : codingMultiProvider === "codex"
            ? (codingMultiModel || DEFAULT_CODEX_MODEL)
          : (isNoneModel(codingMultiModel) ? undefined : (codingMultiModel || undefined)),
        groqModel: normalizeModelChoice(codingMultiGroqModel, DEFAULT_GROQ_WORKER_MODEL),
        geminiModel: normalizeModelChoice(codingMultiGeminiModel, DEFAULT_GEMINI_WORKER_MODEL),
        cerebrasModel: normalizeModelChoice(codingMultiCerebrasModel, DEFAULT_CEREBRAS_MODEL),
        copilotModel: normalizeModelChoice(codingMultiCopilotModel, NONE_MODEL),
        codexModel: normalizeModelChoice(codingMultiCodexModel, DEFAULT_CODEX_MODEL),
        language: codingMultiLanguage,
        memoryNotes: currentMemoryNotes,
        attachments: rich.attachments,
        webUrls: rich.webUrls,
        webSearchEnabled: rich.webSearchEnabled
      });

      if (!ok) {
        finishPendingRequest("coding:multi");
        setError("coding:multi", "오류: WebSocket 연결이 끊어졌습니다.");
      } else {
        clearRichInputDraft("coding:multi");
      }
    }

    function summarizeToolResult(msg) {
      if (!msg || typeof msg !== "object") {
        return "도구 응답 수신";
      }

      if (msg.type === "sessions_list_result") {
        return `sessions_list count=${msg.count || 0}`;
      }

      if (msg.type === "sessions_history_result") {
        return `sessions_history status=${msg.status || "-"} count=${msg.count || 0}`;
      }

      if (msg.type === "sessions_send_result") {
        return `sessions_send status=${msg.status || "-"} runId=${msg.runId || "-"}`;
      }

      if (msg.type === "sessions_spawn_result") {
        return `sessions_spawn status=${msg.status || "-"} child=${msg.childSessionKey || "-"} runtime=${msg.runtime || "-"}`;
      }

      if (msg.type === "cron_result") {
        const action = msg.action || "-";
        if (action === "status") {
          return `cron.status enabled=${msg.enabled ? "true" : "false"} jobs=${msg.jobs ?? 0}`;
        }
        if (action === "list") {
          return `cron.list total=${msg.total ?? 0} hasMore=${msg.hasMore ? "true" : "false"}`;
        }
        return `cron.${action} ok=${msg.ok ? "true" : "false"}`;
      }

      if (msg.type === "browser_result") {
        return `browser.${msg.action || "-"} ok=${msg.ok ? "true" : "false"} running=${msg.running ? "true" : "false"} tabs=${Array.isArray(msg.tabs) ? msg.tabs.length : 0}`;
      }

      if (msg.type === "canvas_result") {
        return `canvas.${msg.action || "-"} ok=${msg.ok ? "true" : "false"} visible=${msg.visible ? "true" : "false"} target=${msg.target || "-"}`;
      }

      if (msg.type === "nodes_result") {
        return `nodes.${msg.action || "-"} ok=${msg.ok ? "true" : "false"} nodes=${Array.isArray(msg.nodes) ? msg.nodes.length : 0} pending=${Array.isArray(msg.pendingRequests) ? msg.pendingRequests.length : 0}`;
      }

      if (msg.type === "telegram_stub_result") {
        const head = (msg.input || "").trim();
        const shortHead = head.length > 40 ? `${head.slice(0, 40)}...` : (head || "-");
        return `telegram.stub status=${msg.status || "-"} ok=${msg.ok ? "true" : "false"} input=${shortHead}`;
      }

      if (msg.type === "web_search_result") {
        const head = (msg.query || "").trim();
        const shortHead = head.length > 40 ? `${head.slice(0, 40)}...` : (head || "-");
        const provider = msg.provider || "-";
        const count = Array.isArray(msg.results) ? msg.results.length : 0;
        return `web.search provider=${provider} results=${count} query=${shortHead}`;
      }

      if (msg.type === "web_fetch_result") {
        return `web.fetch status=${msg.status ?? "-"} len=${msg.length ?? 0} url=${msg.url || msg.requestedUrl || "-"}`;
      }

      if (msg.type === "memory_search_result") {
        const count = Array.isArray(msg.results) ? msg.results.length : 0;
        return `memory.search disabled=${msg.disabled ? "true" : "false"} results=${count} query=${msg.query || "-"}`;
      }

      if (msg.type === "memory_get_result") {
        const text = typeof msg.text === "string" ? msg.text : "";
        return `memory.get disabled=${msg.disabled ? "true" : "false"} path=${msg.path || msg.requestedPath || "-"} chars=${text.length}`;
      }

      return msg.type || "도구 응답";
    }

    function pushToolResult(msg) {
      const summary = summarizeToolResult(msg);
      const capturedAt = new Date().toISOString();
      const normalizedType = (msg && msg.type) ? String(msg.type) : "unknown";
      const group = inferToolResultGroup(normalizedType);
      const domain = inferToolResultDomain(group);
      const action = inferToolResultAction(msg);
      const statusInfo = inferToolResultStatus(msg);
      const preview = JSON.stringify(msg || {}, null, 2);
      const errorText = (msg && typeof msg.error === "string") ? msg.error.trim() : "";
      const itemId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setToolResultPreview(preview);
      setSelectedToolResultId(itemId);
      setToolResultItems((prev) => {
        const next = [
          {
            id: itemId,
            type: normalizedType,
            group,
            domain,
            action,
            statusLabel: statusInfo.label,
            statusTone: statusInfo.tone,
            hasError: statusInfo.hasError,
            summary,
            capturedAt,
            errorText,
            preview
          },
          ...prev
        ];
        return next.slice(0, 16);
      });

      if (msg && typeof msg.childSessionKey === "string" && msg.childSessionKey.trim()) {
        setToolSessionKey(msg.childSessionKey.trim());
      }

      if (msg && typeof msg.error === "string" && msg.error.trim()) {
        setToolControlError(msg.error.trim());
      } else {
        setToolControlError("");
      }
    }

    function pushProviderRuntimeEvents(msg) {
      const events = buildProviderRuntimeEventsFromMessage(msg);
      if (!Array.isArray(events) || events.length === 0) {
        return;
      }

      const capturedAt = new Date().toISOString();
      setProviderRuntimeItems((prev) => {
        const next = [
          ...events.map((event) => {
            const safeProvider = PROVIDER_RUNTIME_KEYS.includes(event.provider)
              ? event.provider
              : "unknown";
            const normalized = {
              provider: safeProvider,
              scope: event.scope || "runtime",
              mode: event.mode || "-",
              model: event.model || "",
              statusLabel: event.statusLabel || "-",
              statusTone: event.statusTone || "neutral",
              hasError: !!event.hasError,
              detail: event.detail || ""
            };
            return {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              capturedAt,
              ...normalized,
              summary: summarizeProviderRuntimeEntry(normalized)
            };
          }),
          ...prev
        ];
        return next.slice(0, 48);
      });
    }

    function pushGuardObsEvent(msg) {
      const event = buildGuardObsEvent(msg);
      if (!event) {
        return;
      }

      const capturedAt = new Date().toISOString();
      setGuardObsItems((prev) => {
        const next = [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            capturedAt,
            ...event
          },
          ...prev
        ];
        return next.slice(0, 64);
      });

      const timelineEntry = buildGuardRetryTimelineEntry(event, capturedAt);
      if (timelineEntry) {
        setGuardRetryTimelineItems((prev) => {
          const next = [timelineEntry, ...prev];
          return next.slice(0, GUARD_RETRY_TIMELINE_MAX_ENTRIES);
        });
      }
    }

    function sendToolControlRequest(payload, requestLabel) {
      if (!ensureAuthed()) {
        return;
      }

      setToolControlError("");
      const ok = send(payload);
      if (!ok) {
        setToolControlError("오류: WebSocket 연결이 끊어졌습니다.");
        return;
      }

      if (requestLabel) {
        log(`[tool-control] ${requestLabel}`);
      }
    }

    function submitSessionsList() {
      sendToolControlRequest(
        {
          type: "sessions_list",
          limit: 8,
          messageLimit: 2
        },
        "sessions_list"
      );
    }

    function submitSessionsHistory() {
      const key = toolSessionKey.trim();
      if (!key) {
        setToolControlError("sessions_history 실행에는 sessionKey가 필요합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "sessions_history",
          sessionKey: key,
          limit: 20,
          includeTools: false
        },
        "sessions_history"
      );
    }

    function submitSessionSpawn() {
      const task = toolSpawnTask.trim();
      if (!task) {
        setToolControlError("sessions_spawn 실행에는 task가 필요합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "sessions_spawn",
          task,
          mode: "run",
          timeoutSeconds: 0
        },
        "sessions_spawn"
      );
    }

    function submitSessionSend() {
      const key = toolSessionKey.trim();
      const outbound = toolSessionMessage.trim();
      if (!key) {
        setToolControlError("sessions_send 실행에는 sessionKey가 필요합니다.");
        return;
      }
      if (!outbound) {
        setToolControlError("sessions_send 실행에는 message가 필요합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "sessions_send",
          sessionKey: key,
          message: outbound,
          timeoutSeconds: 30
        },
        "sessions_send"
      );
    }

    function submitCronStatus() {
      sendToolControlRequest({ type: "cron", action: "status" }, "cron.status");
    }

    function submitCronList() {
      sendToolControlRequest(
        {
          type: "cron",
          action: "list",
          includeDisabled: true,
          limit: 10,
          offset: 0
        },
        "cron.list"
      );
    }

    function submitCronRun() {
      const jobId = toolCronJobId.trim();
      if (!jobId) {
        setToolControlError("cron.run 실행에는 jobId가 필요합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "cron",
          action: "run",
          jobId,
          runMode: "force"
        },
        "cron.run"
      );
    }

    function submitBrowserStatus() {
      sendToolControlRequest({ type: "browser", action: "status" }, "browser.status");
    }

    function submitBrowserNavigate() {
      const url = toolBrowserUrl.trim();
      if (!url) {
        setToolControlError("browser.navigate 실행에는 URL이 필요합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "browser",
          action: "navigate",
          url
        },
        "browser.navigate"
      );
    }

    function submitCanvasStatus() {
      sendToolControlRequest({ type: "canvas", action: "status" }, "canvas.status");
    }

    function submitCanvasPresent() {
      sendToolControlRequest(
        {
          type: "canvas",
          action: "present",
          target: toolCanvasTarget.trim() || "main"
        },
        "canvas.present"
      );
    }

    function submitNodesStatus() {
      sendToolControlRequest(
        {
          type: "nodes",
          action: "status",
          node: toolNodesNode.trim() || undefined
        },
        "nodes.status"
      );
    }

    function submitNodesPending() {
      sendToolControlRequest(
        {
          type: "nodes",
          action: "pending",
          node: toolNodesNode.trim() || undefined
        },
        "nodes.pending"
      );
    }

    function submitNodesInvoke() {
      const commandText = toolNodesInvokeCommand.trim();
      if (!commandText) {
        setToolControlError("nodes.invoke 실행에는 invokeCommand가 필요합니다.");
        return;
      }

      const rawParams = toolNodesInvokeParamsJson.trim() || "{}";
      let parsedParams;
      try {
        parsedParams = JSON.parse(rawParams);
      } catch (_err) {
        setToolControlError("nodes.invoke params는 유효한 JSON이어야 합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "nodes",
          action: "invoke",
          node: toolNodesNode.trim() || undefined,
          requestId: toolNodesRequestId.trim() || undefined,
          invokeCommand: commandText,
          invokeParamsJson: parsedParams
        },
        "nodes.invoke"
      );
    }

    function submitTelegramStubCommand() {
      const text = toolTelegramStubText.trim();
      if (!text) {
        setToolControlError("telegram stub 실행에는 text가 필요합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "telegram_stub_command",
          text
        },
        "telegram_stub.command"
      );
    }

    function submitWebSearchProbe() {
      const query = toolWebSearchQuery.trim();
      if (!query) {
        setToolControlError("web_search 실행에는 query가 필요합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "web_search",
          query,
          count: 5,
          freshness: "pd"
        },
        "web_search"
      );
    }

    function submitWebFetchProbe() {
      const url = toolWebFetchUrl.trim();
      if (!url) {
        setToolControlError("web_fetch 실행에는 url이 필요합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "web_fetch",
          url,
          extractMode: "markdown",
          maxChars: 2400
        },
        "web_fetch"
      );
    }

    function submitMemorySearchProbe() {
      const query = toolMemorySearchQuery.trim();
      if (!query) {
        setToolControlError("memory_search 실행에는 query가 필요합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "memory_search",
          query,
          maxResults: 5
        },
        "memory_search"
      );
    }

    function submitMemoryGetProbe() {
      const path = toolMemoryGetPath.trim();
      if (!path) {
        setToolControlError("memory_get 실행에는 path가 필요합니다.");
        return;
      }

      sendToolControlRequest(
        {
          type: "memory_get",
          path,
          from: 1,
          lines: 40
        },
        "memory_get"
      );
    }

    function submitGuardAlertDispatch() {
      if (!ensureAuthed()) {
        return;
      }

      setToolControlError("");
      setGuardAlertDispatchState((prev) => ({
        ...prev,
        statusLabel: "dispatching",
        statusTone: "warn",
        message: "guard_alert_event.v1 전송 중"
      }));
      const ok = send({
        type: "dispatch_guard_alert",
        guardAlertEvent: guardAlertPipelineEvent
      });
      if (!ok) {
        setGuardAlertDispatchState((prev) => ({
          ...prev,
          statusLabel: "failed",
          statusTone: "error",
          message: "오류: WebSocket 연결이 끊어졌습니다."
        }));
        setToolControlError("오류: WebSocket 연결이 끊어졌습니다.");
        return;
      }

      log("[guard-alert] dispatch_guard_alert 요청 전송");
    }

    function handleServerMessage(msg) {
      pushProviderRuntimeEvents(msg);
      pushGuardObsEvent(msg);

      if (msg.type === "auth_required") {
        setAuthMeta({ sessionId: msg.sessionId || "", telegramConfigured: !!msg.telegramConfigured });
        return;
      }

      if (msg.type === "otp_request_result") {
        log(msg.message || "OTP 요청 결과를 확인하세요.", msg.ok ? "info" : "error");
        return;
      }

      if (msg.type === "auth_result") {
        const ok = !!msg.ok;
        setAuthed(ok);
        if (ok) {
          const expiryText = msg.expiresAtLocal || msg.expiresAtUtc || "";
          if (msg.authToken) {
            saveAuthToken(msg.authToken, expiryText);
          }
          setAuthLocalOffset(msg.localUtcOffset || "");
          if (Number.isFinite(msg.ttlHours) && Number(msg.ttlHours) > 0) {
            setAuthTtlHours(String(msg.ttlHours));
          }
          setStatus("세션 인증됨");
          send({ type: "get_routines" });
        } else {
          if (msg.resumed) {
            clearAuthToken();
          }
          setAuthLocalOffset(localUtcOffsetLabel());
          setStatus(msg.resumed ? "세션 만료 / OTP 필요" : "인증 실패");
        }
        return;
      }

      if (msg.type === "settings_state") {
        setSettingsState({
          telegramBotTokenSet: !!msg.telegramBotTokenSet,
          telegramChatIdSet: !!msg.telegramChatIdSet,
          groqApiKeySet: !!msg.groqApiKeySet,
          geminiApiKeySet: !!msg.geminiApiKeySet,
          cerebrasApiKeySet: !!msg.cerebrasApiKeySet,
          codexApiKeySet: !!msg.codexApiKeySet,
          telegramBotTokenMasked: msg.telegramBotTokenMasked || "",
          telegramChatIdMasked: msg.telegramChatIdMasked || "",
          groqApiKeyMasked: msg.groqApiKeyMasked || "",
          geminiApiKeyMasked: msg.geminiApiKeyMasked || "",
          cerebrasApiKeyMasked: msg.cerebrasApiKeyMasked || "",
          codexApiKeyMasked: msg.codexApiKeyMasked || ""
        });
        return;
      }

      if (msg.type === "settings_result") {
        log(msg.message || "설정 적용 완료");
        send({ type: "get_settings" });
        send({ type: "get_codex_status" });
        send({ type: "get_groq_models" });
        send({ type: "get_copilot_models" });
        send({ type: "get_usage_stats" });
        return;
      }

      if (msg.type === "usage_stats") {
        setGeminiUsage({
          requests: msg.gemini?.requests || 0,
          prompt_tokens: msg.gemini?.prompt_tokens || 0,
          completion_tokens: msg.gemini?.completion_tokens || 0,
          total_tokens: msg.gemini?.total_tokens || 0,
          input_price_per_million_usd: msg.gemini?.input_price_per_million_usd || "0.5000",
          output_price_per_million_usd: msg.gemini?.output_price_per_million_usd || "3.0000",
          estimated_cost_usd: msg.gemini?.estimated_cost_usd || "0.000000"
        });
        const hasPremiumPayload = Object.prototype.hasOwnProperty.call(msg, "copilotPremium");
        const premium = hasPremiumPayload ? (msg.copilotPremium || {}) : {};
        const premiumItems = Array.isArray(premium.items) ? premium.items : [];
        const premiumFallbackMessage = hasPremiumPayload
          ? (premium.message || "Copilot Premium 응답 메시지가 비어 있습니다.")
          : "미들웨어가 copilotPremium 필드를 보내지 않았습니다. 미들웨어 재시작 후 다시 시도하세요.";
        const local = msg.copilotLocal || {};
        const localItems = Array.isArray(local.items) ? local.items : [];
        setCopilotPremiumUsage({
          available: hasPremiumPayload ? !!premium.available : false,
          requires_user_scope: hasPremiumPayload ? !!premium.requires_user_scope : false,
          message: premiumFallbackMessage,
          username: premium.username || "",
          plan_name: premium.plan_name || "-",
          used_requests: premium.used_requests || "0.0",
          monthly_quota: premium.monthly_quota || "0.0",
          percent_used: premium.percent_used || "0.00",
          refreshed_local: premium.refreshed_local || "",
          features_url: premium.features_url || "https://github.com/settings/copilot/features",
          billing_url: premium.billing_url || "https://github.com/settings/billing/premium_requests_usage",
          items: premiumItems.map((item) => ({
            model: item.model || "-",
            requests: item.requests || "0.0",
            percent: item.percent || "0.00"
          }))
        });
        setCopilotLocalUsage({
          selected_model: local.selected_model || "",
          selected_model_requests: Number(local.selected_model_requests || 0),
          total_requests: Number(local.total_requests || 0),
          items: localItems.map((item) => ({
            model: item.model || "-",
            requests: Number(item.requests || 0)
          }))
        });
        return;
      }

      if (msg.type === "copilot_status") {
        const installed = !!msg.installed;
        const authenticated = !!msg.authenticated;
        const text = installed
          ? (authenticated ? `설치/인증 완료 (${msg.mode || "-"})` : `설치됨, 미인증 (${msg.mode || "-"})`)
          : "미설치";
        setCopilotStatus(text);
        setCopilotDetail(msg.detail || "-");
        return;
      }

      if (msg.type === "copilot_login_result") {
        log(`Copilot 로그인 결과: ${msg.message || "-"}`);
        send({ type: "get_copilot_status" });
        send({ type: "get_copilot_models" });
        return;
      }

      if (msg.type === "codex_status") {
        const installed = !!msg.installed;
        const authenticated = !!msg.authenticated;
        const text = installed
          ? (authenticated ? `설치/인증 완료 (${msg.mode || "-"})` : `설치됨, 미인증 (${msg.mode || "-"})`)
          : "미설치";
        setCodexStatus(text);
        setCodexDetail(msg.detail || "-");
        return;
      }

      if (msg.type === "codex_login_result") {
        const resultMessage = msg.message || "-";
        log(`Codex 로그인 결과: ${resultMessage}`);
        if (/code=.*url=/i.test(resultMessage)) {
          setCodexStatus("설치됨, 미인증 (device_auth)");
          setCodexDetail(resultMessage);
        } else if (/failed|429|Too Many Requests|error/i.test(resultMessage)) {
          setCodexStatus("설치됨, 미인증 (codex)");
          setCodexDetail(resultMessage);
        }
        send({ type: "get_codex_status" });
        return;
      }

      if (msg.type === "codex_logout_result") {
        const resultMessage = msg.message || "-";
        log(`Codex 로그아웃 결과: ${resultMessage}`);
        setCodexStatus("설치됨, 미인증 (codex)");
        setCodexDetail(resultMessage);
        send({ type: "get_codex_status" });
        return;
      }

      if (msg.type === "groq_models") {
        const items = Array.isArray(msg.items) ? msg.items : [];
        setGroqModels(items);
        setSelectedGroqModel(msg.selected || DEFAULT_GROQ_SINGLE_MODEL);
        return;
      }

      if (msg.type === "copilot_models") {
        const items = Array.isArray(msg.items) ? msg.items : [];
        setCopilotModels(items);
        setSelectedCopilotModel(msg.selected || "");
        return;
      }

      if (msg.type === "groq_model_set" && msg.ok) {
        setSelectedGroqModel(msg.model || "");
        return;
      }

      if (msg.type === "copilot_model_set" && msg.ok) {
        setSelectedCopilotModel(msg.model || "");
        return;
      }

      if (msg.type === "conversations") {
        const list = Array.isArray(msg.items) ? msg.items : [];
        const key = `${msg.scope || "chat"}:${msg.mode || "single"}`;
        if (list.length > 0) {
          autoCreateConversationRef.current[key] = false;
        }

        setSelectedConversationIdsByKey((prev) => {
          const base = Array.isArray(prev[key]) ? prev[key] : [];
          if (base.length === 0) {
            return prev;
          }

          const allowed = new Set(list.map((item) => item.id));
          const next = base.filter((id) => allowed.has(id));
          return next.length === base.length ? prev : { ...prev, [key]: next };
        });
        setSelectedFoldersByKey((prev) => {
          const base = Array.isArray(prev[key]) ? prev[key] : [];
          if (base.length === 0) {
            return prev;
          }

          const allowed = new Set(list.map((item) => ((item.project || "기본").trim() || "기본")));
          const next = base.filter((project) => allowed.has(project));
          return next.length === base.length ? prev : { ...prev, [key]: next };
        });
        setConversationLists((prev) => ({ ...prev, [key]: list }));
        setActiveConversationByKey((prev) => {
          const active = prev[key];
          if (active && list.some((x) => x.id === active)) {
            return prev;
          }

          if (list.length > 0) {
            requestConversationDetail(list[0].id);
            return { ...prev, [key]: list[0].id };
          }

          requestAutoCreateConversation(msg.scope || "chat", msg.mode || "single");
          return prev;
        });
        return;
      }

      if (msg.type === "conversation_created" || msg.type === "conversation_detail") {
        const conversation = msg.conversation;
        if (!conversation || !conversation.id) {
          return;
        }

        const key = `${conversation.scope}:${conversation.mode}`;
        autoCreateConversationRef.current[key] = false;
        setConversationDetails((prev) => ({ ...prev, [conversation.id]: conversation }));
        setConversationLists((prev) => {
          const list = Array.isArray(prev[key]) ? prev[key] : [];
          if (list.length === 0) {
            return prev;
          }

          const index = list.findIndex((item) => item.id === conversation.id);
          if (index < 0) {
            return prev;
          }

          const current = list[index];
          const nextItem = {
            ...current,
            title: conversation.title || current.title || "제목 없음",
            preview: conversation.preview || current.preview || "",
            messageCount: Number.isFinite(conversation.messageCount) ? conversation.messageCount : current.messageCount,
            project: conversation.project || current.project || "기본",
            category: conversation.category || current.category || "일반",
            tags: Array.isArray(conversation.tags) ? conversation.tags : (current.tags || [])
          };
          const nextList = list.slice();
          nextList[index] = nextItem;
          return { ...prev, [key]: nextList };
        });
        setActiveConversationByKey((prev) => ({ ...prev, [key]: conversation.id }));
        setSelectedMemoryByConversation((prev) => {
          const incoming = Array.isArray(conversation.linkedMemoryNotes) ? conversation.linkedMemoryNotes : [];
          const current = Array.isArray(prev[conversation.id]) ? prev[conversation.id] : null;
          if (current && current.length === incoming.length && current.every((value, index) => value === incoming[index])) {
            return prev;
          }
          return { ...prev, [conversation.id]: incoming };
        });
        return;
      }

      if (msg.type === "conversation_deleted") {
        const conversationId = msg.conversationId || "";
        if (!conversationId) {
          return;
        }

        setSelectedConversationIdsByKey((prev) => {
          const next = {};
          let changed = false;
          Object.entries(prev).forEach(([key, ids]) => {
            if (!Array.isArray(ids)) {
              next[key] = ids;
              return;
            }

            const filtered = ids.filter((id) => id !== conversationId);
            next[key] = filtered;
            if (filtered.length !== ids.length) {
              changed = true;
            }
          });
          return changed ? next : prev;
        });
        setConversationDetails((prev) => {
          const next = { ...prev };
          delete next[conversationId];
          return next;
        });
        setChatMultiResultByConversation((prev) => {
          const next = { ...prev };
          delete next[conversationId];
          return next;
        });
        return;
      }

      if (msg.type === "memory_cleared") {
        const scopeText = String(msg.scope || "chat").toLowerCase();
        const refreshScope = scopeText === "telegram" ? "chat" : scopeText;
        if (refreshScope === "all") {
          ["chat", "coding"].forEach((targetScope) => {
            ["single", "orchestration", "multi"].forEach((targetMode) => {
              const key = `${targetScope}:${targetMode}`;
              autoCreateConversationRef.current[key] = false;
            });
          });
        } else if (refreshScope === "chat" || refreshScope === "coding") {
          ["single", "orchestration", "multi"].forEach((targetMode) => {
            const key = `${refreshScope}:${targetMode}`;
            autoCreateConversationRef.current[key] = false;
          });
        }

        if (msg.message) {
          log(`[memory] ${msg.message}`, "info");
        }
        return;
      }

      if (msg.type === "memory_notes") {
        setMemoryNotes(Array.isArray(msg.items) ? msg.items : []);
        return;
      }

      if (msg.type === "memory_note_content") {
        setMemoryPreview({
          open: true,
          name: msg.name || "",
          content: msg.content || ""
        });
        return;
      }

      if (msg.type === "memory_note_created") {
        const ok = !!msg.ok;
        const conversationId = msg.conversationId || currentConversationId || "";
        const noteName = msg.note && typeof msg.note.name === "string" ? msg.note.name : "";
        if (ok && conversationId && noteName) {
          setSelectedMemoryByConversation((prev) => {
            const base = Array.isArray(prev[conversationId]) ? prev[conversationId] : [];
            if (base.includes(noteName)) {
              return prev;
            }

            return { ...prev, [conversationId]: base.concat([noteName]) };
          });
        }

        if (msg.message) {
          log(`[memory] ${msg.message}`, ok ? "info" : "error");
        }
        send({ type: "list_memory_notes" }, { silent: true, queueIfClosed: false });
        return;
      }

      if (msg.type === "memory_note_deleted") {
        const ok = !!msg.ok;
        const removedNames = Array.isArray(msg.removedNames)
          ? msg.removedNames.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim())
          : [];

        if (removedNames.length > 0) {
          setSelectedMemoryByConversation((prev) => {
            const next = {};
            Object.entries(prev).forEach(([conversationId, names]) => {
              next[conversationId] = Array.isArray(names)
                ? names.filter((name) => !removedNames.includes(name))
                : names;
            });
            return next;
          });
          setConversationDetails((prev) => {
            const next = {};
            Object.entries(prev).forEach(([conversationId, detail]) => {
              next[conversationId] = detail && Array.isArray(detail.linkedMemoryNotes)
                ? { ...detail, linkedMemoryNotes: detail.linkedMemoryNotes.filter((name) => !removedNames.includes(name)) }
                : detail;
            });
            return next;
          });
          setMemoryPreview((prev) => (
            removedNames.includes(prev.name)
              ? { open: false, name: "", content: "" }
              : prev
          ));
        }

        if (msg.message) {
          log(`[memory] ${msg.message}`, ok ? "info" : "error");
        }
        send({ type: "list_memory_notes" }, { silent: true, queueIfClosed: false });
        return;
      }

      if (msg.type === "memory_note_renamed") {
        const ok = !!msg.ok;
        const oldName = typeof msg.oldName === "string" ? msg.oldName.trim() : "";
        const newName = typeof msg.newName === "string" ? msg.newName.trim() : "";

        if (ok && oldName && newName) {
          setSelectedMemoryByConversation((prev) => {
            const next = {};
            Object.entries(prev).forEach(([conversationId, names]) => {
              next[conversationId] = Array.isArray(names)
                ? names.map((name) => name === oldName ? newName : name)
                : names;
            });
            return next;
          });
          setConversationDetails((prev) => {
            const next = {};
            Object.entries(prev).forEach(([conversationId, detail]) => {
              next[conversationId] = detail && Array.isArray(detail.linkedMemoryNotes)
                ? {
                    ...detail,
                    linkedMemoryNotes: detail.linkedMemoryNotes.map((name) => name === oldName ? newName : name)
                  }
                : detail;
            });
            return next;
          });
          setMemoryPreview((prev) => (
            prev.name === oldName
              ? { ...prev, name: newName }
              : prev
          ));
        }

        if (msg.message) {
          log(`[memory] ${msg.message}`, ok ? "info" : "error");
        }
        send({ type: "list_memory_notes" }, { silent: true, queueIfClosed: false });
        return;
      }

      if (msg.type === "workspace_file_preview") {
        const conversationId = msg.conversationId || currentConversationId || "";
        if (!conversationId) {
          return;
        }

        if (!msg.ok) {
          setError(currentKey, msg.message || "파일 프리뷰를 불러오지 못했습니다.");
          return;
        }

        setFilePreviewByConversation((prev) => ({
          ...prev,
          [conversationId]: {
            path: msg.path || "",
            content: msg.content || ""
          }
        }));
        return;
      }

      if (msg.type === "routines_state") {
        const items = Array.isArray(msg.items) ? msg.items : [];
        setRoutines(items);
        setRoutineSelectedId((prev) => {
          if (prev && items.some((x) => x.id === prev)) {
            return prev;
          }
          return items.length > 0 ? (items[0].id || "") : "";
        });
        if (isPortraitMobileLayout && items.length === 0) {
          setResponsivePane("routine", "overview");
        }
        return;
      }

      if (msg.type === "routine_result") {
        const ok = !!msg.ok;
        const messageText = msg.message || (ok ? "루틴 처리 완료" : "루틴 처리 실패");
        log(messageText, ok ? "info" : "error");
        setError("routine:main", ok ? "" : `오류: ${messageText}`);
        if (msg.routine && msg.routine.id) {
          setRoutineSelectedId(msg.routine.id);
          if (isPortraitMobileLayout) {
            setResponsivePane("routine", "detail");
          }
        }
        if (routineBrowserAgentPreviewRef.current
          && msg.routine
          && msg.routine.id === routineBrowserAgentPreviewRef.current) {
          const newestRun = Array.isArray(msg.routine.runs) && msg.routine.runs.length > 0
            ? msg.routine.runs[0]
            : null;
          routineBrowserAgentPreviewRef.current = "";
          if (newestRun && newestRun.ts) {
            send({ type: "get_routine_run_detail", routineId: msg.routine.id, ts: newestRun.ts });
          } else {
            setRoutineOutputPreview({
              open: true,
              title: `${msg.routine.title || msg.routine.id} · 브라우저 에이전트 테스트`,
              content: msg.message || "출력 없음",
              imagePath: "",
              imageAlt: ""
            });
          }
        }
        send({ type: "get_routines" });
        return;
      }

      if (msg.type === "routine_run_detail") {
        const ok = !!msg.ok;
        if (!ok) {
          const errorText = msg.error || "실행 이력을 불러오지 못했습니다.";
          setError("routine:main", `오류: ${errorText}`);
          log(errorText, "error");
          return;
        }

        const titleParts = [
          msg.title || "루틴 실행 상세",
          msg.runAtLocal || "",
          msg.status || ""
        ].filter(Boolean);
        const meta = [
          msg.source ? `source=${msg.source}` : "",
          Number.isFinite(Number(msg.attemptCount)) ? `attempts=${Number(msg.attemptCount)}` : "",
          msg.telegramStatus ? `telegram=${msg.telegramStatus}` : "",
          msg.artifactPath ? `artifact=${msg.artifactPath}` : "",
          msg.agentSessionId ? `agentSessionId=${msg.agentSessionId}` : "",
          msg.agentRunId ? `agentRunId=${msg.agentRunId}` : "",
          msg.agentProvider || msg.agentModel ? `agent=${msg.agentProvider || "-"}:${msg.agentModel || "-"}` : "",
          msg.toolProfile ? `toolProfile=${msg.toolProfile}` : "",
          msg.startUrl ? `startUrl=${msg.startUrl}` : "",
          msg.finalUrl ? `finalUrl=${msg.finalUrl}` : "",
          msg.pageTitle ? `pageTitle=${msg.pageTitle}` : "",
          msg.screenshotPath ? `screenshot=${msg.screenshotPath}` : ""
        ].filter(Boolean).join("\n");
        setRoutineOutputPreview({
          open: true,
          title: titleParts.join(" · "),
          content: meta ? `${meta}\n\n${msg.content || ""}` : (msg.content || ""),
          imagePath: msg.screenshotPath || "",
          imageAlt: msg.pageTitle || msg.title || "루틴 스크린샷"
        });
        return;
      }

      if (msg.type === "coding_progress") {
        const key = `${msg.scope || "coding"}:${msg.mode || "single"}`;
        setCodingProgressByKey((prev) => {
          const now = Date.now();
          const base = prev[key] || {};
          const conversationId = `${msg.conversationId || base.conversationId || ""}`.trim();
          return {
            ...prev,
            [key]: {
              phase: msg.phase || base.phase || "",
              message: msg.message || base.message || "",
              iteration: Number.isFinite(msg.iteration) ? msg.iteration : (base.iteration || 0),
              maxIterations: Number.isFinite(msg.maxIterations) ? msg.maxIterations : (base.maxIterations || 0),
              percent: Number.isFinite(msg.percent) ? msg.percent : (base.percent || 0),
              done: !!msg.done,
              provider: msg.provider || base.provider || "",
              model: msg.model || base.model || "",
              conversationId,
              startedAt: base.startedAt || now,
              updatedAt: now
            }
          };
        });
        return;
      }

      if (msg.type === "llm_chat_stream_chunk") {
        const key = `${msg.scope || "chat"}:${msg.mode || "single"}`;
        const conversationId = `${msg.conversationId || ""}`.trim();
        setPendingByKey((prev) => {
          const now = Date.now();
          const base = prev[key] || {};
          const baseDraft = typeof base.draftText === "string" ? base.draftText : "";
          const delta = typeof msg.delta === "string" ? msg.delta : "";
          return {
            ...prev,
            [key]: {
              ...base,
              active: true,
              conversationId,
              startedUtc: base.startedUtc || new Date(now).toISOString(),
              updatedAt: now,
              draftText: `${baseDraft}${delta}`,
              provider: msg.provider || base.provider || "",
              model: msg.model || base.model || "",
              route: msg.route || base.route || "",
              chunkIndex: Number.isFinite(msg.chunkIndex) ? msg.chunkIndex : (base.chunkIndex || 0)
            }
          };
        });
        setActiveConversationByKey((prev) => {
          if (!conversationId) {
            return prev;
          }

          const current = `${prev[key] || ""}`.trim();
          if (current) {
            return prev;
          }

          return { ...prev, [key]: conversationId };
        });
        setOptimisticUserByKey((prev) => {
          const base = prev[key];
          if (!base || !conversationId) {
            return prev;
          }

          const currentConversationId = `${base.conversationId || ""}`.trim();
          if (currentConversationId) {
            return prev;
          }

          return {
            ...prev,
            [key]: {
              ...base,
              conversationId
            }
          };
        });
        return;
      }

      if (msg.type === "llm_chat_result" || msg.type === "llm_chat_multi_result" || msg.type === "coding_result") {
        const conv = msg.conversation;
        if (!conv || !conv.id) {
          return;
        }

        if (msg.type === "llm_chat_multi_result") {
          const normalizedResult = chatMultiUtils.normalizeChatMultiResultMessage(msg);
          setChatMultiResultByConversation((prev) => ({
            ...prev,
            [conv.id]: {
              ...normalizedResult,
              updatedUtc: new Date().toISOString()
            }
          }));
        }

        const key = `${conv.scope}:${conv.mode}`;
        const normalizedConversation = msg.type === "llm_chat_result"
          ? attachLatencyMetaToConversation(conv, msg)
          : conv;
        setConversationDetails((prev) => ({ ...prev, [conv.id]: normalizedConversation }));
        setActiveConversationByKey((prev) => {
          if (prev[key]) {
            return prev;
          }
          return { ...prev, [key]: conv.id };
        });
        setSelectedMemoryByConversation((prev) => ({
          ...prev,
          [conv.id]: normalizedConversation.linkedMemoryNotes || prev[conv.id] || []
        }));
        finishPendingRequest(key);
        setError(key, "");

        if (msg.type === "coding_result") {
          setCodingResultByConversation((prev) => ({ ...prev, [conv.id]: msg }));
          setShowExecutionLogsByConversation((prev) => ({ ...prev, [conv.id]: false }));
          setFilePreviewByConversation((prev) => {
            const next = { ...prev };
            delete next[conv.id];
            return next;
          });
        }

        if (msg.autoMemoryNote) {
          send({ type: "list_memory_notes" });
          log(`자동 컨텍스트 압축 노트 생성: ${msg.autoMemoryNote.name}`);
        }
        return;
      }

      if (msg.type === "metrics" || msg.type === "metrics_stream") {
        const text = typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload, null, 2);
        setMetrics(text);
        return;
      }

      if (msg.type === "command_result") {
        log(`결과: ${msg.text || ""}`);
        return;
      }

      if (msg.type === "guard_alert_dispatch_result") {
        const ok = !!msg.ok;
        const statusLabel = (typeof msg.status === "string" && msg.status.trim())
          ? msg.status.trim()
          : (ok ? "sent" : "failed");
        const statusTone = ok ? "ok" : "error";
        const attemptedAtUtc = (typeof msg.attemptedAtUtc === "string" && msg.attemptedAtUtc.trim())
          ? msg.attemptedAtUtc.trim()
          : new Date().toISOString();
        const targets = Array.isArray(msg.targets)
          ? msg.targets.map((item) => ({
            name: item && item.name ? `${item.name}` : "-",
            status: item && item.status ? `${item.status}` : "-",
            attempts: Number.isFinite(Number(item && item.attempts)) ? Number(item.attempts) : 0,
            statusCode: Number.isFinite(Number(item && item.statusCode)) ? Number(item.statusCode) : null,
            error: item && item.error ? `${item.error}` : "-",
            endpoint: item && item.endpoint ? `${item.endpoint}` : "-"
          }))
          : [];
        setGuardAlertDispatchState({
          statusLabel,
          statusTone,
          message: msg.message || (ok ? "guard alert 전송 완료" : "guard alert 전송 실패"),
          attemptedAtUtc,
          sentCount: Number.isFinite(Number(msg.sentCount)) ? Number(msg.sentCount) : targets.filter((x) => x.status === "sent").length,
          failedCount: Number.isFinite(Number(msg.failedCount)) ? Number(msg.failedCount) : targets.filter((x) => x.status === "failed").length,
          skippedCount: Number.isFinite(Number(msg.skippedCount)) ? Number(msg.skippedCount) : targets.filter((x) => x.status === "skipped").length,
          targets
        });
        log(`[guard-alert] ${msg.message || (ok ? "전송 완료" : "전송 실패")}`, ok ? "info" : "error");
        return;
      }

      if (TOOL_RESULT_TYPES.has(msg.type)) {
        pushToolResult(msg);
        return;
      }

      if (msg.type === "error") {
        const errorText = `오류: ${msg.message || "-"}`;
        const targetKey = inferErrorKey(msg.message);
        const rawMessage = typeof msg.message === "string" ? msg.message : "";
        if (rootTab === "settings" && /(sessions_|cron|browser|canvas|nodes|telegram_stub|memory_|web_)/i.test(rawMessage)) {
          setToolControlError(rawMessage);
        }
        if ((msg.message || "").toLowerCase().includes("unauthorized")) {
          clearAuthToken();
          setAuthed(false);
          setStatus("인증 필요");
        }
        finishPendingRequest(targetKey);
        setError(targetKey, errorText);
        log(errorText, "error");
      }
    }

    useEffect(() => {
      if (rootTab === "routine" && authed) {
        refreshRoutines();
      }
    }, [rootTab, authed]);

    useEffect(() => {
      const selected = routines.find((item) => item.id === routineSelectedId) || null;
      setRoutineEditForm(hydrateRoutineFormFromRoutine(selected));
    }, [routines, routineSelectedId]);

    function refreshRoutines() {
      send({ type: "get_routines" });
    }

    function patchRoutineForm(formType, patch) {
      const setter = formType === "edit" ? setRoutineEditForm : setRoutineCreateForm;
      setter((prev) => ({ ...prev, ...patch }));
    }

    function toggleRoutineWeekday(formType, weekday) {
      const setter = formType === "edit" ? setRoutineEditForm : setRoutineCreateForm;
      setter((prev) => {
        const current = normalizeRoutineWeekdays(prev.weekdays || []);
        const exists = current.includes(weekday);
        const nextWeekdays = exists
          ? current.filter((value) => value !== weekday)
          : normalizeRoutineWeekdays([...current, weekday]);
        return {
          ...prev,
          weekdays: nextWeekdays
        };
      });
    }

    function createRoutineFromUi() {
      if (!ensureAuthed()) {
        return;
      }

      const payload = buildRoutinePayloadFromForm(routineCreateForm);
      if (!payload.text) {
        setError("routine:main", "루틴 요청을 입력하세요.");
        return;
      }

      setError("routine:main", "");
      const ok = send({ type: "create_routine", ...payload });
      if (ok) {
        setRoutineCreateForm((prev) => createRoutineFormState({
          executionMode: prev.executionMode,
          agentProvider: prev.agentProvider,
          agentModel: prev.agentModel,
          agentStartUrl: prev.agentStartUrl,
          agentTimeoutSeconds: prev.agentTimeoutSeconds,
          agentUsePlaywright: prev.agentUsePlaywright !== false,
          scheduleSourceMode: normalizeRoutineScheduleSourceMode(prev.scheduleSourceMode, "auto"),
          maxRetries: Math.min(5, Math.max(0, Number(prev.maxRetries ?? 1) || 0)),
          retryDelaySeconds: Math.min(300, Math.max(0, Number(prev.retryDelaySeconds ?? 15) || 0)),
          notifyPolicy: normalizeRoutineNotifyPolicy(prev.notifyPolicy, "always"),
          scheduleKind: prev.scheduleKind,
          scheduleTime: prev.scheduleTime,
          dayOfMonth: prev.dayOfMonth,
          weekdays: normalizeRoutineWeekdays(prev.weekdays || []),
          timezoneId: prev.timezoneId || getRoutineLocalTimezone()
        }));
      } else {
        setError("routine:main", "오류: WebSocket 연결이 끊어졌습니다.");
      }
    }

    function updateRoutineFromUi() {
      if (!ensureAuthed() || !routineSelectedId) {
        return;
      }

      const payload = buildRoutinePayloadFromForm(routineEditForm);
      if (!payload.text) {
        setError("routine:main", "루틴 요청을 입력하세요.");
        return;
      }

      setError("routine:main", "");
      if (!send({ type: "update_routine", routineId: routineSelectedId, ...payload })) {
        setError("routine:main", "오류: WebSocket 연결이 끊어졌습니다.");
      }
    }

    function runRoutineNow(routineId) {
      if (!ensureAuthed() || !routineId) {
        return;
      }

      setError("routine:main", "");
      if (!send({ type: "run_routine", routineId })) {
        setError("routine:main", "오류: WebSocket 연결이 끊어졌습니다.");
      }
    }

    function testRoutineTelegram(routineId) {
      if (!ensureAuthed() || !routineId) {
        return;
      }

      setError("routine:main", "");
      if (!send({ type: "test_routine_telegram", routineId })) {
        setError("routine:main", "오류: WebSocket 연결이 끊어졌습니다.");
      }
    }

    function testRoutineBrowserAgent(routineId) {
      if (!ensureAuthed() || !routineId) {
        return;
      }

      routineBrowserAgentPreviewRef.current = routineId;
      setError("routine:main", "");
      if (!send({ type: "test_browser_agent_routine", routineId })) {
        routineBrowserAgentPreviewRef.current = "";
        setError("routine:main", "오류: WebSocket 연결이 끊어졌습니다.");
      }
    }

    function openRoutineRunDetail(routineId, ts) {
      if (!ensureAuthed() || !routineId || !ts) {
        return;
      }

      setError("routine:main", "");
      if (!send({ type: "get_routine_run_detail", routineId, ts })) {
        setError("routine:main", "오류: WebSocket 연결이 끊어졌습니다.");
      }
    }

    function resendRoutineRunTelegram(routineId, ts) {
      if (!ensureAuthed() || !routineId || !ts) {
        return;
      }

      setError("routine:main", "");
      if (!send({ type: "resend_routine_run_telegram", routineId, ts })) {
        setError("routine:main", "오류: WebSocket 연결이 끊어졌습니다.");
      }
    }

    function setRoutineEnabled(routineId, enabled) {
      if (!ensureAuthed() || !routineId) {
        return;
      }

      setError("routine:main", "");
      if (!send({ type: "toggle_routine", routineId, enabled: !!enabled })) {
        setError("routine:main", "오류: WebSocket 연결이 끊어졌습니다.");
      }
    }

    function deleteRoutineById(routineId) {
      if (!ensureAuthed() || !routineId) {
        return;
      }

      setError("routine:main", "");
      if (!send({ type: "delete_routine", routineId })) {
        setError("routine:main", "오류: WebSocket 연결이 끊어졌습니다.");
      }
    }

    function onInputKeyDown(event, handler) {
      const native = event.nativeEvent || {};
      if (event.isComposing || native.isComposing || native.keyCode === 229) {
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handler();
      }
    }

    function parseWebUrls(value) {
      if (!value) {
        return [];
      }

      const seen = new Set();
      return value
        .split(/[\n,\s]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .filter((item) => item.startsWith("http://") || item.startsWith("https://"))
        .filter((item) => {
          if (seen.has(item)) {
            return false;
          }
          seen.add(item);
          return true;
        })
        .slice(0, 3);
    }

    function getRichInputPayload(inputText = "") {
      return {
        attachments: currentAttachments,
        webUrls: parseWebUrls(inputText),
        webSearchEnabled: true
      };
    }

    function clearRichInputDraft(key) {
      setAttachmentsByKey((prev) => ({ ...prev, [key]: [] }));
    }

    function removeAttachment(key, index) {
      setAttachmentsByKey((prev) => {
        const current = Array.isArray(prev[key]) ? prev[key] : [];
        const nextList = current.filter((_, i) => i !== index);
        return { ...prev, [key]: nextList };
      });
    }

    function formatBytes(size) {
      const n = Number(size || 0);
      if (!Number.isFinite(n) || n <= 0) {
        return "0B";
      }
      if (n < 1024) {
        return `${n}B`;
      }
      if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)}KB`;
      }
      return `${(n / (1024 * 1024)).toFixed(1)}MB`;
    }

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          const marker = "base64,";
          const idx = result.indexOf(marker);
          const base64 = idx >= 0 ? result.slice(idx + marker.length) : "";
          resolve(base64);
        };
        reader.onerror = () => reject(new Error("파일 읽기 실패"));
        reader.readAsDataURL(file);
      });
    }

    async function appendAttachmentsForKey(key, fileList) {
      const normalizedKey = `${key || currentKey}`.trim() || currentKey;
      const safeFileList = Array.isArray(fileList) ? fileList : [];
      if (safeFileList.length === 0) {
        return;
      }

      const existing = attachmentsByKey[normalizedKey] || [];
      const maxCount = 6;
      const maxBytes = 15 * 1024 * 1024;
      const next = [...existing];
      for (const file of safeFileList) {
        if (next.length >= maxCount) {
          log(`첨부는 최대 ${maxCount}개까지 가능합니다.`, "error");
          break;
        }

        if ((file.size || 0) > maxBytes) {
          log(`첨부 파일 크기 제한 초과: ${file.name} (최대 ${formatBytes(maxBytes)})`, "error");
          continue;
        }

        try {
          const base64 = await readFileAsBase64(file);
          if (!base64) {
            log(`첨부 인코딩 실패: ${file.name}`, "error");
            continue;
          }

          next.push({
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            dataBase64: base64,
            sizeBytes: file.size || 0,
            isImage: (file.type || "").startsWith("image/")
          });
        } catch (_err) {
          log(`첨부 읽기 실패: ${file.name}`, "error");
        }
      }

      setAttachmentsByKey((prev) => ({ ...prev, [normalizedKey]: next }));
    }

    async function onAttachmentSelected(event) {
      const fileList = event.target.files ? Array.from(event.target.files) : [];
      if (fileList.length === 0) {
        return;
      }

      await appendAttachmentsForKey(currentKey, fileList);
      event.target.value = "";
    }

    function handleAttachmentDragOver(event) {
      if (!hasDraggedFiles(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    }

    async function handleAttachmentDrop(event) {
      if (!hasDraggedFiles(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const fileList = event.dataTransfer && event.dataTransfer.files
        ? Array.from(event.dataTransfer.files)
        : [];
      clearAttachmentDragState(currentKey);
      if (fileList.length === 0) {
        return;
      }

      await appendAttachmentsForKey(currentKey, fileList);
    }

    function normalizeModelChoice(value, fallback) {
      const trimmed = (value || "").trim();
      return trimmed || fallback;
    }

    function isNoneModel(value) {
      return (value || "").trim().toLowerCase() === NONE_MODEL;
    }

    const groqModelOptions = useMemo(() => {
      return groqModels.map((x) => e("option", { key: x.id, value: x.id }, x.id));
    }, [groqModels]);

    const copilotModelOptions = useMemo(() => {
      return copilotModels.map((x) => e("option", { key: x.id, value: x.id }, x.id));
    }, [copilotModels]);

    const codexModelOptions = useMemo(() => {
      return CODEX_MODEL_CHOICES.map((item) =>
        e("option", { key: `codex-${item.id}`, value: item.id }, item.label)
      );
    }, []);

    const geminiModelOptions = useMemo(() => {
      return GEMINI_MODEL_CHOICES.map((item) =>
        e("option", { key: `gemini-${item.id}`, value: item.id }, item.label)
      );
    }, []);

    const routineAgentProviderOptions = useMemo(() => ([
      e("option", { key: "routine-agent-provider-codex", value: DEFAULT_ROUTINE_AGENT_PROVIDER }, "Codex")
    ]), []);

    const routineAgentModelOptions = useMemo(() => ([
      e(
        "option",
        { key: `routine-agent-model-${DEFAULT_ROUTINE_AGENT_MODEL}`, value: DEFAULT_ROUTINE_AGENT_MODEL },
        `Codex 기본: ${DEFAULT_ROUTINE_AGENT_MODEL}`
      )
    ]), []);

    const groqWorkerModelOptions = useMemo(() => {
      const seen = new Set();
      const options = [];
      const push = (value, label) => {
        if (seen.has(value)) {
          return;
        }
        seen.add(value);
        options.push(e("option", { key: `gw-${value}`, value }, label));
      };

      push(NONE_MODEL, "Groq: 선택 안함");
      push(DEFAULT_GROQ_WORKER_MODEL, `Groq 기본: ${DEFAULT_GROQ_WORKER_MODEL}`);
      groqModels.forEach((x) => push(x.id, x.id));
      return options;
    }, [groqModels]);

    const geminiWorkerModelOptions = useMemo(() => {
      return [
        e("option", { key: "gm-none", value: NONE_MODEL }, "Gemini: 선택 안함"),
        ...GEMINI_MODEL_CHOICES.map((item) => e("option", { key: `gm-${item.id}`, value: item.id }, item.label))
      ];
    }, []);

    const copilotWorkerModelOptions = useMemo(() => {
      const seen = new Set();
      const options = [e("option", { key: "cw-none", value: NONE_MODEL }, "Copilot: 선택 안함")];
      seen.add(NONE_MODEL);

      copilotModels.forEach((x) => {
        if (seen.has(x.id)) {
          return;
        }
        seen.add(x.id);
        options.push(e("option", { key: `cw-${x.id}`, value: x.id }, x.id));
      });
      return options;
    }, [copilotModels]);

    const codexWorkerModelOptions = useMemo(() => {
      return [
        e("option", { key: "xw-none", value: NONE_MODEL }, "Codex: 선택 안함"),
        ...CODEX_MODEL_CHOICES.map((item) =>
          e("option", { key: `xw-${item.id}`, value: item.id }, item.label)
        )
      ];
    }, []);

    const groqRows = useMemo(() => {
      if (groqModels.length === 0) {
        return [e("tr", { key: "empty-g" }, e("td", { colSpan: 13 }, "모델 데이터가 없습니다."))];
      }

      return groqModels.map((m) => e(
        "tr",
        { key: m.id },
        e("td", null, m.id),
        e("td", null, m.tier || "-"),
        e("td", null, m.speed_tps || "-"),
        e("td", null, m.context_window || "-"),
        e("td", null, m.max_completion_tokens || "-"),
        e("td", null, m.rpm || "-"),
        e("td", null, m.rpd || "-"),
        e("td", null, m.tpm || "-"),
        e("td", null, m.tpd || "-"),
        e("td", null, m.ash || "-"),
        e("td", null, m.asd || "-"),
        (() => {
          const usageRequests = Number(m.usage_requests || 0);
          const usageTokens = Number(m.usage_total_tokens || 0);
          const baseline = m.id ? (groqUsageWindowBaseByModel[m.id] || {}) : {};
          const minuteRequests = Math.max(0, usageRequests - Number(baseline.minuteRequests ?? usageRequests));
          const minuteTokens = Math.max(0, usageTokens - Number(baseline.minuteTokens ?? usageTokens));
          const hourRequests = Math.max(0, usageRequests - Number(baseline.hourRequests ?? usageRequests));
          const hourTokens = Math.max(0, usageTokens - Number(baseline.hourTokens ?? usageTokens));
          const dayRequests = Math.max(0, usageRequests - Number(baseline.dayRequests ?? usageRequests));
          const dayTokens = Math.max(0, usageTokens - Number(baseline.dayTokens ?? usageTokens));
          return e("td", null,
            e("div", { className: "tiny" }, `분 ${minuteRequests}req/${minuteTokens}tok`),
            e("div", { className: "tiny" }, `시 ${hourRequests}req/${hourTokens}tok`),
            e("div", { className: "tiny" }, `일 ${dayRequests}req/${dayTokens}tok`)
          );
        })(),
        e("td", null,
          e("div", { className: "tiny" }, m.limit_requests == null ? "req -/-" : `req ${m.remaining_requests || 0}/${m.limit_requests}`),
          e("div", { className: "tiny" }, m.limit_tokens == null ? "tok -/-" : `tok ${m.remaining_tokens || 0}/${m.limit_tokens}`),
          e("div", { className: "tiny" }, `reset ${m.reset_requests || "-"} / ${m.reset_tokens || "-"}`)
        )
      ));
    }, [groqModels, groqUsageWindowBaseByModel]);

    const copilotRows = useMemo(() => {
      if (copilotModels.length === 0) {
        return [e("tr", { key: "empty-c" }, e("td", { colSpan: 8 }, "Copilot 모델 데이터가 없습니다."))];
      }

      return copilotModels.map((m) => e(
        "tr",
        { key: m.id },
        e("td", null, m.id),
        e("td", null, m.provider || "-"),
        e("td", null, m.premium_multiplier || "-"),
        e("td", null, m.speed_tps || "-"),
        e("td", null, m.rate_limit || "-"),
        e("td", null, m.context_window || "-"),
        e("td", null, m.max_completion_tokens || "-"),
        e("td", null, `${m.usage_requests || 0} req`)
      ));
    }, [copilotModels]);

    const copilotPremiumPercent = useMemo(() => {
      const parsed = Number.parseFloat(copilotPremiumUsage.percent_used || "0");
      if (!Number.isFinite(parsed)) {
        return 0;
      }
      return Math.min(100, Math.max(0, parsed));
    }, [copilotPremiumUsage.percent_used]);

    const copilotPremiumQuotaText = useMemo(() => {
      const parsed = Number.parseFloat(copilotPremiumUsage.monthly_quota || "0");
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return "-";
      }
      return formatDecimal(parsed, 1);
    }, [copilotPremiumUsage.monthly_quota]);

    const copilotPremiumRows = useMemo(() => {
      if (!Array.isArray(copilotPremiumUsage.items) || copilotPremiumUsage.items.length === 0) {
        return [e("tr", { key: "empty-cp" }, e("td", { colSpan: 3 }, "모델별 사용량 데이터가 없습니다."))];
      }

      return copilotPremiumUsage.items.map((item, index) => e(
        "tr",
        { key: `cp-${item.model}-${index}` },
        e("td", null, item.model || "-"),
        e("td", null, `${formatDecimal(item.requests, 1)} req`),
        e("td", null, `${formatDecimal(item.percent, 2)}%`)
      ));
    }, [copilotPremiumUsage.items]);

    const copilotLocalRows = useMemo(() => {
      if (!Array.isArray(copilotLocalUsage.items) || copilotLocalUsage.items.length === 0) {
        return [e("tr", { key: "empty-cl" }, e("td", { colSpan: 2 }, "로컬 사용량 데이터가 없습니다."))];
      }

      return copilotLocalUsage.items.map((item, index) => e(
        "tr",
        { key: `cl-${item.model}-${index}` },
        e("td", null, item.model || "-"),
        e("td", null, `${item.requests || 0} req`)
      ));
    }, [copilotLocalUsage.items]);

    function renderGlobalNav() {
      const navStatusText = authed ? "세션 인증됨" : status;
      const geminiLabel = settingsState.geminiApiKeySet
        ? "gemini-3-flash-preview / gemini-3.1-flash-lite-preview"
        : "미설정";
      const cerebrasLabel = settingsState.cerebrasApiKeySet
        ? DEFAULT_CEREBRAS_MODEL
        : "미설정";
      const codexLabel = (codexStatus || "").trim().startsWith("설치/인증 완료")
        ? DEFAULT_CODEX_MODEL
        : codexStatus;
      return e(
        "aside",
        { className: "global-nav" },
        e("div", { className: "brand-wrap" },
          e("h1", { className: "brand" }, "Omni-node"),
          e("p", { className: "brand-sub" }, "대화/코딩 오케스트레이션")
        ),
        e("div", { className: "pill-group" },
          e("span", { className: `pill ${authed || navStatusText.startsWith("연결") || navStatusText.startsWith("인증") ? "ok" : "idle"}` }, navStatusText)
        ),
        e("div", { className: "nav-title" }, "메뉴"),
        e("button", { className: `nav-btn ${rootTab === "chat" ? "active" : ""}`, onClick: () => setRootTab("chat") }, "대화"),
        e("button", { className: `nav-btn ${rootTab === "routine" ? "active" : ""}`, onClick: () => setRootTab("routine") }, "루틴"),
        e("button", { className: `nav-btn ${rootTab === "coding" ? "active" : ""}`, onClick: () => setRootTab("coding") }, "코딩"),
        e("button", { className: `nav-btn ${rootTab === "settings" ? "active" : ""}`, onClick: () => setRootTab("settings") }, "설정"),
        e("div", { className: "nav-meta" },
          e("div", null, `Groq: ${selectedGroqModel || "-"}`),
          e("div", null, `Gemini: ${geminiLabel}`),
          e("div", null, `Cerebras: ${cerebrasLabel}`),
          e("div", null, `Copilot: ${selectedCopilotModel || "-"}`),
          e("div", null, `Codex: ${codexLabel || "-"}`),
          e("div", null, copilotStatus)
        )
      );
    }

    function renderModeTabs() {
      const modes = rootTab === "coding" ? CODING_MODES : CHAT_MODES;
      const activeMode = rootTab === "coding" ? codingMode : chatMode;
      return e(
        "div",
        { className: "mode-tabs" },
        modes.map((item) => e(
          "button",
          {
            key: item.key,
            className: `mode-btn ${activeMode === item.key ? "active" : ""}`,
            onClick: () => {
              if (rootTab === "coding") {
                setCodingMode(item.key);
              } else {
                setChatMode(item.key);
              }
            }
          },
          item.label
        ))
      );
    }

    function renderConversationPanel() {
      const keyword = currentConversationFilter.trim();
      return e(
        "section",
        { className: "conversation-panel" },
        e("div", { className: "conversation-head" },
          e("div", { className: "conversation-head-copy" },
            e("div", { className: "conversation-head-kicker" }, rootTab === "coding" ? "코딩 워크스페이스" : "메시지 보관함"),
            e("strong", null, `${scope.toUpperCase()} · ${mode}`),
            e("div", { className: "conversation-head-count" }, `${currentConversationList.length}개 대화`)
          )
        ),
        e("div", { className: "conversation-search" },
          e("input", {
            className: "input folder-search-input",
            value: currentConversationFilter,
            onChange: (event) => setConversationFilterByKey((prev) => ({ ...prev, [currentKey]: event.target.value })),
            placeholder: "프로젝트/카테고리/태그/제목 검색"
          })
        ),
        e("div", { className: "conversation-list" },
          currentConversationList.length === 0
            ? e("div", { className: "empty" }, "대화가 없습니다.")
            : groupedConversationList.map((group) => {
              const expanded = keyword.length > 0 || isFolderExpanded(currentKey, group.project);
              const folderSelected = currentSelectedFolders.includes(group.project);
              return e(
                "div",
                { key: `group-${group.project}`, className: "conversation-group" },
                e("div", { className: `folder-header-shell ${selectionMode ? "selection-mode" : ""}` },
                  selectionMode
                    ? e("button", {
                      type: "button",
                      className: `selection-toggle ${folderSelected ? "active" : ""}`,
                      onClick: () => toggleFolderSelection(group.project),
                      "aria-pressed": folderSelected ? "true" : "false"
                    }, folderSelected ? "✓" : "")
                    : null,
                  e("button", {
                    type: "button",
                    className: `group-title folder-title folder-toggle ${expanded ? "expanded" : ""} ${folderSelected ? "selected" : ""}`,
                    onClick: () => toggleFolder(currentKey, group.project),
                    "aria-expanded": expanded ? "true" : "false"
                  },
                  e("span", { className: "folder-chevron" }, "▸"),
                  e("span", { className: "folder-badge" }, "폴더"),
                  e("span", { className: "folder-name" }, group.project),
                  e("span", { className: "folder-count" }, `${group.items.length}`)
                  )
                ),
                e("div", { className: `folder-children ${expanded ? "expanded" : "collapsed"}` },
                  expanded
                    ? group.items.map((item) => {
                      const itemSelected = currentSelectedConversationIds.includes(item.id);
                      return e(
                        "div",
                        { key: item.id, className: `conversation-item-shell ${selectionMode ? "selection-mode" : ""}` },
                        selectionMode
                          ? e("button", {
                            type: "button",
                            className: `selection-toggle ${itemSelected ? "active" : ""}`,
                            onClick: () => toggleConversationSelection(item.id),
                            "aria-pressed": itemSelected ? "true" : "false"
                          }, itemSelected ? "✓" : "")
                          : null,
                        e(
                          "button",
                          {
                            className: `conversation-item ${currentConversationId === item.id ? "active" : ""} ${itemSelected ? "selected" : ""}`,
                            onClick: () => selectConversation({ ...item, scope, mode })
                          },
                          e("div", { className: `item-avatar category-${toneForCategory(item.category || "일반")}` }, buildConversationAvatarText(item)),
                          e("div", { className: "item-content" },
                            e("div", { className: "item-row" },
                              e("div", { className: "item-title" }, item.title || "제목 없음"),
                              e("div", { className: "item-time" }, formatConversationUpdatedLabel(item.updatedUtc))
                            ),
                            e("div", { className: "item-preview" }, item.preview || ""),
                            e("div", { className: "item-meta" },
                              e("span", { className: `meta-chip category-${toneForCategory(item.category || "일반")}` }, item.category || "일반"),
                              e("span", { className: "meta-chip neutral item-count-chip" }, `${item.messageCount || 0} msgs`)
                            ),
                            Array.isArray(item.tags) && item.tags.length > 0
                              ? e("div", { className: "item-tags" }, item.tags.slice(0, 3).map((tag) => e("span", { key: `${item.id}-${tag}`, className: "tag-chip" }, `#${tag}`)))
                              : null
                          ),
                        )
                      );
                    })
                    : null
                )
              );
            })
        ),
        e("div", { className: "conversation-bottom-actions" },
          e("button", {
            className: "btn primary conversation-new-btn conversation-bottom-new-btn",
            onClick: () => createConversation(scope, mode, "", metaProject, metaCategory, parseTags(metaTags))
          }, "새 대화"),
          e("div", { className: "conversation-actions conversation-actions-bottom-row" },
            e("button", {
              className: `btn action-select-btn ${selectionMode ? "active" : ""}`,
              onClick: toggleSelectionMode
            }, selectionMode ? "선택 종료" : "선택"),
            e("button", {
              className: "btn action-memory-btn",
              onClick: () => clearScopeMemory(scope)
            }, "메모리 초기화"),
            e("button", {
              className: "btn action-delete-btn",
              disabled: selectionMode ? selectedDeleteConversationIds.length === 0 : !currentConversationId,
              onClick: deleteConversation
            }, "삭제")
          )
        )
      );
    }

    function toggleMemoryNote(noteName, checked) {
      if (!currentConversationId) {
        return;
      }

      const next = checked
        ? currentMemoryNotes.concat([noteName])
        : currentMemoryNotes.filter((x) => x !== noteName);
      setSelectedMemoryByConversation((prev) => ({ ...prev, [currentConversationId]: next }));
    }

    function renderMemoryPicker() {
      if (!currentConversationId) {
        return e("div", { className: "memory-dock empty" }, "대화를 선택하면 메모리 노트를 연결할 수 있습니다.");
      }

      return e(
        "section",
        { className: "memory-dock support-card" },
        e("div", { className: "memory-dock-head" },
          e("strong", null, "공유 메모리 노트"),
          e("div", { className: "memory-dock-actions" },
            e("button", { className: "btn ghost", onClick: () => send({ type: "list_memory_notes" }) }, "새로고침"),
            e("button", {
              className: "btn ghost",
              disabled: !currentConversationId,
              onClick: () => createManualMemoryNote(false)
            }, "수동 생성"),
            e("button", {
              className: "btn ghost",
              disabled: currentCheckedMemoryNotes.length === 0,
              onClick: deleteSelectedMemoryNotes
            }, "삭제"),
            e("button", { className: "btn ghost", onClick: () => setMemoryPickerOpen(false) }, "닫기")
          )
        ),
        e("div", { className: "memory-dock-list" },
          memoryNotes.length === 0
            ? e("div", { className: "empty" }, "메모리 노트 없음")
            : memoryNotes.map((note) => {
              const checked = currentMemoryNotes.includes(note.name);
              return e(
                "label",
                { key: note.name, className: "memory-dock-item" },
                e("input", {
                  type: "checkbox",
                  checked,
                  onChange: (event) => toggleMemoryNote(note.name, event.target.checked)
                }),
                e("span", { className: "memory-dock-name" }, note.name),
                e("div", { className: "memory-dock-item-actions" },
                  e("button", {
                    className: "link-btn",
                    onClick: (event) => {
                      event.preventDefault();
                      renameMemoryNote(note.name);
                    }
                  }, "수정"),
                  e("button", {
                    className: "link-btn",
                    onClick: (event) => {
                      event.preventDefault();
                      send({ type: "read_memory_note", noteName: note.name });
                    }
                  }, "보기")
                )
              );
            })
        )
      );
    }

    function renderThreadInfoPanel(previewMeta) {
      const previewTags = previewMeta.previewTags || [];
      const previewProject = previewMeta.previewProject || "기본";
      const previewCategory = previewMeta.previewCategory || "일반";
      return e("div", { className: "thread-info-panel" },
        e("div", { className: "thread-info-grid" },
          e("label", { className: "meta-field" },
            e("span", { className: "meta-label" }, "대화방 이름"),
            e("input", {
              className: "input compact",
              value: metaTitle,
              onChange: (event) => setMetaTitle(event.target.value),
              placeholder: "대화방 이름"
            })
          ),
          e("label", { className: "meta-field" },
            e("span", { className: "meta-label" }, "프로젝트 폴더"),
            e("input", {
              className: "input compact",
              value: metaProject,
              onChange: (event) => setMetaProject(event.target.value),
              placeholder: "예: Omni-node 운영"
            })
          ),
          e("label", { className: "meta-field" },
            e("span", { className: "meta-label" }, "카테고리"),
            e("input", {
              className: "input compact",
              value: metaCategory,
              onChange: (event) => setMetaCategory(event.target.value),
              placeholder: "예: 설계, 버그, 문서"
            })
          ),
          e("label", { className: "meta-field" },
            e("span", { className: "meta-label" }, "태그"),
            e("input", {
              className: "input compact",
              value: metaTags,
              onChange: (event) => setMetaTags(event.target.value),
              placeholder: "예: backend,urgent,release"
            })
          )
        ),
        e("div", { className: "thread-info-footer" },
          e("div", { className: "meta-preview-row" },
            e("span", { className: "folder-pill" }, `폴더 · ${previewProject}`),
            e("span", { className: `meta-chip category-${toneForCategory(previewCategory)}` }, previewCategory),
            previewTags.length > 0
              ? previewTags.map((tag) => e("span", { key: `info-${tag}`, className: "tag-chip" }, `#${tag}`))
              : e("span", { className: "meta-chip neutral" }, "태그 없음")
          ),
          e("button", {
            className: "btn primary thread-save-btn",
            disabled: !currentConversationId,
            onClick: saveConversationMeta
          }, "메타 저장")
        )
      );
    }

    function renderThreadModebar(extraClassName = "") {
      return e("div", { className: `thread-modebar ${extraClassName}`.trim() },
        e("div", { className: "thread-modebar-copy" },
          e("div", { className: "thread-mode-kicker" }, rootTab === "coding" ? "코딩 워크플로" : "응답 전략"),
          e("div", { className: "thread-mode-hint" }, rootTab === "coding"
            ? "단일 실행부터 오케스트레이션, 다중 코딩까지 한 흐름으로 관리합니다."
            : "단일 답변, 오케스트레이션, 다중 LLM을 대화 흐름 안에서 전환합니다.")
        ),
        renderModeTabs()
      );
    }

    function renderThreadHeader(options = {}) {
      const previewMeta = buildThreadPreviewMeta();
      const previewTags = previewMeta.previewTags;
      const previewProject = previewMeta.previewProject;
      const previewCategory = previewMeta.previewCategory;
      const summaryTokens = [
        previewProject,
        previewCategory,
        `연결된 메모리 ${currentMemoryNotes.length}개`
      ];
      const showInfoPanel = options.showInfoPanel !== false && threadInfoOpen;
      const showActionButtons = options.showActionButtons !== false;
      const showModebar = options.showModebar !== false;
      return e(
        "div",
        { className: "thread-header-shell" },
        e("div", { className: "thread-topbar" },
          e("div", { className: "thread-identity" },
            e("div", { className: `thread-avatar ${rootTab === "coding" ? "coding" : "chat"} ${currentConversationId ? "active" : "idle"}` }, rootTab === "coding" ? "</>" : "AI"),
            e("div", { className: "thread-copy" },
              e("div", { className: "thread-title-row" },
                e("div", { className: "thread-title" }, currentConversationTitle),
                currentConversationId
                  ? e("span", { className: `thread-context-badge ${rootTab === "coding" ? "coding" : "chat"}` }, `${scope.toUpperCase()} · ${mode}`)
                  : null
              ),
              e("div", { className: "thread-subline" }, summaryTokens.join(" · ")),
              e("div", { className: "thread-chip-row" },
                e("span", { className: "folder-pill" }, `폴더 · ${previewProject}`),
                e("span", { className: `meta-chip category-${toneForCategory(previewCategory)}` }, previewCategory),
                previewTags.length > 0
                  ? previewTags.map((tag) => e("span", { key: `preview-${tag}`, className: "tag-chip" }, `#${tag}`))
                  : e("span", { className: "meta-chip neutral" }, "태그 없음")
              )
            )
          ),
          showActionButtons
            ? e("div", { className: "thread-actions" },
              e("button", {
                className: `btn ghost thread-action-btn ${threadInfoOpen ? "active" : ""}`,
                disabled: !currentConversationId,
                onClick: toggleThreadInfoPanel
              }, threadInfoOpen ? "정보 닫기" : "정보"),
              e("button", {
                className: "btn ghost thread-action-btn",
                disabled: !currentConversationId,
                onClick: () => {
                  const next = !memoryPickerOpen;
                  setMemoryPickerOpen(next);
                  if (isPortraitMobileLayout && next) {
                    setResponsivePane(responsiveWorkspaceKey, "support");
                  }
                }
              }, memoryPickerOpen ? "메모리 닫기" : "메모리")
            )
            : null
        ),
        showModebar ? renderThreadModebar() : null,
        showInfoPanel
          ? renderThreadInfoPanel(previewMeta)
          : null
      );
    }

    function renderMessages() {
      const optimisticUserEntry = optimisticUserByKey[currentKey];
      const pendingEntry = pendingByKey[currentKey];
      const progressEntry = codingProgressByKey[currentKey];
      const optimisticUser = isConversationBoundEntryVisible(optimisticUserEntry, currentConversationId) ? optimisticUserEntry : null;
      const pending = isConversationBoundEntryVisible(pendingEntry, currentConversationId) ? pendingEntry : null;
      const progress = isConversationBoundEntryVisible(progressEntry, currentConversationId) ? progressEntry : null;
      const isPendingVisible = !!(pending && pending.active);
      const isCodingScope = currentKey.startsWith("coding:");
      const elapsed = elapsedSeconds(progress);
      const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
      return e(
        "div",
        { className: "message-list", ref: messageListRef },
        currentMessages.length === 0 && !optimisticUser
          ? e("div", { className: "empty" }, "대화를 시작하세요.")
          : currentMessages.map((item, index) => {
            const bubbleText = isCodingScope && item.role === "assistant"
              ? sanitizeCodingAssistantText(item.text || "")
              : (item.text || "");
            const isUser = item.role === "user";
            return e(
              "div",
              { key: `${item.createdUtc || index}-${index}`, className: `message-row ${isUser ? "user" : "assistant"}` },
              !isUser
                ? e("div", { className: `message-avatar ${isCodingScope ? "coding" : "assistant"}` }, isCodingScope ? "DEV" : "AI")
                : null,
              e(
                "div",
                { className: `bubble ${isUser ? "user" : "assistant"}` },
                item.meta ? e("div", { className: "bubble-meta" }, item.meta) : null,
                e(MarkdownBubbleText, { text: bubbleText })
              ),
              isUser
                ? e("div", { className: "message-avatar self" }, "ME")
                : null
            );
          }),
        optimisticUser
          ? e(
            "div",
            { className: "message-row user pending-user-row" },
            e(
              "div",
              { className: "bubble user pending-user" },
              e("div", { className: "bubble-meta" }, "사용자 (전송됨)"),
              e(MarkdownBubbleText, { text: optimisticUser.text || "" })
            ),
            e("div", { className: "message-avatar self" }, "ME")
          )
          : null,
        isPendingVisible
          ? e(
            "div",
            { className: "message-row assistant pending-assistant-row" },
            e("div", { className: `message-avatar ${isCodingScope ? "coding" : "assistant"}` }, isCodingScope ? "DEV" : "AI"),
            e(
              "div",
              { className: "bubble assistant pending-bubble" },
              e("div", { className: "bubble-meta" }, "assistant"),
              e("div", { className: "pending" }, "작성중..."),
              !isCodingScope && pending?.provider
                ? e("div", { className: "pending-route" }, `${pending.provider || "-"}:${pending.model || "-"}${pending.route ? ` · ${pending.route}` : ""}`)
                : null,
              !isCodingScope && pending?.draftText
                ? e(MarkdownBubbleText, { text: pending.draftText })
                : null,
              isCodingScope
                ? e("div", { className: "pending-details" },
                  e("div", { className: "pending-meta-row" },
                    e("span", { className: "pending-phase" }, progress?.phase || "processing"),
                    e("span", { className: "pending-time" }, `${elapsed}s`)
                  ),
                  progress?.message ? e("div", { className: "pending-message" }, progress.message) : null,
                  progress?.provider || progress?.model
                    ? e("div", { className: "pending-route" }, `${progress.provider || "-"}:${progress.model || "-"}`)
                    : null,
                  progress?.maxIterations > 0
                    ? e("div", { className: "pending-iteration" }, `${progress.iteration || 0}/${progress.maxIterations}`)
                    : null,
                  e("div", { className: "progress-track" },
                    e("div", { className: "progress-fill", style: { width: `${percent}%` } })
                  )
                )
                : null
            )
          )
          : null
      );
    }

    function renderCodingResult() {
      if (rootTab !== "coding" || !currentConversationId) {
        return null;
      }

      const result = codingResultByConversation[currentConversationId];
      if (!result) {
        return null;
      }

      const changedFiles = Array.isArray(result.changedFiles) ? result.changedFiles.filter(Boolean) : [];
      const preview = filePreviewByConversation[currentConversationId] || null;
      const runDir = result.execution?.runDirectory || "";
      const showExecutionLogs = !!showExecutionLogsByConversation[currentConversationId];
      const safeSummary = sanitizeCodingAssistantText(result.summary || "");

      return e(
        "section",
        { className: "coding-result support-card" },
        e("div", { className: "coding-result-head" },
          e("strong", null, "최근 코딩 결과"),
          e("span", null, `${result.provider || "-"}/${result.model || "-"} · ${result.language || "-"}`)
        ),
        e("div", { className: "coding-result-meta" },
          `status=${result.execution?.status || "-"} · exit=${result.execution?.exitCode ?? "-"} · command=${result.execution?.command || "(none)"}`
        ),
        changedFiles.length > 0
          ? e("div", { className: "coding-files" },
            e("div", { className: "coding-files-head" }, `생성/수정 파일 (${changedFiles.length})`),
            e("div", { className: "coding-files-list" },
              changedFiles.map((pathValue) => {
                const selected = preview?.path === pathValue;
                return e(
                  "button",
                  {
                    key: pathValue,
                    className: `file-chip ${selected ? "active" : ""}`,
                    onClick: () => requestWorkspaceFilePreview(pathValue, currentConversationId)
                  },
                  humanPath(pathValue, runDir)
                );
              })
            )
          )
          : e("div", { className: "coding-files empty-line" }, "변경 파일이 감지되지 않았습니다."),
        preview
          ? e("div", { className: "coding-preview" },
            e("div", { className: "coding-preview-head" }, `프리뷰: ${humanPath(preview.path, runDir)}`),
            e("pre", { className: "coding-preview-content" }, preview.content || "")
          )
          : e("div", { className: "coding-preview empty-line" }, "파일을 선택하면 프리뷰를 볼 수 있습니다."),
        e("div", { className: "coding-log-controls" },
          e("button", {
            className: "btn ghost",
            onClick: () => setShowExecutionLogsByConversation((prev) => ({
              ...prev,
              [currentConversationId]: !showExecutionLogs
            }))
          }, showExecutionLogs ? "실행 로그 숨기기" : "실행 로그 보기")
        ),
        showExecutionLogs
          ? e("pre", { className: "coding-output" }, `[stdout]\n${result.execution?.stdout || ""}\n\n[stderr]\n${result.execution?.stderr || ""}`)
          : e("div", { className: "coding-output empty-line" }, "실행 로그는 숨김 상태입니다."),
        safeSummary
          ? e("div", { className: "coding-summary markdown-panel" },
            e(MarkdownBubbleText, { text: safeSummary })
          )
          : null
      );
    }

    function renderChatMultiResult() {
      if (rootTab !== "chat" || mode !== "multi" || !currentConversationId) {
        return null;
      }

      const result = chatMultiResultByConversation[currentConversationId];
      if (!result) {
        return null;
      }

      const snapshot = chatMultiUtils.buildChatMultiRenderSnapshot(result);
      const sectionNodes = snapshot.sections.map((section) => e(
        "div",
        { key: `chat-multi-${section.provider}`, className: "coding-preview" },
        e("div", { className: "coding-preview-head" }, section.heading),
        e("div", { className: "coding-preview-content markdown-panel" },
          e(MarkdownBubbleText, { text: section.body })
        )
      ));

      return e(
        "section",
        { className: "coding-result support-card" },
        e("div", { className: "coding-result-head" },
          e("strong", null, "다중 LLM 상세 결과"),
          e("span", null, result.updatedUtc || "-")
        ),
        ...sectionNodes
      );
    }

    function renderRichInputControls() {
      const attachments = currentAttachments;
      return e(
        "div",
        { className: "rich-input messenger-rich-input" },
        e(
          "div",
          {
            className: `rich-input-row compact-attachment-row ${attachmentDragActive ? "drag-active" : ""}`,
            onDragOver: handleAttachmentDragOver,
            onDrop: handleAttachmentDrop
          },
          attachmentDragActive
            ? e("div", { className: "attachment-drop-message" }, "여기에 파일 추가")
            : [
                e("input", {
                  key: "file-input",
                  id: attachmentFileInputId,
                  type: "file",
                  className: "file-upload-input",
                  onChange: onAttachmentSelected,
                  multiple: true,
                  tabIndex: -1,
                  "aria-hidden": "true",
                  accept: "image/*,.pdf,.txt,.md,.json,.csv,.log,.py,.js,.ts,.java,.kt,.c,.cpp,.cs,.html,.css,.sh,.yaml,.yml,.xml"
                }),
                e("label", {
                  key: "file-button",
                  className: "btn ghost file-upload-label",
                  htmlFor: attachmentFileInputId
                }, "파일 추가"),
                attachments.length > 0
                  ? e("div", { key: "summary", className: "attachment-compact-summary" }, `첨부 ${attachments.length}개`)
                  : e("div", { key: "summary-empty", className: "attachment-compact-summary empty" }, "첨부 없음"),
                attachments.length > 0
                  ? e("button", {
                      key: "clear",
                      className: "btn ghost attachment-clear-btn",
                      onClick: () => setAttachmentsByKey((prev) => ({ ...prev, [currentKey]: [] }))
                    }, "비우기")
                  : null
              ]
        )
      );
    }

    function renderPaperclipIcon() {
      return e(
        "svg",
        { viewBox: "0 0 24 24", className: "icon-svg", "aria-hidden": "true" },
        e("path", {
          d: "M9.5 19.5 17 12a4.5 4.5 0 1 0-6.364-6.364L3.5 12.772a6.5 6.5 0 0 0 9.192 9.192L19 15.656",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.9",
          strokeLinecap: "round",
          strokeLinejoin: "round"
        })
      );
    }

    function renderSendIcon() {
      return e(
        "svg",
        { viewBox: "0 0 24 24", className: "icon-svg", "aria-hidden": "true" },
        e("path", {
          d: "M21 3 10 14",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.9",
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }),
        e("path", {
          d: "m21 3-7 18-4-7-7-4 18-7Z",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.9",
          strokeLinecap: "round",
          strokeLinejoin: "round"
        })
      );
    }

    function renderComposerInputBar({ value, onChange, onSend, pendingKey, placeholder }) {
      const pending = isRequestPending(pendingKey);
      return e(
        "div",
        { className: "composer-message-stack" },
        e("div", { className: "composer-input-shell" },
          e("textarea", {
            className: "textarea composer-main-input",
            rows: 1,
            value,
            ref: (node) => autoResizeComposerTextarea(node),
            onInput: (event) => autoResizeComposerTextarea(event.target),
            onChange,
            onKeyDown: (event) => onInputKeyDown(event, onSend),
            placeholder
          }),
          e("div", { className: "composer-side-actions" },
            e("button", {
              type: "button",
              className: `composer-icon-btn attach ${attachmentPanelVisible ? "active" : ""}`,
              title: attachmentPanelVisible ? "첨부 패널 닫기" : "첨부 패널 열기",
              onClick: toggleAttachmentPanel
            }, renderPaperclipIcon()),
            e("button", {
              type: "button",
              className: "composer-icon-btn send",
              title: "전송",
              onClick: onSend,
              disabled: pending
            }, renderSendIcon())
          )
        ),
        attachmentPanelVisible ? renderRichInputControls() : null
      );
    }

    function buildThreadSupportSlots() {
      const slots = [];
      const multiResult = renderChatMultiResult();
      if (multiResult) {
        slots.push(e("div", { key: "support-multi", className: "thread-support-slot" }, multiResult));
      }

      const codingResult = renderCodingResult();
      if (codingResult) {
        slots.push(e("div", { key: "support-coding", className: "thread-support-slot" }, codingResult));
      }

      if (memoryPickerOpen) {
        slots.push(e("div", { key: "support-memory", className: "thread-support-slot" }, renderMemoryPicker()));
      }

      return slots;
    }

    function renderThreadSupportStack() {
      const slots = buildThreadSupportSlots();
      if (slots.length === 0) {
        return null;
      }

      return e("div", { className: "thread-support-stack" }, slots);
    }

    function renderResponsiveWorkspaceSupportPane() {
      const blocks = [];
      if (currentConversationId) {
        blocks.push(e("div", { key: "support-modebar", className: "thread-support-slot" }, renderThreadModebar("thread-modebar-support")));
        blocks.push(e("div", { key: "support-info", className: "thread-support-slot" }, renderThreadInfoPanel(buildThreadPreviewMeta())));
        blocks.push(e("div", { key: "support-memory", className: "thread-support-slot" }, renderMemoryPicker()));
      }
      const multiResult = renderChatMultiResult();
      if (multiResult) {
        blocks.push(e("div", { key: "support-multi", className: "thread-support-slot" }, multiResult));
      }
      const codingResult = renderCodingResult();
      if (codingResult) {
        blocks.push(e("div", { key: "support-coding", className: "thread-support-slot" }, codingResult));
      }
      if (blocks.length === 0) {
        return e("div", { className: "thread-support-stack thread-support-stack-mobile" },
          e("div", { className: "support-card responsive-empty-card" }, "이 화면에서는 응답 전략, 정보, 메모리, 실행 결과 같은 보조 요소를 따로 확인합니다.")
        );
      }
      return e("div", { className: "thread-support-stack thread-support-stack-mobile" }, blocks);
    }

    function renderChatComposer() {
      if (mode === "single") {
        return e(
          "div",
          { className: "composer messenger-composer" },
          e("div", { className: "toolbar" },
            e("select", {
              className: "input compact",
              value: chatSingleProvider,
              onChange: (event) => {
                const value = event.target.value;
                setChatSingleProvider(value);
                if (value === "groq") {
                  setChatSingleModel(selectedGroqModel || DEFAULT_GROQ_SINGLE_MODEL);
                } else if (value === "copilot") {
                  setChatSingleModel(selectedCopilotModel || "");
                } else if (value === "codex") {
                  setChatSingleModel(DEFAULT_CODEX_MODEL);
                } else if (value === "gemini") {
                  setChatSingleModel(DEFAULT_GEMINI_WORKER_MODEL);
                } else if (value === "cerebras") {
                  setChatSingleModel(DEFAULT_CEREBRAS_MODEL);
                } else {
                  setChatSingleModel("");
                }
              }
            },
            e("option", { value: "groq" }, "Groq"),
            e("option", { value: "gemini" }, "Gemini"),
            e("option", { value: "cerebras" }, "Cerebras"),
            e("option", { value: "copilot" }, "Copilot"),
            e("option", { value: "codex" }, "Codex")),
            chatSingleProvider === "groq"
              ? e("select", {
                className: "input compact",
                value: chatSingleModel || selectedGroqModel,
                onChange: (event) => setChatSingleModel(event.target.value)
              }, groqModelOptions.length === 0 ? e("option", { value: "" }, "Groq 모델 로딩 전") : groqModelOptions)
              : chatSingleProvider === "copilot"
                ? e("select", {
                  className: "input compact",
                  value: chatSingleModel || selectedCopilotModel,
                  onChange: (event) => setChatSingleModel(event.target.value)
                }, copilotModelOptions.length === 0 ? e("option", { value: "" }, "Copilot 모델 로딩 전") : copilotModelOptions)
              : chatSingleProvider === "codex"
                ? e("select", {
                  className: "input compact",
                  value: chatSingleModel || DEFAULT_CODEX_MODEL,
                  onChange: (event) => setChatSingleModel(event.target.value)
                }, codexModelOptions)
              : chatSingleProvider === "cerebras"
                  ? e("select", {
                    className: "input compact",
                    value: chatSingleModel || DEFAULT_CEREBRAS_MODEL,
                    onChange: (event) => setChatSingleModel(event.target.value)
                  }, CEREBRAS_MODEL_CHOICES.map((item) =>
                    e("option", { key: `chat-single-cerebras-${item.id}`, value: item.id }, item.label)
                  ))
                : e("select", {
                  className: "input compact",
                  value: chatSingleModel || DEFAULT_GEMINI_WORKER_MODEL,
                  onChange: (event) => setChatSingleModel(event.target.value)
                }, geminiModelOptions)
          ),
          renderComposerInputBar({
            value: chatInputSingle,
            onChange: (event) => setChatInputSingle(event.target.value),
            onSend: sendChatSingle,
            pendingKey: "chat:single",
            placeholder: "질문 입력"
          })
        );
      }

      if (mode === "orchestration") {
        return e(
          "div",
          { className: "composer messenger-composer" },
          e("div", { className: "preset-hint" }, "기본 권장: 1차 Groq(빠름) + 2차 Gemini 통합. AUTO와 별개로 워커 모델을 각각 선택할 수 있습니다."),
          e("div", { className: "toolbar" },
            e("select", {
              className: "input compact",
              value: chatOrchProvider,
              onChange: (event) => {
                const value = event.target.value;
                setChatOrchProvider(value);
                if (value === "groq") {
                  setChatOrchModel(selectedGroqModel || "");
                } else if (value === "copilot") {
                  setChatOrchModel(selectedCopilotModel || "");
                } else if (value === "codex") {
                  setChatOrchModel(chatOrchCodexModel || DEFAULT_CODEX_MODEL);
                } else if (value === "gemini") {
                  setChatOrchModel(
                    isNoneModel(chatOrchGeminiModel) ? DEFAULT_GEMINI_WORKER_MODEL : (chatOrchGeminiModel || DEFAULT_GEMINI_WORKER_MODEL)
                  );
                } else if (value === "cerebras") {
                  setChatOrchModel(chatOrchCerebrasModel || DEFAULT_CEREBRAS_MODEL);
                } else {
                  setChatOrchModel("");
                }
              }
            },
            e("option", { value: "auto" }, "AUTO"),
            e("option", { value: "groq" }, "Groq"),
            e("option", { value: "gemini" }, "Gemini"),
            e("option", { value: "cerebras" }, "Cerebras"),
            e("option", { value: "copilot" }, "Copilot"),
            e("option", { value: "codex" }, "Codex")),
            chatOrchProvider === "groq"
              ? e("select", {
                className: "input compact",
                value: chatOrchModel || selectedGroqModel,
                onChange: (event) => setChatOrchModel(event.target.value)
              }, groqModelOptions.length === 0 ? e("option", { value: "" }, "Groq 모델 로딩 전") : groqModelOptions)
              : chatOrchProvider === "cerebras"
                ? e("select", {
                  className: "input compact",
                  value: chatOrchModel || chatOrchCerebrasModel,
                  onChange: (event) => setChatOrchModel(event.target.value)
                }, CEREBRAS_MODEL_CHOICES.map((item) =>
                  e("option", { key: `chat-orch-cerebras-${item.id}`, value: item.id }, item.label)
                ))
              : chatOrchProvider === "copilot"
                ? e("select", {
                  className: "input compact",
                  value: chatOrchModel || selectedCopilotModel,
                  onChange: (event) => setChatOrchModel(event.target.value)
                }, copilotModelOptions.length === 0 ? e("option", { value: "" }, "Copilot 모델 로딩 전") : copilotModelOptions)
              : chatOrchProvider === "codex"
                ? e("select", {
                  className: "input compact",
                  value: chatOrchModel || chatOrchCodexModel || DEFAULT_CODEX_MODEL,
                  onChange: (event) => setChatOrchModel(event.target.value)
                }, codexModelOptions)
              : chatOrchProvider === "gemini"
                ? e("select", {
                  className: "input compact",
                  value: (!isNoneModel(chatOrchModel) ? chatOrchModel : "")
                    || (!isNoneModel(chatOrchGeminiModel) ? chatOrchGeminiModel : DEFAULT_GEMINI_WORKER_MODEL),
                  onChange: (event) => setChatOrchModel(event.target.value)
                }, geminiModelOptions)
                : e("div", { className: "fixed-chip" }, "AUTO")
          ),
          e("div", { className: "toolbar" },
            e("div", { className: "fixed-chip" }, "워커 모델"),
            e("select", {
              className: "input compact",
              value: chatOrchGroqModel,
              onChange: (event) => setChatOrchGroqModel(event.target.value)
            }, groqWorkerModelOptions),
            e("select", {
              className: "input compact",
              value: chatOrchGeminiModel,
              onChange: (event) => setChatOrchGeminiModel(event.target.value)
            }, geminiWorkerModelOptions),
            e("select", {
              className: "input compact",
              value: chatOrchCerebrasModel,
              onChange: (event) => setChatOrchCerebrasModel(event.target.value)
            }, [
              e("option", { key: "chat-orch-cerebras-none", value: NONE_MODEL }, "Cerebras: 선택 안함"),
              ...CEREBRAS_MODEL_CHOICES.map((item) =>
                e("option", { key: `chat-orch-cerebras-worker-${item.id}`, value: item.id }, item.label)
              )
            ]),
            e("select", {
              className: "input compact",
              value: chatOrchCopilotModel,
              onChange: (event) => setChatOrchCopilotModel(event.target.value)
            }, copilotWorkerModelOptions),
            e("select", {
              className: "input compact",
              value: chatOrchCodexModel,
              onChange: (event) => setChatOrchCodexModel(event.target.value)
            }, codexWorkerModelOptions)
          ),
          renderComposerInputBar({
            value: chatInputOrch,
            onChange: (event) => setChatInputOrch(event.target.value),
            onSend: sendChatOrchestration,
            pendingKey: "chat:orchestration",
            placeholder: "병렬 통합 질문 입력"
          })
        );
      }

      return e(
        "div",
        { className: "composer messenger-composer" },
        e("div", { className: "preset-hint" }, "다중 LLM은 답변 충돌/중요 결정 상황에서만 사용하는 것을 권장합니다."),
        e("div", { className: "toolbar" },
          e("select", {
            className: "input compact",
            value: chatMultiGroqModel,
            onChange: (event) => setChatMultiGroqModel(event.target.value)
          }, groqWorkerModelOptions),
          e("select", {
            className: "input compact",
            value: chatMultiGeminiModel,
            onChange: (event) => setChatMultiGeminiModel(event.target.value)
          }, geminiWorkerModelOptions),
          e("select", {
            className: "input compact",
            value: chatMultiCerebrasModel,
            onChange: (event) => setChatMultiCerebrasModel(event.target.value)
          }, [
            e("option", { key: "chat-multi-cerebras-none", value: NONE_MODEL }, "Cerebras: 선택 안함"),
            ...CEREBRAS_MODEL_CHOICES.map((item) =>
              e("option", { key: `chat-multi-cerebras-worker-${item.id}`, value: item.id }, item.label)
            )
          ]),
          e("select", {
            className: "input compact",
            value: chatMultiCopilotModel,
            onChange: (event) => setChatMultiCopilotModel(event.target.value)
          }, copilotWorkerModelOptions),
          e("select", {
            className: "input compact",
            value: chatMultiCodexModel,
            onChange: (event) => setChatMultiCodexModel(event.target.value)
          }, codexWorkerModelOptions),
          e("select", {
            className: "input compact",
            value: chatMultiSummaryProvider,
            onChange: (event) => setChatMultiSummaryProvider(event.target.value)
          },
          e("option", { value: "auto" }, "요약: AUTO"),
          e("option", { value: "gemini" }, "요약: Gemini"),
          e("option", { value: "groq" }, "요약: Groq"),
          e("option", { value: "cerebras" }, "요약: Cerebras"),
          e("option", { value: "copilot" }, "요약: Copilot"),
          e("option", { value: "codex" }, "요약: Codex"))
        ),
        renderComposerInputBar({
          value: chatInputMulti,
          onChange: (event) => setChatInputMulti(event.target.value),
          onSend: sendChatMulti,
          pendingKey: "chat:multi",
          placeholder: "다중 LLM 비교 질문 입력"
        })
      );
    }

    function renderCodingComposer() {
      if (mode === "single") {
        return e(
          "div",
          { className: "composer messenger-composer" },
          e("div", { className: "toolbar" },
            e("select", {
              className: "input compact",
              value: codingSingleProvider,
              onChange: (event) => {
                const value = event.target.value;
                setCodingSingleProvider(value);
                if (value === "groq") {
                  setCodingSingleModel(selectedGroqModel || "");
                } else if (value === "cerebras") {
                  setCodingSingleModel(DEFAULT_CEREBRAS_MODEL);
                } else if (value === "copilot") {
                  setCodingSingleModel(selectedCopilotModel || "");
                } else if (value === "codex") {
                  setCodingSingleModel(DEFAULT_CODEX_MODEL);
                } else if (value === "gemini") {
                  setCodingSingleModel(DEFAULT_GEMINI_WORKER_MODEL);
                } else {
                  setCodingSingleModel("");
                }
              }
            },
            e("option", { value: "auto" }, "AUTO"),
            e("option", { value: "groq" }, "Groq"),
            e("option", { value: "gemini" }, "Gemini"),
            e("option", { value: "cerebras" }, "Cerebras"),
            e("option", { value: "copilot" }, "Copilot"),
            e("option", { value: "codex" }, "Codex")),
            codingSingleProvider === "groq"
              ? e("select", {
                className: "input compact",
                value: codingSingleModel || selectedGroqModel,
                onChange: (event) => setCodingSingleModel(event.target.value)
              }, groqModelOptions.length === 0 ? e("option", { value: "" }, "Groq 모델 로딩 전") : groqModelOptions)
              : codingSingleProvider === "copilot"
                ? e("select", {
                  className: "input compact",
                  value: codingSingleModel || selectedCopilotModel,
                  onChange: (event) => setCodingSingleModel(event.target.value)
                }, copilotModelOptions.length === 0 ? e("option", { value: "" }, "Copilot 모델 로딩 전") : copilotModelOptions)
                : codingSingleProvider === "codex"
                  ? e("select", {
                    className: "input compact",
                    value: codingSingleModel || DEFAULT_CODEX_MODEL,
                    onChange: (event) => setCodingSingleModel(event.target.value)
                  }, codexModelOptions)
                : codingSingleProvider === "cerebras"
                  ? e("select", {
                    className: "input compact",
                    value: codingSingleModel || DEFAULT_CEREBRAS_MODEL,
                    onChange: (event) => setCodingSingleModel(event.target.value)
                  }, CEREBRAS_MODEL_CHOICES.map((item) =>
                    e("option", { key: `coding-single-cerebras-${item.id}`, value: item.id }, item.label)
                  ))
                : codingSingleProvider === "gemini"
                  ? e("select", {
                    className: "input compact",
                    value: codingSingleModel || DEFAULT_GEMINI_WORKER_MODEL,
                    onChange: (event) => setCodingSingleModel(event.target.value)
                  }, geminiModelOptions)
                  : e("div", { className: "fixed-chip" }, "AUTO"),
            e("select", {
              className: "input compact",
              value: codingSingleLanguage,
              onChange: (event) => setCodingSingleLanguage(event.target.value)
            }, CODING_LANGUAGES.map((item) => e("option", { key: item[0], value: item[0] }, item[1])))
          ),
          renderComposerInputBar({
            value: codingInputSingle,
            onChange: (event) => setCodingInputSingle(event.target.value),
            onSend: sendCodingSingle,
            pendingKey: "coding:single",
            placeholder: "요구사항 입력 시 코드 생성/실행"
          })
        );
      }

      if (mode === "orchestration") {
        return e(
          "div",
          { className: "composer messenger-composer" },
          e("div", { className: "preset-hint" }, "기본 권장: Copilot 생성 + Gemini 검증 + Groq 보조. 집계:AUTO는 워커 결과를 어떤 모델이 최종 통합할지 자동 선택합니다(gemini 우선). 입력 없이 실행하면 워커가 역할을 자동 협의해 분배합니다."),
          e("div", { className: "toolbar" },
            e("select", {
              className: "input compact",
              value: codingOrchProvider,
              onChange: (event) => {
                const value = event.target.value;
                setCodingOrchProvider(value);
                if (value === "groq") {
                  setCodingOrchModel(selectedGroqModel || "");
                } else if (value === "copilot") {
                  setCodingOrchModel(selectedCopilotModel || "");
                } else if (value === "codex") {
                  setCodingOrchModel(codingOrchCodexModel || DEFAULT_CODEX_MODEL);
                } else if (value === "cerebras") {
                  setCodingOrchModel(codingOrchCerebrasModel || DEFAULT_CEREBRAS_MODEL);
                } else if (value === "gemini") {
                  setCodingOrchModel(
                    isNoneModel(codingOrchGeminiModel) ? DEFAULT_GEMINI_WORKER_MODEL : (codingOrchGeminiModel || DEFAULT_GEMINI_WORKER_MODEL)
                  );
                } else {
                  setCodingOrchModel("");
                }
              }
            },
            e("option", { value: "auto" }, "집계: AUTO"),
            e("option", { value: "groq" }, "집계: Groq"),
            e("option", { value: "gemini" }, "집계: Gemini"),
            e("option", { value: "cerebras" }, "집계: Cerebras"),
            e("option", { value: "copilot" }, "집계: Copilot"),
            e("option", { value: "codex" }, "집계: Codex")),
            codingOrchProvider === "groq"
              ? e("select", {
                className: "input compact",
                value: codingOrchModel || selectedGroqModel,
                onChange: (event) => setCodingOrchModel(event.target.value)
              }, groqModelOptions.length === 0 ? e("option", { value: "" }, "Groq 모델 로딩 전") : groqModelOptions)
              : codingOrchProvider === "copilot"
                ? e("select", {
                  className: "input compact",
                  value: codingOrchModel || selectedCopilotModel,
                  onChange: (event) => setCodingOrchModel(event.target.value)
                }, copilotModelOptions.length === 0 ? e("option", { value: "" }, "Copilot 모델 로딩 전") : copilotModelOptions)
                : codingOrchProvider === "codex"
                  ? e("select", {
                    className: "input compact",
                    value: codingOrchModel || codingOrchCodexModel || DEFAULT_CODEX_MODEL,
                    onChange: (event) => setCodingOrchModel(event.target.value)
                  }, codexModelOptions)
                : codingOrchProvider === "cerebras"
                  ? e("select", {
                    className: "input compact",
                    value: codingOrchModel || codingOrchCerebrasModel || DEFAULT_CEREBRAS_MODEL,
                    onChange: (event) => setCodingOrchModel(event.target.value)
                  }, CEREBRAS_MODEL_CHOICES.map((item) =>
                    e("option", { key: `coding-orch-cerebras-${item.id}`, value: item.id }, item.label)
                  ))
                : codingOrchProvider === "gemini"
                  ? e("select", {
                    className: "input compact",
                    value: (!isNoneModel(codingOrchModel) ? codingOrchModel : "")
                      || (!isNoneModel(codingOrchGeminiModel) ? codingOrchGeminiModel : DEFAULT_GEMINI_WORKER_MODEL),
                    onChange: (event) => setCodingOrchModel(event.target.value)
                  }, geminiModelOptions)
                  : e("div", { className: "fixed-chip" }, "AUTO"),
            e("select", {
              className: "input compact",
              value: codingOrchLanguage,
              onChange: (event) => setCodingOrchLanguage(event.target.value)
            }, CODING_LANGUAGES.map((item) => e("option", { key: item[0], value: item[0] }, item[1])))
          ),
          e("div", { className: "toolbar" },
            e("div", { className: "fixed-chip" }, "워커 모델"),
            e("select", {
              className: "input compact",
              value: codingOrchGroqModel,
              onChange: (event) => setCodingOrchGroqModel(event.target.value)
            }, groqWorkerModelOptions),
            e("select", {
              className: "input compact",
              value: codingOrchGeminiModel,
              onChange: (event) => setCodingOrchGeminiModel(event.target.value)
            }, geminiWorkerModelOptions),
            e("select", {
              className: "input compact",
              value: codingOrchCerebrasModel,
              onChange: (event) => setCodingOrchCerebrasModel(event.target.value)
            }, [
              e("option", { key: "coding-orch-cerebras-none", value: NONE_MODEL }, "Cerebras: 선택 안함"),
              ...CEREBRAS_MODEL_CHOICES.map((item) =>
                e("option", { key: `coding-orch-cerebras-worker-${item.id}`, value: item.id }, item.label)
              )
            ]),
            e("select", {
              className: "input compact",
              value: codingOrchCopilotModel,
              onChange: (event) => setCodingOrchCopilotModel(event.target.value)
            }, copilotWorkerModelOptions),
            e("select", {
              className: "input compact",
              value: codingOrchCodexModel,
              onChange: (event) => setCodingOrchCodexModel(event.target.value)
            }, codexWorkerModelOptions)
          ),
          renderComposerInputBar({
            value: codingInputOrch,
            onChange: (event) => setCodingInputOrch(event.target.value),
            onSend: sendCodingOrchestration,
            pendingKey: "coding:orchestration",
            placeholder: "모델별 역할 분배 병렬 코딩"
          })
        );
      }

      return e(
        "div",
        { className: "composer messenger-composer" },
        e("div", { className: "preset-hint" }, "실패 비용이 큰 버그/설계 이슈일 때 다중 코딩을 사용하세요. Groq/Gemini/Cerebras/Copilot 워커를 각각 선택할 수 있습니다."),
        e("div", { className: "toolbar" },
          e("select", {
            className: "input compact",
            value: codingMultiProvider,
            onChange: (event) => {
              const value = event.target.value;
              setCodingMultiProvider(value);
              if (value === "groq") {
                setCodingMultiModel(selectedGroqModel || "");
              } else if (value === "cerebras") {
                setCodingMultiModel(codingMultiCerebrasModel || DEFAULT_CEREBRAS_MODEL);
              } else if (value === "copilot") {
                setCodingMultiModel(selectedCopilotModel || "");
              } else if (value === "codex") {
                setCodingMultiModel(codingMultiCodexModel || DEFAULT_CODEX_MODEL);
              } else if (value === "gemini") {
                setCodingMultiModel(DEFAULT_GEMINI_WORKER_MODEL);
              } else {
                setCodingMultiModel("");
              }
            }
          },
          e("option", { value: "auto" }, "요약: AUTO"),
          e("option", { value: "groq" }, "요약: Groq"),
          e("option", { value: "gemini" }, "요약: Gemini"),
          e("option", { value: "cerebras" }, "요약: Cerebras"),
          e("option", { value: "copilot" }, "요약: Copilot"),
          e("option", { value: "codex" }, "요약: Codex")),
          codingMultiProvider === "groq"
            ? e("select", {
              className: "input compact",
              value: codingMultiModel || selectedGroqModel,
              onChange: (event) => setCodingMultiModel(event.target.value)
            }, groqModelOptions.length === 0 ? e("option", { value: "" }, "Groq 모델 로딩 전") : groqModelOptions)
          : codingMultiProvider === "copilot"
              ? e("select", {
                className: "input compact",
                value: codingMultiModel || selectedCopilotModel,
                onChange: (event) => setCodingMultiModel(event.target.value)
              }, copilotModelOptions.length === 0 ? e("option", { value: "" }, "Copilot 모델 로딩 전") : copilotModelOptions)
            : codingMultiProvider === "codex"
              ? e("select", {
                className: "input compact",
                value: codingMultiModel || codingMultiCodexModel || DEFAULT_CODEX_MODEL,
                onChange: (event) => setCodingMultiModel(event.target.value)
              }, codexModelOptions)
              : codingMultiProvider === "cerebras"
                ? e("select", {
                  className: "input compact",
                  value: codingMultiModel || codingMultiCerebrasModel || DEFAULT_CEREBRAS_MODEL,
                  onChange: (event) => setCodingMultiModel(event.target.value)
                }, CEREBRAS_MODEL_CHOICES.map((item) =>
                  e("option", { key: `coding-multi-cerebras-${item.id}`, value: item.id }, item.label)
                ))
              : codingMultiProvider === "gemini"
                ? e("select", {
                  className: "input compact",
                  value: codingMultiModel || DEFAULT_GEMINI_WORKER_MODEL,
                  onChange: (event) => setCodingMultiModel(event.target.value)
                }, geminiModelOptions)
                : e("div", { className: "fixed-chip" }, "AUTO"),
          e("select", {
            className: "input compact",
            value: codingMultiLanguage,
            onChange: (event) => setCodingMultiLanguage(event.target.value)
          }, CODING_LANGUAGES.map((item) => e("option", { key: item[0], value: item[0] }, item[1])))
        ),
        e("div", { className: "toolbar" },
          e("div", { className: "fixed-chip" }, "워커 모델"),
          e("select", {
            className: "input compact",
            value: codingMultiGroqModel,
            onChange: (event) => setCodingMultiGroqModel(event.target.value)
          }, groqWorkerModelOptions),
          e("select", {
            className: "input compact",
            value: codingMultiGeminiModel,
            onChange: (event) => setCodingMultiGeminiModel(event.target.value)
          }, geminiWorkerModelOptions),
          e("select", {
            className: "input compact",
            value: codingMultiCerebrasModel,
            onChange: (event) => setCodingMultiCerebrasModel(event.target.value)
          }, [
            e("option", { key: "coding-multi-cerebras-none", value: NONE_MODEL }, "Cerebras: 선택 안함"),
            ...CEREBRAS_MODEL_CHOICES.map((item) =>
              e("option", { key: `coding-multi-cerebras-worker-${item.id}`, value: item.id }, item.label)
            )
          ]),
          e("select", {
            className: "input compact",
            value: codingMultiCopilotModel,
            onChange: (event) => setCodingMultiCopilotModel(event.target.value)
          }, copilotWorkerModelOptions),
          e("select", {
            className: "input compact",
            value: codingMultiCodexModel,
            onChange: (event) => setCodingMultiCodexModel(event.target.value)
          }, codexWorkerModelOptions)
        ),
        renderComposerInputBar({
          value: codingInputMulti,
          onChange: (event) => setCodingInputMulti(event.target.value),
          onSend: sendCodingMulti,
          pendingKey: "coding:multi",
          placeholder: "여러 모델별 코드 생성/실행 + 공통점 요약"
        })
      );
    }

    function renderWorkspace() {
      const composer = rootTab === "chat" ? renderChatComposer() : renderCodingComposer();
      const mobileWorkspaceSections = [
        { key: "list", label: rootTab === "coding" ? "작업함" : "보관함" },
        { key: "thread", label: "대화" },
        { key: "support", label: rootTab === "coding" ? "결과" : "보조" }
      ];

      if (isPortraitMobileLayout) {
        const mobileThreadPanelHeight = Math.max(300, mobileWorkspaceHeight - 58);
        return e(
          "div",
          {
            className: "workspace-mobile-shell",
            style: mobileWorkspaceHeight > 0 ? { minHeight: `${mobileWorkspaceHeight}px` } : undefined
          },
          renderResponsiveSectionTabs(
            mobileWorkspaceSections,
            currentWorkspacePane,
            (paneKey) => setResponsivePane(responsiveWorkspaceKey, paneKey),
            "workspace-mobile-tabs"
          ),
          currentWorkspacePane === "list"
            ? renderConversationPanel()
            : e(
              "section",
              {
                className: "chat-panel chat-panel-mobile",
                style: currentWorkspacePane === "thread" && mobileWorkspaceHeight > 0
                  ? { height: `${mobileThreadPanelHeight}px`, minHeight: `${mobileThreadPanelHeight}px` }
                  : undefined
              },
              renderThreadHeader({ showInfoPanel: false, showActionButtons: false, showModebar: false }),
              errorByKey[currentKey] ? e("div", { className: "error-banner" }, errorByKey[currentKey]) : null,
              currentWorkspacePane === "thread"
                ? e(
                  React.Fragment,
                  null,
                  renderMessages(),
                  composer
                )
                : null,
              currentWorkspacePane === "support" ? renderResponsiveWorkspaceSupportPane() : null,
              null
            )
        );
      }

      return e(
        "div",
        { className: "workspace-grid" },
        renderConversationPanel(),
        e(
          "section",
          { className: "chat-panel" },
          renderThreadHeader(),
          errorByKey[currentKey] ? e("div", { className: "error-banner" }, errorByKey[currentKey]) : null,
          renderMessages(),
          renderThreadSupportStack(),
          composer
        )
      );
    }

    function renderRoutineScheduleBuilder(form, formType) {
      const scheduleSourceMode = normalizeRoutineScheduleSourceMode(form.scheduleSourceMode, "auto");
      const scheduleKind = form.scheduleKind || "daily";
      return e(
        "div",
        { className: "routine-editor-card routine-schedule-editor" },
        e("div", { className: "routine-editor-section-head" },
          e("div", { className: "routine-editor-title" }, "스케줄"),
          e("div", { className: "routine-editor-subtitle" }, formatRoutineSchedulePreview(form))
        ),
        e("div", { className: "routine-segmented-control routine-source-control" },
          e("button", {
            type: "button",
            className: `routine-segment-btn ${scheduleSourceMode === "auto" ? "active" : ""}`,
            onClick: () => patchRoutineForm(formType, { scheduleSourceMode: "auto" })
          }, "자동(요청 원문)"),
          e("button", {
            type: "button",
            className: `routine-segment-btn ${scheduleSourceMode === "manual" ? "active" : ""}`,
            onClick: () => patchRoutineForm(formType, { scheduleSourceMode: "manual" })
          }, "수동")
        ),
        scheduleSourceMode === "auto"
          ? e("div", { className: "routine-auto-schedule-note" },
            e("strong", null, "요청 원문 우선"),
            e("span", null, "요청에 적은 매일, 요일, 시간 표현을 그대로 사용합니다. 수동으로 바꾸면 아래 스케줄 설정이 요청 원문보다 우선합니다.")
          )
          : e(
            React.Fragment,
            null,
            e("div", { className: "routine-segmented-control" },
              ["daily", "weekly", "monthly"].map((kind) => e("button", {
                key: `${formType}-${kind}`,
                type: "button",
                className: `routine-segment-btn ${scheduleKind === kind ? "active" : ""}`,
                onClick: () => patchRoutineForm(formType, { scheduleKind: kind })
              }, kind === "daily" ? "매일" : kind === "weekly" ? "주간" : "월간"))
            ),
            e("div", { className: "routine-form-grid routine-form-grid-tight" },
              e("label", { className: "routine-field" },
                e("span", { className: "routine-field-label" }, "실행 시간"),
                e("input", {
                  className: "input",
                  type: "time",
                  value: form.scheduleTime || "08:00",
                  onChange: (event) => patchRoutineForm(formType, { scheduleTime: event.target.value })
                })
              ),
              e("label", { className: "routine-field" },
                e("span", { className: "routine-field-label" }, "시간대"),
                e("input", {
                  className: "input",
                  value: form.timezoneId || getRoutineLocalTimezone(),
                  onChange: (event) => patchRoutineForm(formType, { timezoneId: event.target.value })
                })
              )
            ),
            scheduleKind === "weekly"
              ? e("div", { className: "routine-weekday-picker" },
                ROUTINE_WEEKDAY_OPTIONS.map((item) => {
                  const active = normalizeRoutineWeekdays(form.weekdays || []).includes(item.value);
                  return e("button", {
                    key: `${formType}-weekday-${item.value}`,
                    type: "button",
                    className: `routine-weekday-btn ${active ? "active" : ""}`,
                    onClick: () => toggleRoutineWeekday(formType, item.value)
                  }, item.label);
                })
              )
              : null,
            scheduleKind === "monthly"
              ? e("label", { className: "routine-field" },
                e("span", { className: "routine-field-label" }, "실행 날짜"),
                e("select", {
                  className: "input",
                  value: `${Math.min(31, Math.max(1, Number(form.dayOfMonth || 1) || 1))}`,
                  onChange: (event) => patchRoutineForm(formType, { dayOfMonth: Number(event.target.value) || 1 })
                }, Array.from({ length: 31 }, (_, index) => index + 1).map((value) =>
                  e("option", { key: `${formType}-dom-${value}`, value }, `${value}일`)
                ))
              )
              : null
          )
      );
    }

    function renderRoutineExecutionModeBuilder(form, formType) {
      const visibleMode = resolveRoutineVisibleExecutionMode(form);
      const explicitMode = normalizeRoutineExecutionModeValue(form.executionMode);
      const agentProvider = (form.agentProvider || DEFAULT_ROUTINE_AGENT_PROVIDER).trim().toLowerCase() || DEFAULT_ROUTINE_AGENT_PROVIDER;
      const agentModelOptions = routineAgentModelOptions;
      return e(
        "div",
        { className: "routine-editor-card routine-execution-editor" },
        e("div", { className: "routine-editor-section-head" },
          e("div", { className: "routine-editor-title" }, "실행 모드"),
          e("div", { className: "routine-editor-subtitle" }, `${formatRoutineExecutionModeLabel(visibleMode)} · ${explicitMode ? "명시 선택" : "요청 기반 자동 감지"}`)
        ),
        e("div", { className: "routine-segmented-control routine-mode-control" },
          [
            ["", "자동"],
            ["web", "일반 답변"],
            ["url", "URL 참조"],
            ["script", "스크립트"],
            ["browser_agent", "브라우저 에이전트"]
          ].map(([value, label]) => e("button", {
            key: `${formType}-mode-${value}`,
            type: "button",
            className: `routine-segment-btn ${value ? (explicitMode === value ? "active" : "") : (!explicitMode ? "active" : "")}`,
            onClick: () => patchRoutineForm(formType, {
              executionMode: value,
              agentProvider: value === "browser_agent" ? (form.agentProvider || DEFAULT_ROUTINE_AGENT_PROVIDER) : form.agentProvider,
              agentModel: value === "browser_agent"
                ? ((form.agentModel || "").trim() || getRoutineAgentModelFallback(form.agentProvider || DEFAULT_ROUTINE_AGENT_PROVIDER))
                : form.agentModel,
              agentUsePlaywright: value === "browser_agent"
            })
          }, value === "browser_agent"
            ? e(React.Fragment, null, "브라우저", e("br"), "에이전트")
            : label))
        ),
        !form.executionMode
          ? e("div", { className: "routine-auto-schedule-note routine-auto-execution-note" },
            e("strong", null, "자동 감지 중"),
            e("span", null, "URL이 있으면 URL 참조, 최신 정보 질의면 일반 답변, 그 외는 스크립트로 처리합니다. 브라우저 에이전트는 명시 선택일 때만 사용합니다.")
          )
          : null,
        visibleMode === "browser_agent"
          ? e("div", { className: "routine-form-grid routine-form-grid-agent" },
            e("label", { className: "routine-field" },
              e("span", { className: "routine-field-label" }, "에이전트 제공자"),
              e("select", {
                className: "input",
                value: agentProvider,
                onChange: (event) => {
                  const nextProvider = event.target.value || DEFAULT_ROUTINE_AGENT_PROVIDER;
                  patchRoutineForm(formType, {
                    agentProvider: nextProvider,
                    agentModel: getRoutineAgentModelFallback(nextProvider)
                  });
                }
              }, routineAgentProviderOptions)
            ),
            e("label", { className: "routine-field" },
              e("span", { className: "routine-field-label" }, "에이전트 모델"),
              e("select", {
                className: "input",
                value: (form.agentModel || "").trim() || getRoutineAgentModelFallback(agentProvider),
                onChange: (event) => patchRoutineForm(formType, { agentModel: event.target.value })
              }, agentModelOptions)
            ),
            e("label", { className: "routine-field routine-field-full" },
              e("span", { className: "routine-field-label" }, "시작 URL"),
              e("input", {
                className: "input",
                value: form.agentStartUrl || "",
                onChange: (event) => patchRoutineForm(formType, { agentStartUrl: event.target.value }),
                placeholder: "비워두면 요청 원문에 포함된 첫 URL 사용"
              })
            ),
            e("label", { className: "routine-field" },
              e("span", { className: "routine-field-label" }, "타임아웃(초)"),
              e("input", {
                className: "input",
                type: "number",
                min: 30,
                max: 1800,
                value: `${Math.min(1800, Math.max(30, Number(form.agentTimeoutSeconds ?? 180) || 180))}`,
                onChange: (event) => patchRoutineForm(formType, { agentTimeoutSeconds: Number(event.target.value) || 180 })
              })
            ),
            e("div", { className: "routine-auto-schedule-note routine-agent-note" },
              e("strong", null, "Playwright 전용"),
              e("span", null, "브라우저 자동화는 Playwright만 사용합니다. 로그인, 다운로드, 데스크톱 전체 제어는 허용하지 않습니다.")
            )
          )
          : null
      );
    }

    function renderRoutineRunHistory(routineId, runs) {
      if (!Array.isArray(runs) || runs.length === 0) {
        return e("div", { className: "empty routine-history-empty" }, "실행 이력이 아직 없습니다.");
      }

      return e("div", { className: "routine-history-list" },
        runs.map((run) => e("article", { key: `${run.ts}-${run.runAtLocal}`, className: "routine-run-item" },
          e("div", { className: "routine-run-head" },
            e("div", { className: "routine-run-main" },
              e("span", { className: `meta-chip ${run.status === "error" ? "error" : run.status === "success" ? "ok" : "neutral"}` }, run.status || "-"),
              e("strong", null, run.runAtLocal || "-")
            ),
            e("div", { className: "routine-run-meta" }, `${run.source || "-"} · ${run.durationText || "-"} · ${Math.max(1, Number(run.attemptCount || 1))}회`)
          ),
          e("div", { className: "routine-run-summary" }, run.summary || "요약 없음"),
          run.error ? e("div", { className: "routine-run-error" }, run.error) : null,
          run.agentProvider || run.agentModel
            ? e("div", { className: "routine-run-next" }, `agent ${run.agentProvider || "-"}:${run.agentModel || "-"}`)
            : null,
          run.finalUrl ? e("div", { className: "routine-run-next" }, `최종 URL ${run.finalUrl}`) : null,
          run.pageTitle ? e("div", { className: "routine-run-next" }, `페이지 ${run.pageTitle}`) : null,
          run.screenshotPath ? e("div", { className: "routine-run-next" }, `스크린샷 ${run.screenshotPath}`) : null,
          run.telegramStatus ? e("div", { className: "routine-run-next" }, `텔레그램 ${run.telegramStatus}`) : null,
          run.nextRunLocal ? e("div", { className: "routine-run-next" }, `다음 실행 ${run.nextRunLocal}`) : null,
          e("div", { className: "routine-run-actions" },
            e("button", {
              type: "button",
              className: "btn",
              onClick: () => openRoutineRunDetail(routineId, run.ts)
            }, "상세"),
            e("button", {
              type: "button",
              className: "btn",
              onClick: () => resendRoutineRunTelegram(routineId, run.ts)
            }, "텔레그램 재전송")
          )
        ))
      );
    }

    function renderRoutine() {
      const selected = routines.find((item) => item.id === routineSelectedId) || null;
      const selectedRuns = Array.isArray(selected?.runs) ? selected.runs : [];
      const enabledCount = routines.filter((item) => !!item.enabled).length;
      const browserAgentCount = routines.filter((item) =>
        normalizeRoutineExecutionModeValue(item.resolvedExecutionMode || item.executionMode) === "browser_agent"
      ).length;
      const failedCount = routines.filter((item) =>
        /error|fail|timeout|blocked/i.test(`${item && item.lastStatus ? item.lastStatus : ""}`)
      ).length;
      const scheduledCount = routines.filter((item) => `${item && item.nextRunLocal ? item.nextRunLocal : ""}`.trim().length > 0).length;
      const selectedModeLabel = selected
        ? formatRoutineExecutionModeLabel(selected.resolvedExecutionMode || selected.executionMode || "script")
        : "루틴 선택 대기";
      const selectedScheduleSource = selected
        ? (normalizeRoutineScheduleSourceMode(selected.scheduleSourceMode, "manual") === "auto" ? "요청 원문 기준" : "수동 스케줄")
        : "왼쪽 목록에서 선택";
      const selectedHeadline = selected
        ? `${selected.scheduleText || "-"} · ${selected.lastStatus || "실행 전"}`
        : "루틴을 선택하면 실행 상태와 스케줄을 한눈에 확인할 수 있습니다.";
      const selectedRequestPreview = selected && `${selected.request || ""}`.trim()
        ? selected.request
        : "선택된 루틴이 없으면 이 영역에 요청 원문과 최근 상태가 표시됩니다.";
      const routineMobileSections = [
        { key: "overview", label: "개요" },
        { key: "create", label: "생성" },
        { key: "list", label: "목록" },
        { key: "detail", label: "상세" }
      ];
      const overviewCards = e("div", { className: "routine-overview-grid" },
        e("div", { className: "routine-overview-card routine-overview-card-selected" },
          e("div", { className: "routine-overview-label" }, selected ? "선택된 루틴" : "상세 패널"),
          e("div", { className: "routine-overview-value routine-overview-value-lg" }, selected ? (selected.title || selected.id) : selectedModeLabel),
          e("div", { className: "routine-overview-note" }, `${selectedScheduleSource} · ${selectedModeLabel}`),
          e("div", { className: "routine-overview-note routine-overview-note-strong" }, selectedHeadline)
        ),
        e("div", { className: "routine-overview-card" },
          e("div", { className: "routine-overview-label" }, "전체 루틴"),
          e("div", { className: "routine-overview-value" }, `${routines.length}`),
          e("div", { className: "routine-overview-note" }, "등록된 자동화 작업 수")
        ),
        e("div", { className: "routine-overview-card" },
          e("div", { className: "routine-overview-label" }, "활성 루틴"),
          e("div", { className: "routine-overview-value" }, `${enabledCount}`),
          e("div", { className: "routine-overview-note" }, `비활성 ${Math.max(0, routines.length - enabledCount)}개`)
        ),
        e("div", { className: "routine-overview-card" },
          e("div", { className: "routine-overview-label" }, "예약 대기"),
          e("div", { className: "routine-overview-value" }, `${scheduledCount}`),
          e("div", { className: "routine-overview-note" }, "다음 실행 시간이 잡힌 루틴")
        ),
        e("div", { className: "routine-overview-card" },
          e("div", { className: "routine-overview-label" }, "브라우저 에이전트"),
          e("div", { className: "routine-overview-value" }, `${browserAgentCount}`),
          e("div", { className: "routine-overview-note" }, "Playwright 기반 자동화")
        ),
        e("div", { className: "routine-overview-card" },
          e("div", { className: "routine-overview-label" }, "최근 오류"),
          e("div", { className: "routine-overview-value" }, `${failedCount}`),
          e("div", { className: "routine-overview-note" }, "마지막 실행 기준 오류/타임아웃")
        ),
        e("button", {
          type: "button",
          className: "routine-overview-card routine-overview-action-card",
          onClick: refreshRoutines
        },
          e("div", { className: "routine-overview-label" }, "새로고침"),
          e("div", { className: "routine-overview-value" }, "동기화"),
          e("div", { className: "routine-overview-note" }, "루틴 상태와 실행 이력 다시 조회")
        )
      );
      const createPanel = e("section", { className: "routine-list-panel routine-create-panel" },
        e("div", { className: "routine-head" },
          e("div", null,
            e("div", { className: "routine-head-kicker" }, "새 루틴"),
            e("h2", null, "루틴 만들기")
          )
        ),
        e("p", { className: "hint routine-panel-hint" }, "활성화된 루틴은 스케줄 시 자동으로 텔레그램 봇에 전송됩니다. 생성 직후에는 즉시 1회 실행합니다."),
        errorByKey["routine:main"] ? e("div", { className: "error-banner" }, errorByKey["routine:main"]) : null,
        e("div", { className: "routine-section-card routine-create-card" },
          e("div", { className: "routine-form-grid routine-form-grid-primary" },
            e("label", { className: "routine-field" },
              e("span", { className: "routine-field-label" }, "루틴 이름"),
              e("input", {
                className: "input",
                value: routineCreateForm.title,
                onChange: (event) => patchRoutineForm("create", { title: event.target.value }),
                placeholder: "비워두면 요청 기반으로 자동 생성"
              })
            ),
            e("label", { className: "routine-field routine-field-full" },
              e("span", { className: "routine-field-label" }, "요청 원문"),
              e("textarea", {
                className: "textarea routine-input",
                value: routineCreateForm.request,
                onChange: (event) => patchRoutineForm("create", { request: event.target.value }),
                onKeyDown: (event) => onInputKeyDown(event, createRoutineFromUi),
                placeholder: "예: 매일 오전 8시에 주요 기사와 서버 상태를 요약해줘"
              })
            )
          ),
          e("div", { className: "routine-execution-config-stack" },
            renderRoutineExecutionModeBuilder(routineCreateForm, "create"),
            e("div", { className: "routine-form-grid" },
              e("label", { className: "routine-field" },
                e("span", { className: "routine-field-label" }, "실패 재시도"),
                e("input", {
                  className: "input",
                  type: "number",
                  min: 0,
                  max: 5,
                  value: `${Math.min(5, Math.max(0, Number(routineCreateForm.maxRetries ?? 1) || 0))}`,
                  onChange: (event) => patchRoutineForm("create", { maxRetries: Number(event.target.value) || 0 })
                })
              ),
              e("label", { className: "routine-field" },
                e("span", { className: "routine-field-label" }, "재시도 간격(초)"),
                e("input", {
                  className: "input",
                  type: "number",
                  min: 0,
                  max: 300,
                  value: `${Math.min(300, Math.max(0, Number(routineCreateForm.retryDelaySeconds ?? 15) || 0))}`,
                  onChange: (event) => patchRoutineForm("create", { retryDelaySeconds: Number(event.target.value) || 0 })
                })
              ),
              e("label", { className: "routine-field routine-field-full" },
                e("span", { className: "routine-field-label" }, "텔레그램 알림"),
                e("select", {
                  className: "input",
                  value: normalizeRoutineNotifyPolicy(routineCreateForm.notifyPolicy, "always"),
                  onChange: (event) => patchRoutineForm("create", { notifyPolicy: event.target.value })
                },
                e("option", { value: "always" }, "항상"),
                e("option", { value: "on_change" }, "변경 시만"),
                e("option", { value: "error_only" }, "오류 시만"),
                e("option", { value: "never" }, "보내지 않음"))
              )
            )
          )
        ),
        renderRoutineScheduleBuilder(routineCreateForm, "create"),
        e("div", { className: "routine-submit-row" },
          e("button", { className: "btn primary routine-submit-btn", onClick: createRoutineFromUi }, "루틴 생성")
        )
      );
      const listPanel = e("section", { className: "routine-list-panel routine-library-panel" },
        e("div", { className: "routine-head" },
          e("div", null,
            e("div", { className: "routine-head-kicker" }, "목록"),
            e("h2", null, `${routines.length}개 루틴`)
          ),
          e("div", { className: "routine-library-meta" }, `${enabledCount}개 활성`)
        ),
        e("div", { className: "routine-list" },
          routines.length === 0
            ? e("div", { className: "empty routine-empty-state" }, "등록된 루틴이 없습니다.")
            : routines.map((item) => e(
              "button",
              {
                key: item.id,
                className: `routine-item ${routineSelectedId === item.id ? "active" : ""}`,
                onClick: () => {
                  setRoutineSelectedId(item.id);
                  if (isPortraitMobileLayout) {
                    setResponsivePane("routine", "detail");
                  }
                }
              },
              e("div", { className: "routine-item-head" },
                e("div", { className: "routine-item-title" }, item.title || item.id),
                e("span", { className: `meta-chip ${item.enabled ? "ok" : "neutral"}` }, item.enabled ? "ON" : "OFF")
              ),
              e("div", { className: "routine-item-meta" },
                e("span", { className: "meta-chip neutral" }, formatRoutineExecutionModeLabel(item.resolvedExecutionMode || item.executionMode || "script")),
                e("span", { className: "meta-chip neutral" }, normalizeRoutineScheduleSourceMode(item.scheduleSourceMode, "manual") === "auto" ? "자동" : "수동"),
                e("span", { className: "meta-chip neutral" }, item.scheduleText || "-"),
                e("span", { className: "meta-chip neutral" }, item.lastRunLocal ? `최근 ${item.lastRunLocal}` : "실행 전")
              ),
              e("div", { className: "item-preview" }, item.request || "")
            ))
        )
      );
      const detailPanel = e("section", { className: "routine-detail-panel" },
        !selected
          ? e("div", { className: "routine-section-card routine-empty-card" },
            e("div", { className: "empty routine-empty-state" }, "왼쪽 목록에서 루틴을 선택하면 상세 설정과 실행 이력을 볼 수 있습니다.")
          )
          : e(
            React.Fragment,
            null,
            e("div", { className: "routine-section-card routine-detail-header-card" },
              e("div", { className: "routine-detail-head" },
                e("div", { className: "routine-detail-copy" },
                  e("div", { className: "routine-head-kicker" }, "루틴 상세"),
                  e("strong", null, selected.title || selected.id),
                  e("div", { className: "routine-item-meta" },
                    e("span", { className: `meta-chip ${selected.enabled ? "ok" : "neutral"}` }, selected.enabled ? "활성" : "비활성"),
                    e("span", { className: "meta-chip neutral" }, formatRoutineExecutionModeLabel(selected.resolvedExecutionMode || selected.executionMode || "script")),
                    e("span", { className: "meta-chip neutral" }, normalizeRoutineScheduleSourceMode(selected.scheduleSourceMode, "manual") === "auto" ? "자동" : "수동"),
                    e("span", { className: "meta-chip neutral" }, selected.scheduleText || "-"),
                    e("span", { className: "meta-chip neutral" }, selected.language || "-")
                  )
                ),
                e("div", { className: "routine-action-row" },
                  e("button", { className: "btn primary", onClick: () => runRoutineNow(selected.id) }, "웹 테스트"),
                  (selected.resolvedExecutionMode || selected.executionMode) === "browser_agent"
                    ? e("button", { className: "btn", onClick: () => testRoutineBrowserAgent(selected.id) }, "브라우저 에이전트 테스트")
                    : null,
                  e("button", { className: "btn", onClick: () => testRoutineTelegram(selected.id) }, "텔레그램 테스트"),
                  e("button", { className: "btn", onClick: () => setRoutineEnabled(selected.id, !selected.enabled) }, selected.enabled ? "비활성화" : "활성화"),
                  e("button", { className: "btn ghost", onClick: () => deleteRoutineById(selected.id) }, "삭제")
                )
              ),
              e("div", { className: "routine-request-preview" }, selectedRequestPreview)
            ),
            e("div", { className: "routine-stats-grid" },
              e("div", { className: "routine-stat-card" },
                e("span", { className: "routine-stat-label" }, "다음 실행"),
                e("strong", null, selected.nextRunLocal || "-")
              ),
              e("div", { className: "routine-stat-card" },
                e("span", { className: "routine-stat-label" }, "마지막 실행"),
                e("strong", null, selected.lastRunLocal || "-")
              ),
              e("div", { className: "routine-stat-card" },
                e("span", { className: "routine-stat-label" }, "상태"),
                e("strong", null, selected.lastStatus || "-")
              ),
              e("div", { className: "routine-stat-card" },
                e("span", { className: "routine-stat-label" }, "생성 모델"),
                e("strong", null, selected.coderModel || "-")
              ),
              e("div", { className: "routine-stat-card" },
                e("span", { className: "routine-stat-label" }, "실행 모드"),
                e("strong", null, formatRoutineExecutionModeLabel(selected.resolvedExecutionMode || selected.executionMode || "script"))
              ),
              e("div", { className: "routine-stat-card" },
                e("span", { className: "routine-stat-label" }, "알림 정책"),
                e("strong", null, normalizeRoutineNotifyPolicy(selected.notifyPolicy, "always"))
              )
            ),
            e("div", { className: "routine-detail-grid" },
              e("div", { className: "routine-primary-column" },
                e("div", { className: "routine-section-card routine-edit-card" },
                  e("div", { className: "routine-editor-section-head" },
                    e("div", { className: "routine-editor-title" }, "루틴 수정"),
                    e("div", { className: "routine-editor-subtitle" }, "요청이나 스케줄을 바꾸면 실행 코드를 다시 만듭니다.")
                  ),
                  e("div", { className: "routine-form-grid routine-form-grid-primary" },
                    e("label", { className: "routine-field" },
                      e("span", { className: "routine-field-label" }, "루틴 이름"),
                      e("input", {
                        className: "input",
                        value: routineEditForm.title,
                        onChange: (event) => patchRoutineForm("edit", { title: event.target.value })
                      })
                    ),
                    e("label", { className: "routine-field routine-field-full" },
                      e("span", { className: "routine-field-label" }, "요청 원문"),
                      e("textarea", {
                        className: "textarea routine-input routine-input-compact",
                        value: routineEditForm.request,
                        onChange: (event) => patchRoutineForm("edit", { request: event.target.value }),
                        onKeyDown: (event) => onInputKeyDown(event, updateRoutineFromUi)
                      })
                    )
                  ),
                  e("div", { className: "routine-execution-config-stack" },
                    renderRoutineExecutionModeBuilder(routineEditForm, "edit"),
                    e("div", { className: "routine-form-grid" },
                      e("label", { className: "routine-field" },
                        e("span", { className: "routine-field-label" }, "실패 재시도"),
                        e("input", {
                          className: "input",
                          type: "number",
                          min: 0,
                          max: 5,
                          value: `${Math.min(5, Math.max(0, Number(routineEditForm.maxRetries ?? 1) || 0))}`,
                          onChange: (event) => patchRoutineForm("edit", { maxRetries: Number(event.target.value) || 0 })
                        })
                      ),
                      e("label", { className: "routine-field" },
                        e("span", { className: "routine-field-label" }, "재시도 간격(초)"),
                        e("input", {
                          className: "input",
                          type: "number",
                          min: 0,
                          max: 300,
                          value: `${Math.min(300, Math.max(0, Number(routineEditForm.retryDelaySeconds ?? 15) || 0))}`,
                          onChange: (event) => patchRoutineForm("edit", { retryDelaySeconds: Number(event.target.value) || 0 })
                        })
                      ),
                      e("label", { className: "routine-field routine-field-full" },
                        e("span", { className: "routine-field-label" }, "텔레그램 알림"),
                        e("select", {
                          className: "input",
                          value: normalizeRoutineNotifyPolicy(routineEditForm.notifyPolicy, "always"),
                          onChange: (event) => patchRoutineForm("edit", { notifyPolicy: event.target.value })
                        },
                        e("option", { value: "always" }, "항상"),
                        e("option", { value: "on_change" }, "변경 시만"),
                        e("option", { value: "error_only" }, "오류 시만"),
                        e("option", { value: "never" }, "보내지 않음"))
                      )
                    )
                  ),
                  renderRoutineScheduleBuilder(routineEditForm, "edit"),
                  e("div", { className: "routine-submit-row" },
                    e("button", { className: "btn primary routine-submit-btn", onClick: updateRoutineFromUi }, "루틴 수정 저장")
                  )
                )
              ),
              e("div", { className: "routine-secondary-column" },
                e("div", { className: "routine-section-card" },
                  e("div", { className: "routine-section-head" },
                    e("div", { className: "routine-editor-title" }, "실행 이력"),
                    e("div", { className: "routine-editor-subtitle" }, `${selectedRuns.length}건`)
                  ),
                  renderRoutineRunHistory(selected.id, selectedRuns)
                ),
                e("div", { className: "routine-section-card" },
                  e("div", { className: "routine-section-head" },
                    e("div", { className: "routine-editor-title" }, "최근 실행 출력"),
                    e("div", { className: "routine-editor-subtitle" }, selected.lastStatus || "-")
                  ),
                  e("div", { className: "routine-kv" },
                    e("div", null, `ID: ${selected.id}`),
                    e("div", null, `실행 모드: ${formatRoutineExecutionModeLabel(selected.resolvedExecutionMode || selected.executionMode || "script")}`),
                    e("div", null, `언어: ${selected.language || "-"}`),
                    e("div", null, `시간대: ${selected.timezoneId || "-"}`),
                    e("div", null, `재시도: ${Math.max(0, Number(selected.maxRetries || 0))}회 / ${Math.max(0, Number(selected.retryDelaySeconds || 0))}초`),
                    e("div", null, `알림: ${normalizeRoutineNotifyPolicy(selected.notifyPolicy, "always")}`),
                    e("div", null, `에이전트: ${(selected.agentProvider || "-")} / ${(selected.agentModel || "-")}`),
                    e("div", null, `시작 URL: ${selected.agentStartUrl || "-"}`),
                    e("div", null, `스크립트: ${selected.scriptPath || "-"}`)
                  ),
                  e("button", {
                    type: "button",
                    className: "routine-output-button",
                    onClick: () => setRoutineOutputPreview({
                      open: true,
                      title: `${selected.title || selected.id} · 최근 실행 출력`,
                      content: selected.lastOutput || "출력 없음",
                      imagePath: "",
                      imageAlt: ""
                    })
                  },
                    e("pre", { className: "routine-output" }, selected.lastOutput || "출력 없음")
                  )
                )
              )
            )
          )
      );
      return e(
        "section",
        { className: "routine-tab" },
        e("div", { className: "routine-hero" },
          e("div", { className: "routine-hero-copy" },
            e("div", { className: "routine-hero-kicker" }, "루틴"),
            e("h2", null, "반복 작업 자동화"),
            e("p", null, "생성, 스케줄, 상태, 실행 이력을 같은 화면에서 관리하는 운영형 대시보드입니다.")
          )
        ),
        isPortraitMobileLayout
          ? e(
            "div",
            { className: "routine-mobile-shell" },
            renderResponsiveSectionTabs(routineMobileSections, currentRoutinePane, (paneKey) => setResponsivePane("routine", paneKey), "routine-mobile-tabs"),
            currentRoutinePane === "overview" ? overviewCards : null,
            currentRoutinePane === "create" ? createPanel : null,
            currentRoutinePane === "list" ? listPanel : null,
            currentRoutinePane === "detail" ? detailPanel : null
          )
          : e(
            React.Fragment,
            null,
            overviewCards,
            e("div", { className: "routine-layout" },
              createPanel,
              listPanel,
              detailPanel
            )
          )
      );
    }

    function renderToolControlPanel() {
      return e(
        "section",
        { className: "panel span2 ops-panel" },
        e("h2", null, "도구 통합 패널"),
        e("p", { className: "hint" }, "provider/tool/rag 관측 분류와 sessions/cron/browser/canvas/nodes/telegram(stub)/web/memory 제어 요청을 설정 탭에서 바로 확인합니다."),
        toolControlError ? e("div", { className: "error-banner" }, toolControlError) : null,
        e("div", { className: "tool-summary-grid mt8" },
          e("button", {
            type: "button",
            className: `tool-summary-card ${opsDomainFilter === "provider" ? "active" : ""}`,
            onClick: () => applyDomainFocus("provider")
          },
            e("div", { className: "tool-summary-title" }, "provider"),
            e("div", { className: "tool-summary-main" }, providerHealthSummary.mainLabel),
            e("div", { className: "tool-summary-meta" }, `설정오류 ${providerHealthSummary.setupErrorCount}건 / 실행실패 ${providerHealthSummary.runtimeErrorCount}건`),
            e("div", { className: "tool-summary-meta" }, `실행 성공 ${providerHealthSummary.runtimeSuccessCount}건 / 진행 ${providerHealthSummary.runtimeProgressCount}건`),
            e("div", { className: "tool-summary-meta" }, `상태 ${providerHealthSummary.lastStatus}`)
          ),
          e("button", {
            type: "button",
            className: `tool-summary-card ${opsDomainFilter === "tool" ? "active" : ""}`,
            onClick: () => applyDomainFocus("tool")
          },
          e("div", { className: "tool-summary-title" }, "tool"),
          e("div", { className: "tool-summary-main" }, `${toolDomainStats.tool.count}건`),
          e("div", { className: "tool-summary-meta" }, `오류 ${toolDomainStats.tool.errorCount}건`),
          e("div", { className: "tool-summary-meta" }, `최근 ${toolDomainStats.tool.lastType}/${toolDomainStats.tool.lastStatus}`)),
          e("button", {
            type: "button",
            className: `tool-summary-card ${opsDomainFilter === "rag" ? "active" : ""}`,
            onClick: () => applyDomainFocus("rag")
          },
          e("div", { className: "tool-summary-title" }, "rag"),
          e("div", { className: "tool-summary-main" }, `${toolDomainStats.rag.count}건`),
          e("div", { className: "tool-summary-meta" }, `오류 ${toolDomainStats.rag.errorCount}건`),
          e("div", { className: "tool-summary-meta" }, `최근 ${toolDomainStats.rag.lastType}/${toolDomainStats.rag.lastStatus}`))
        ),
        e("div", { className: "table-wrap mt8" },
          e("table", { className: "model-table" },
            e("thead", null,
              e("tr", null,
                e("th", null, "provider"),
                e("th", null, "상태"),
                e("th", null, "실행(success/fail/progress)"),
                e("th", null, "근거")
              )
            ),
            e("tbody", null,
              providerRuntimeRows.map((row) => e("tr", { key: `provider-health-${row.provider}` },
                e("td", null, row.provider),
                e("td", null, e("span", { className: `tool-status-chip ${row.statusTone || "neutral"}` }, row.statusLabel || "-")),
                e("td", null, `${row.runtimeSuccessCount || 0}/${row.runtimeErrorCount || 0}/${row.runtimeProgressCount || 0}`),
                e("td", null, row.reason || "-")
              ))
            )
          )
        ),
        e("div", { className: "tool-summary-grid mt8" },
          e("div", { className: "tool-summary-card" },
            e("div", { className: "tool-summary-title" }, "guard/retry 이벤트"),
            e("div", { className: "tool-summary-main" }, `${guardObsStats.total}건`),
            e("div", { className: "tool-summary-meta" }, `guard 차단 ${guardObsStats.blockedTotal}건`),
            e("div", { className: "tool-summary-meta" }, `retryRequired ${guardObsStats.retryRequiredTotal}건`),
            e("div", { className: "tool-summary-meta" }, `count-lock 미충족 ${guardObsStats.countLockUnsatisfiedTotal}건`)
          ),
          e("div", { className: "tool-summary-card" },
            e("div", { className: "tool-summary-title" }, "citation 검증"),
            e("div", { className: "tool-summary-main" }, `fail ${guardObsStats.citationValidationFailedTotal}건`),
            e("div", { className: "tool-summary-meta" }, `citation_mapping retry ${guardObsStats.citationMappingRetryTotal}건`),
            e("div", { className: "tool-summary-meta" }, `mapping 누적 ${guardObsStats.citationMappingCountTotal}개`)
          ),
          e("div", { className: "tool-summary-card" },
            e("div", { className: "tool-summary-title" }, "telegram_guard_meta"),
            e("div", { className: "tool-summary-main" }, `${guardObsStats.telegramGuardMetaBlockedTotal}건`),
            e("div", { className: "tool-summary-meta" }, "telegram guard blocked 집계"),
            e("div", { className: "tool-summary-meta" }, "source=telegram 기준")
          ),
          e("div", { className: "tool-summary-card" },
            e("div", { className: "tool-summary-title" }, "guard 경보 상태"),
            e("div", { className: "tool-summary-main" },
              e("span", { className: `tool-status-chip ${guardAlertSummary.statusTone}` }, guardAlertSummary.statusLabel)
            ),
            e("div", { className: "tool-summary-meta" }, `triggered ${guardAlertSummary.triggeredCount}건`),
            e("div", { className: "tool-summary-meta" }, `sample_pending ${guardAlertSummary.samplePendingCount}건`)
          )
        ),
        e("div", { className: "table-wrap mt8" },
          e("table", { className: "model-table" },
            e("thead", null,
              e("tr", null,
                e("th", null, "채널"),
                e("th", null, "이벤트"),
                e("th", null, "guard 차단"),
                e("th", null, "retryRequired"),
                e("th", null, "count-lock 미충족"),
                e("th", null, "count-lock 비율"),
                e("th", null, "citation fail"),
                e("th", null, "citation_mapping retry"),
                e("th", null, "retry 시도 최대"),
                e("th", null, "최근 retry")
              )
            ),
            e("tbody", null,
              ["chat", "coding", "telegram", "search", "other"].map((channel) => {
                const stat = guardObsStats.byChannel[channel] || {
                  count: 0,
                  blockedCount: 0,
                  retryRequiredCount: 0,
                  countLockUnsatisfiedCount: 0,
                  citationValidationFailedCount: 0,
                  citationMappingRetryCount: 0,
                  maxRetryAttempt: 0,
                  maxRetryMaxAttempts: 0,
                  lastRetryAction: "-",
                  lastRetryReason: "-",
                  lastRetryStopReason: "-"
                };
                const countLockUnsatisfiedRate = (stat.count || 0) > 0
                  ? (stat.countLockUnsatisfiedCount || 0) / (stat.count || 1)
                  : 0;
                return e("tr", { key: `guard-obs-${channel}` },
                  e("td", null, channel),
                  e("td", null, stat.count || 0),
                  e("td", null, stat.blockedCount || 0),
                  e("td", null, stat.retryRequiredCount || 0),
                  e("td", null, stat.countLockUnsatisfiedCount || 0),
                  e("td", null, formatGuardAlertThreshold("rate", countLockUnsatisfiedRate)),
                  e("td", null, stat.citationValidationFailedCount || 0),
                  e("td", null, stat.citationMappingRetryCount || 0),
                  e("td", null, `${stat.maxRetryAttempt || 0}/${stat.maxRetryMaxAttempts || 0}`),
                  e("td", null, `${stat.lastRetryAction || "-"}/${stat.lastRetryReason || "-"} (${stat.lastRetryStopReason || "-"})`)
                );
              })
            )
          )
        ),
        e("div", { className: "table-wrap mt8" },
          e("table", { className: "model-table" },
            e("caption", null, `retry 시계열 (${guardRetryTimeline.bucketMinutes}분 버킷, 최근 ${guardRetryTimeline.windowMinutes}분)`),
            e("thead", null,
              e("tr", null,
                e("th", null, "채널"),
                e("th", null, "버킷 시작(UTC)"),
                e("th", null, "샘플"),
                e("th", null, "retryRequired"),
                e("th", null, "max retry"),
                e("th", null, "max retryMax"),
                e("th", null, "top retryStopReason"),
                e("th", null, "고유 stopReason")
              )
            ),
            e("tbody", null,
              guardRetryTimelineRows.length === 0
                ? e("tr", null, e("td", { colSpan: 8 }, "채널 공통 retry 시계열 데이터가 없습니다."))
                : guardRetryTimelineRows.map((row, index) => e("tr", { key: `guard-retry-timeline-${row.channel}-${row.bucketStartUtc}-${index}` },
                  e("td", null, row.channel),
                  e("td", null, row.bucketStartUtc),
                  e("td", null, row.samples),
                  e("td", null, row.retryRequiredCount),
                  e("td", null, row.maxRetryAttempt),
                  e("td", null, row.maxRetryMaxAttempts),
                  e("td", null, row.topRetryStopReason),
                  e("td", null, row.uniqueRetryStopReasons)
                ))
            )
          )
        ),
        e(
          "div",
          { className: "hint" },
          `retry 시계열 source=${guardRetryTimelineSource}`,
          guardRetryTimelineSource === "server_api" && guardRetryTimelineApiFetchedAt
            ? ` · fetchedAt=${guardRetryTimelineApiFetchedAt}`
            : "",
          guardRetryTimelineSource === "memory_fallback" && guardRetryTimelineApiError
            ? ` · fallbackReason=${guardRetryTimelineApiError}`
            : ""
        ),
        e("div", { className: "table-wrap mt8" },
          e("table", { className: "model-table" },
            e("caption", null, "guard 경보 임계치(warn/critical)"),
            e("thead", null,
              e("tr", null,
                e("th", null, "규칙"),
                e("th", null, "측정값"),
                e("th", null, "warn"),
                e("th", null, "critical"),
                e("th", null, "상태"),
                e("th", null, "비고")
              )
            ),
            e("tbody", null,
              guardObsStats.guardAlertRows.map((row) => e("tr", { key: `guard-alert-${row.id}` },
                e("td", null, row.label),
                e("td", null, row.valueLabel),
                e("td", null, row.warnLabel),
                e("td", null, row.criticalLabel),
                e("td", null, e("span", { className: `tool-status-chip ${row.statusTone}` }, row.statusLabel)),
                e("td", null, row.note || "-")
              ))
            )
          )
        ),
        e("div", { className: "table-wrap mt8" },
          e("table", { className: "model-table" },
            e("caption", null, "guard 경보 외부 전송 스키마(v1)"),
            e("thead", null,
              e("tr", null,
                e("th", null, "필드 경로"),
                e("th", null, "타입"),
                e("th", null, "필수"),
                e("th", null, "설명")
              )
            ),
            e("tbody", null,
              GUARD_ALERT_PIPELINE_FIELD_ROWS.map((field) => e("tr", { key: `guard-alert-schema-${field.path}` },
                e("td", null, field.path),
                e("td", null, field.type),
                e("td", null, field.required),
                e("td", null, field.description)
              ))
            )
          )
        ),
        e("div", { className: "hint mt8" }, "외부 관제(Webhook/로그 수집) 연동 시 아래 JSON 샘플을 이벤트 스키마 기준으로 사용합니다."),
        e("div", { className: "tool-filter-row mt8" },
          e("button", { className: "btn", disabled: !authed, onClick: submitGuardAlertDispatch }, "guard_alert_event.v1 전송"),
          e("span", { className: `tool-status-chip ${guardAlertDispatchState.statusTone}` }, guardAlertDispatchState.statusLabel),
          e("span", { className: "hint" }, `sent=${guardAlertDispatchState.sentCount} failed=${guardAlertDispatchState.failedCount} skipped=${guardAlertDispatchState.skippedCount}`),
          e("span", { className: "hint" }, `at=${guardAlertDispatchState.attemptedAtUtc}`)
        ),
        e("div", { className: "hint" }, guardAlertDispatchState.message || "-"),
        e("div", { className: "table-wrap mt8" },
          e("table", { className: "model-table" },
            e("caption", null, "guard 경보 외부 전송 결과"),
            e("thead", null,
              e("tr", null,
                e("th", null, "대상"),
                e("th", null, "상태"),
                e("th", null, "시도"),
                e("th", null, "HTTP"),
                e("th", null, "오류"),
                e("th", null, "endpoint")
              )
            ),
            e("tbody", null,
              Array.isArray(guardAlertDispatchState.targets) && guardAlertDispatchState.targets.length > 0
                ? guardAlertDispatchState.targets.map((item, index) => e("tr", { key: `guard-alert-dispatch-${item.name}-${index}` },
                  e("td", null, item.name || "-"),
                  e("td", null, item.status || "-"),
                  e("td", null, Number.isFinite(Number(item.attempts)) ? Number(item.attempts) : 0),
                  e("td", null, Number.isFinite(Number(item.statusCode)) ? Number(item.statusCode) : "-"),
                  e("td", null, item.error || "-"),
                  e("td", null, item.endpoint || "-")
                ))
                : e("tr", null, e("td", { colSpan: 6 }, "아직 전송 이력이 없습니다."))
            )
          )
        ),
        e("pre", { className: "screen metrics" }, guardAlertPipelinePreview),
        e("div", { className: "table-wrap mt8" },
          e("table", { className: "model-table" },
            e("thead", null,
              e("tr", null,
                e("th", null, "분류"),
                e("th", null, "키"),
                e("th", null, "횟수")
              )
            ),
            e("tbody", null,
              (() => {
                const rows = [];
                guardObsStats.topRetryActions.forEach((item) => {
                  rows.push({ kind: "retryAction", name: item.name, count: item.count });
                });
                guardObsStats.topRetryReasons.forEach((item) => {
                  rows.push({ kind: "retryReason", name: item.name, count: item.count });
                });
                guardObsStats.topRetryStopReasons.forEach((item) => {
                  rows.push({ kind: "retryStopReason", name: item.name, count: item.count });
                });
                if (rows.length === 0) {
                  return e("tr", null, e("td", { colSpan: 3 }, "retryAction/retryReason/retryStopReason 집계 데이터가 없습니다."));
                }
                return rows.map((row, index) => e("tr", { key: `guard-obs-row-${row.kind}-${row.name}-${index}` },
                  e("td", null, row.kind),
                  e("td", null, row.name),
                  e("td", null, row.count)
                ));
              })()
            )
          )
        ),
        e("div", { className: "tool-summary-grid mt8" },
          TOOL_RESULT_GROUPS.map((group) => {
            const stat = toolResultStats.byGroup[group.key] || { count: 0, errorCount: 0, lastAction: "-", lastStatus: "-" };
            return e(
              "button",
              {
                key: group.key,
                type: "button",
                className: `tool-summary-card ${toolResultFilter === group.key ? "active" : ""}`,
                onClick: () => setToolResultFilter(group.key)
              },
              e("div", { className: "tool-summary-title" }, group.label),
              e("div", { className: "tool-summary-main" }, `${stat.count}건`),
              e("div", { className: "tool-summary-meta" }, `오류 ${stat.errorCount}건`),
              e("div", { className: "tool-summary-meta" }, `최근 ${stat.lastAction}/${stat.lastStatus}`)
            );
          })
        ),
        e("div", { className: "tool-filter-row mt8" },
          TOOL_RESULT_FILTERS.map((filterItem) => {
            const count = filterItem.key === "all"
              ? toolResultStats.total
              : (filterItem.key === "errors"
                ? toolResultStats.errors
                : ((toolResultStats.byGroup[filterItem.key] || {}).count || 0));
            return e(
              "button",
              {
                key: filterItem.key,
                type: "button",
                className: `btn tool-filter-btn ${toolResultFilter === filterItem.key ? "active" : ""}`,
                onClick: () => setToolResultFilter(filterItem.key)
              },
              `${filterItem.label} (${count})`
            );
          })
        ),
        e("div", { className: "tool-filter-row mt8" },
          TOOL_DOMAIN_FILTERS.map((domainItem) => {
            const count = domainItem.key === "all"
              ? toolResultItems.length
              : ((toolDomainStats[domainItem.key] || {}).count || 0);
            return e(
              "button",
              {
                key: domainItem.key,
                type: "button",
                className: `btn tool-filter-btn ${toolDomainFilter === domainItem.key ? "active" : ""}`,
                onClick: () => applyDomainFocus(domainItem.key)
              },
              `${domainItem.label} (${count})`
            );
          })
        ),
        e("div", { className: "row mt8" },
          e("button", { className: "btn", disabled: !authed, onClick: submitSessionsList }, "sessions_list"),
          e("button", { className: "btn", disabled: !authed, onClick: submitCronStatus }, "cron.status"),
          e("button", { className: "btn", disabled: !authed, onClick: submitBrowserStatus }, "browser.status"),
          e("button", { className: "btn", disabled: !authed, onClick: submitCanvasStatus }, "canvas.status"),
          e("button", { className: "btn", disabled: !authed, onClick: submitNodesStatus }, "nodes.status")
        ),
        e("div", { className: "row mt8" },
          e("input", {
            className: "input",
            value: toolSessionKey,
            onChange: (event) => setToolSessionKey(event.target.value),
            placeholder: "sessionKey"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitSessionsHistory }, "sessions_history"),
          e("button", { className: "btn", disabled: !authed, onClick: submitSessionSend }, "sessions_send")
        ),
        e("div", { className: "row mt8" },
          e("input", {
            className: "input",
            value: toolSpawnTask,
            onChange: (event) => setToolSpawnTask(event.target.value),
            placeholder: "spawn task"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitSessionSpawn }, "sessions_spawn"),
          e("input", {
            className: "input",
            value: toolSessionMessage,
            onChange: (event) => setToolSessionMessage(event.target.value),
            placeholder: "sessions_send message"
          })
        ),
        e("div", { className: "row mt8" },
          e("input", {
            className: "input",
            value: toolCronJobId,
            onChange: (event) => setToolCronJobId(event.target.value),
            placeholder: "cron jobId"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitCronList }, "cron.list"),
          e("button", { className: "btn", disabled: !authed, onClick: submitCronRun }, "cron.run")
        ),
        e("div", { className: "row mt8" },
          e("input", {
            className: "input",
            value: toolBrowserUrl,
            onChange: (event) => setToolBrowserUrl(event.target.value),
            placeholder: "browser navigate URL"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitBrowserNavigate }, "browser.navigate"),
          e("input", {
            className: "input",
            value: toolCanvasTarget,
            onChange: (event) => setToolCanvasTarget(event.target.value),
            placeholder: "canvas target"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitCanvasPresent }, "canvas.present")
        ),
        e("div", { className: "row mt8" },
          e("input", {
            className: "input",
            value: toolNodesNode,
            onChange: (event) => setToolNodesNode(event.target.value),
            placeholder: "nodes node (optional)"
          }),
          e("input", {
            className: "input",
            value: toolNodesRequestId,
            onChange: (event) => setToolNodesRequestId(event.target.value),
            placeholder: "nodes requestId (optional)"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitNodesPending }, "nodes.pending")
        ),
        e("div", { className: "row mt8" },
          e("input", {
            className: "input",
            value: toolNodesInvokeCommand,
            onChange: (event) => setToolNodesInvokeCommand(event.target.value),
            placeholder: "nodes invokeCommand"
          }),
          e("input", {
            className: "input",
            value: toolNodesInvokeParamsJson,
            onChange: (event) => setToolNodesInvokeParamsJson(event.target.value),
            placeholder: "nodes invoke params JSON"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitNodesInvoke }, "nodes.invoke")
        ),
        e("div", { className: "row mt8" },
          e("input", {
            className: "input",
            value: toolTelegramStubText,
            onChange: (event) => setToolTelegramStubText(event.target.value),
            placeholder: "telegram stub text (예: /llm status)"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitTelegramStubCommand }, "telegram_stub.command"),
          e("div", { className: "tiny" }, "개발/테스트 전용 우회 경로 (실텔레그램 미사용)")
        ),
        e("div", { className: "row mt8" },
          e("input", {
            className: "input",
            value: toolWebSearchQuery,
            onChange: (event) => setToolWebSearchQuery(event.target.value),
            placeholder: "web_search query"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitWebSearchProbe }, "web_search"),
          e("input", {
            className: "input",
            value: toolWebFetchUrl,
            onChange: (event) => setToolWebFetchUrl(event.target.value),
            placeholder: "web_fetch url"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitWebFetchProbe }, "web_fetch")
        ),
        e("div", { className: "row mt8" },
          e("input", {
            className: "input",
            value: toolMemorySearchQuery,
            onChange: (event) => setToolMemorySearchQuery(event.target.value),
            placeholder: "memory_search query"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitMemorySearchProbe }, "memory_search"),
          e("input", {
            className: "input",
            value: toolMemoryGetPath,
            onChange: (event) => setToolMemoryGetPath(event.target.value),
            placeholder: "memory_get path"
          }),
          e("button", { className: "btn", disabled: !authed, onClick: submitMemoryGetProbe }, "memory_get")
        ),
        e("div", { className: "row mt8" },
          e("div", { className: "monitor-title" }, "선택한 도구 응답(JSON)"),
          e("button", {
            className: "btn ghost",
            onClick: () => {
              setToolResultItems([]);
              setProviderRuntimeItems([]);
              setGuardObsItems([]);
              setGuardRetryTimelineItems([]);
              setGuardRetryTimelineApiSnapshot(null);
              setGuardRetryTimelineApiFetchedAt("");
              setGuardRetryTimelineApiError("");
              setToolResultPreview("결과 대기 중");
              setToolResultFilter("all");
              applyDomainFocus("all");
              setSelectedToolResultId("");
              setToolControlError("");
            }
          }, "결과 비우기")
        ),
        e("pre", { className: "screen metrics" }, toolResultPreview),
        e("div", { className: "table-wrap mt8" },
          e("table", { className: "model-table" },
            e("thead", null,
              e("tr", null,
                e("th", null, "시각(UTC)"),
                e("th", null, "도메인"),
                e("th", null, "그룹"),
                e("th", null, "액션"),
                e("th", null, "타입"),
                e("th", null, "상태"),
                e("th", null, "요약")
              )
            ),
            e("tbody", null,
              toolResultItems.length === 0
                ? e("tr", null, e("td", { colSpan: 7 }, "아직 수신된 도구 결과가 없습니다."))
                : (filteredToolResultItems.length === 0
                  ? e("tr", null, e("td", { colSpan: 7 }, "필터 조건에 맞는 결과가 없습니다."))
                  : filteredToolResultItems.map((item) => e(
                  "tr",
                  {
                    key: item.id,
                    className: `tool-result-row ${selectedToolResultId === item.id ? "selected" : ""} ${item.hasError ? "error" : ""}`,
                    onClick: () => {
                      setSelectedToolResultId(item.id);
                      setToolResultPreview(item.preview || "결과 대기 중");
                      if (item.errorText) {
                        setToolControlError(item.errorText);
                      }
                    }
                  },
                  e("td", null, item.capturedAt || "-"),
                  e("td", null, item.domain || "-"),
                  e("td", null, item.group || "-"),
                  e("td", null, item.action || "-"),
                  e("td", null, item.type || "-"),
                  e("td", null, e("span", { className: `tool-status-chip ${item.statusTone || "neutral"}` }, item.statusLabel || "-")),
                  e("td", null,
                    item.summary || "-",
                    item.errorText ? e("div", { className: "tool-error-text" }, item.errorText) : null
                  )
                )))
            )
          )
        )
      );
    }

    function renderSettings() {
      const settingsMobileSections = [
        { key: "auth", label: "인증" },
        { key: "integration", label: "연동" },
        { key: "model", label: "모델" },
        { key: "ops", label: "운영" }
      ];
      const otpPanel = e("section", { className: "panel" },
        e("h2", null, "OTP 인증"),
        e("p", { className: "hint" }, authMeta.telegramConfigured ? "OTP 요청 버튼을 눌렀을 때만 Telegram으로 발송됩니다." : "OTP 요청 버튼을 누르면 서버 콘솔 fallback OTP가 출력됩니다."),
        e("input", {
          className: "input",
          value: otp,
          onChange: (event) => setOtp(event.target.value),
          placeholder: "OTP 6자리",
          maxLength: 6
        }),
        e("div", { className: "row" },
          e("button", {
            className: "btn",
            onClick: () => send({ type: "request_otp" })
          }, "OTP 요청"),
          e("button", {
            className: "btn primary",
            onClick: () => {
              const code = otp.trim();
              if (code.length !== 6) {
                log("OTP 6자리를 입력하세요.", "error");
                return;
              }
              const parsedTtl = parseInt(authTtlHours, 10);
              const ttlHours = Number.isFinite(parsedTtl)
                ? Math.max(1, Math.min(168, parsedTtl))
                : 24;
              setAuthTtlHours(String(ttlHours));
              send({ type: "auth", otp: code, authTtlHours: ttlHours });
            }
          }, "OTP 인증")
        ),
        e("div", { className: "row" },
          e("label", { className: "meta-field" },
            e("span", { className: "meta-label" }, "인증 유지 시간(시간)"),
            e("input", {
              className: "input compact",
              type: "number",
              min: 1,
              max: 168,
              value: authTtlHours,
              onChange: (event) => setAuthTtlHours(event.target.value)
            })
          ),
          e("div", { className: "tiny" }, "범위: 1~168시간 (최대 7일)")
        ),
        e("div", { className: "tiny" }, `Session: ${authMeta.sessionId || "-"}`),
        e("div", { className: "tiny" }, `인증 만료(로컬): ${authExpiry || "-"}`),
        e("div", { className: "tiny" }, `로컬 시간대: ${authLocalOffset || "-"}`)
      );
      const telegramPanel = e("section", { className: "panel" },
        e("h2", null, "Telegram 연동"),
        e("input", {
          className: "input",
          value: telegramBotToken,
          onChange: (event) => setTelegramBotToken(event.target.value),
          placeholder: `Bot Token (${settingsState.telegramBotTokenMasked || "미설정"})`
        }),
        e("input", {
          className: "input",
          value: telegramChatId,
          onChange: (event) => setTelegramChatId(event.target.value),
          placeholder: `Chat ID (${settingsState.telegramChatIdMasked || "미설정"})`
        }),
        e("label", { className: "check" },
          e("input", {
            type: "checkbox",
            checked: persist,
            onChange: (event) => setPersist(event.target.checked)
          }),
          "보안 저장소 저장/삭제"
        ),
        e("div", { className: "row" },
          e("button", {
            className: "btn primary",
            onClick: () => send({
              type: "set_telegram_credentials",
              telegramBotToken: telegramBotToken.trim() || undefined,
              telegramChatId: telegramChatId.trim() || undefined,
              persist
            })
          }, "저장"),
          e("button", { className: "btn", onClick: () => send({ type: "test_telegram" }) }, "테스트 전송"),
          e("button", {
            className: "btn ghost",
            onClick: () => {
              send({ type: "delete_telegram_credentials", persist });
              setTelegramBotToken("");
              setTelegramChatId("");
            }
          }, "연동 삭제")
        )
      );
      const llmPanel = e("section", { className: "panel" },
        e("h2", null, "LLM / Copilot / Codex"),
        e("input", {
          className: "input",
          value: groqApiKey,
          onChange: (event) => setGroqApiKey(event.target.value),
          placeholder: `Groq API Key (${settingsState.groqApiKeyMasked || "미설정"})`
        }),
        e("input", {
          className: "input",
          value: geminiApiKey,
          onChange: (event) => setGeminiApiKey(event.target.value),
          placeholder: `Gemini API Key (${settingsState.geminiApiKeyMasked || "미설정"})`
        }),
        e("input", {
          className: "input",
          value: cerebrasApiKey,
          onChange: (event) => setCerebrasApiKey(event.target.value),
          placeholder: `Cerebras API Key (${settingsState.cerebrasApiKeyMasked || "미설정"})`
        }),
        e("input", {
          className: "input",
          value: codexApiKey,
          onChange: (event) => setCodexApiKey(event.target.value),
          placeholder: `Codex API Key (${settingsState.codexApiKeyMasked || "미설정"})`
        }),
        e("div", { className: "row" },
          e("button", {
            className: "btn primary",
            onClick: () => send({
              type: "set_llm_credentials",
              groqApiKey: groqApiKey.trim() || undefined,
              geminiApiKey: geminiApiKey.trim() || undefined,
              cerebrasApiKey: cerebrasApiKey.trim() || undefined,
              codexApiKey: codexApiKey.trim() || undefined,
              persist
            })
          }, "키 저장"),
          e("button", {
            className: "btn ghost",
            onClick: () => {
              send({ type: "delete_llm_credentials", persist });
              setGroqApiKey("");
              setGeminiApiKey("");
              setCerebrasApiKey("");
              setCodexApiKey("");
            }
          }, "키 삭제"),
          e("button", { className: "btn", onClick: () => send({ type: "get_groq_models" }) }, "Groq 새로고침"),
          e("button", { className: "btn", onClick: () => send({ type: "get_copilot_models" }) }, "Copilot 새로고침")
        ),
        e("div", { className: "meta mt8" }, `Copilot 상태: ${copilotStatus}`),
        e("div", { className: "tiny" }, `상세: ${copilotDetail}`),
        e("div", { className: "row mt8" },
          e("button", { className: "btn", onClick: () => send({ type: "get_copilot_status" }) }, "상태 조회"),
          e("button", { className: "btn", onClick: () => send({ type: "start_copilot_login" }) }, "로그인 시작")
        ),
        e("div", { className: "meta mt8" }, `Codex 상태: ${codexStatus}`),
        e("div", { className: "tiny" }, `상세: ${codexDetail}`),
        e("div", { className: "row mt8" },
          e("button", { className: "btn", onClick: () => send({ type: "get_codex_status" }) }, "상태 조회"),
          e("button", {
            className: "btn",
            onClick: () => {
              setCodexStatus("로그인 시작 중");
              setCodexDetail("브라우저 인증 흐름을 시작하는 중입니다...");
              send({ type: "start_codex_login" });
            }
          }, "OAuth 로그인 시작"),
          e("button", {
            className: "btn ghost",
            onClick: () => {
              setCodexStatus("로그아웃 처리 중");
              setCodexDetail("Codex 인증 정보를 정리하는 중입니다...");
              send({ type: "logout_codex" });
            }
          }, "OAuth 로그아웃")
        )
      );
      const geminiUsagePanel = e("section", { className: "panel" },
        e("h2", null, "Gemini 사용량 / 추정 과금"),
        e("div", { className: "tiny" }, `단가: 입력 $${geminiUsage.input_price_per_million_usd}/1M, 출력 $${geminiUsage.output_price_per_million_usd}/1M`),
        e("div", { className: "meta mt8" }, `요청 수: ${geminiUsage.requests || 0}`),
        e("div", { className: "meta" }, `입력 토큰: ${geminiUsage.prompt_tokens || 0}`),
        e("div", { className: "meta" }, `출력 토큰: ${geminiUsage.completion_tokens || 0}`),
        e("div", { className: "meta" }, `총 토큰: ${geminiUsage.total_tokens || 0}`),
        e("div", { className: "meta" }, `예상 비용: $${geminiUsage.estimated_cost_usd || "0.000000"}`),
        e("button", { className: "btn mt8", onClick: () => send({ type: "get_usage_stats" }) }, "사용량 새로고침")
      );
      const copilotPremiumPanel = e("section", { className: "panel span2 ops-panel" },
        e("h2", null, "GitHub Copilot Premium Requests"),
        e("div", { className: "tiny" }, "주의: 이 값은 GitHub 계정 월누적이며 Omni-node 외 VS Code/Web/기타 Copilot 사용도 합산됩니다."),
        e("div", { className: "meta" }, `사용률: ${copilotPremiumUsage.available ? `${formatDecimal(copilotPremiumUsage.percent_used, 2)}%` : "-"}`),
        e("div", { className: "progress-track mt8" },
          e("div", {
            className: "progress-fill",
            style: { width: `${copilotPremiumPercent}%` }
          })
        ),
        e("div", { className: "meta mt8" }, `사용량: ${copilotPremiumUsage.available ? `${formatDecimal(copilotPremiumUsage.used_requests, 1)} / ${copilotPremiumQuotaText}` : "-"}`),
        e("div", { className: "tiny" }, `계정: ${copilotPremiumUsage.username || "-"} · 플랜: ${copilotPremiumUsage.plan_name || "-"}`),
        e("div", { className: "tiny" }, `갱신(로컬): ${copilotPremiumUsage.refreshed_local || "-"}`),
        !copilotPremiumUsage.available
          ? e("div", { className: "error-banner" }, `Copilot Premium 조회 실패: ${copilotPremiumUsage.message || "조회 실패"}`)
          : null,
        copilotPremiumUsage.requires_user_scope
          ? e("div", { className: "error-banner" }, "권한 필요: gh auth refresh -h github.com -s user")
          : null,
        e("div", { className: "row mt8" },
          e("button", { className: "btn", onClick: () => send({ type: "get_usage_stats" }) }, "Copilot 사용량 새로고침"),
          e("button", {
            className: "btn ghost",
            onClick: () => window.open(copilotPremiumUsage.features_url || "https://github.com/settings/copilot/features", "_blank", "noopener,noreferrer")
          }, "Features 열기"),
          e("button", {
            className: "btn ghost",
            onClick: () => window.open(copilotPremiumUsage.billing_url || "https://github.com/settings/billing/premium_requests_usage", "_blank", "noopener,noreferrer")
          }, "Billing 열기")
        ),
        e("div", { className: "meta mt8" }, `Omni-node 로컬 총 요청: ${copilotLocalUsage.total_requests || 0} req`),
        e("div", { className: "tiny" }, `로컬 선택 모델: ${copilotLocalUsage.selected_model || "-"} (${copilotLocalUsage.selected_model_requests || 0} req)`),
        e("div", { className: "table-wrap" },
          e("table", { className: "model-table" },
            e("thead", null,
              e("tr", null,
                e("th", null, "모델"),
                e("th", null, "사용 횟수"),
                e("th", null, "비율")
              )
            ),
            e("tbody", null, copilotPremiumRows)
          )
        ),
        e("div", { className: "table-wrap mt8" },
          e("table", { className: "model-table" },
            e("thead", null,
              e("tr", null,
                e("th", null, "Omni-node 로컬 모델"),
                e("th", null, "요청 수")
              )
            ),
            e("tbody", null, copilotLocalRows)
          )
        )
      );
      const copilotModelsPanel = e("section", { className: "panel span2 ops-panel" },
        e("h2", null, "Copilot 모델"),
        e("div", { className: "row" },
          e("select", {
            className: "input",
            value: selectedCopilotModel,
            onChange: (event) => setSelectedCopilotModel(event.target.value)
          },
          copilotModels.length === 0
            ? e("option", { value: "" }, "모델 로딩 중")
            : copilotModels.map((x) => e("option", { key: x.id, value: x.id }, x.id))),
          e("button", {
            className: "btn",
            onClick: () => {
              if (!selectedCopilotModel) {
                return;
              }
              send({ type: "set_copilot_model", model: selectedCopilotModel });
            }
          }, "모델 적용"),
          e("button", { className: "btn", onClick: () => send({ type: "get_copilot_models" }) }, "새로고침")
        ),
        e("div", { className: "table-wrap" },
          e("table", { className: "model-table" },
            e("thead", null,
              e("tr", null,
                e("th", null, "모델"),
                e("th", null, "제공사"),
                e("th", null, "Premium 배수"),
                e("th", null, "출력 TPS"),
                e("th", null, "리미트"),
                e("th", null, "컨텍스트"),
                e("th", null, "최대 출력"),
                e("th", null, "사용량")
              )
            ),
            e("tbody", null, copilotRows)
          )
        )
      );
      const groqModelsPanel = e("section", { className: "panel span2 ops-panel" },
        e("h2", null, "Groq 모델 / 제한량 / 사용량"),
        e("div", { className: "row" },
          e("select", {
            className: "input",
            value: selectedGroqModel,
            onChange: (event) => setSelectedGroqModel(event.target.value)
          },
          groqModels.length === 0
            ? e("option", { value: "" }, "모델 로딩 중")
            : groqModels.map((x) => e("option", { key: x.id, value: x.id }, x.id))),
          e("button", {
            className: "btn",
            onClick: () => {
              if (!selectedGroqModel) {
                return;
              }
              send({ type: "set_groq_model", model: selectedGroqModel });
            }
          }, "모델 적용"),
          e("button", { className: "btn", onClick: () => send({ type: "get_groq_models" }) }, "새로고침")
        ),
        e("div", { className: "table-wrap" },
          e("table", { className: "model-table" },
            e("thead", null,
              e("tr", null,
                e("th", null, "모델"),
                e("th", null, "Tier"),
                e("th", null, "출력 TPS"),
                e("th", null, "컨텍스트"),
                e("th", null, "최대 출력"),
                e("th", null, "RPM"),
                e("th", null, "RPD"),
                e("th", null, "TPM"),
                e("th", null, "TPD"),
                e("th", null, "ASH"),
                e("th", null, "ASD"),
                e("th", null, "사용량(분/시/일)"),
                e("th", null, "라이브 잔여/리셋")
              )
            ),
            e("tbody", null, groqRows)
          )
        )
      );
      const consolePanel = e("section", { className: "panel span2 ops-panel" },
        e("h2", null, "운영 콘솔"),
        e("p", { className: "hint" }, "분류(provider/tool/rag) 필터는 도구 통합 패널 카드와 연동됩니다."),
        e("div", { className: "row" },
          e("input", {
            className: "input",
            value: command,
            onChange: (event) => setCommand(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                send({ type: "command", text: command.trim() });
              }
            },
            placeholder: "/metrics, /kill <pid>, /code ..."
          }),
          e("button", { className: "btn primary", disabled: !authed, onClick: () => send({ type: "command", text: command.trim() }) }, "명령 실행"),
          e("button", { className: "btn", disabled: !authed, onClick: () => send({ type: "get_metrics" }) }, "메트릭 조회")
        ),
        e("div", { className: "monitor-grid" },
          e("div", { className: "monitor" },
            e("div", { className: "monitor-title" }, "실시간 메트릭"),
            e("pre", { className: "screen metrics" }, metrics)
          ),
          e("div", { className: "monitor" },
            e("div", { className: "monitor-title" }, "시스템 로그"),
            e("pre", { className: "screen logs" }, logs)
          )
        ),
        e("div", { className: "tool-filter-row mt8" },
          OPS_DOMAIN_FILTERS.map((domainItem) => {
            const stat = opsDomainStats[domainItem.key] || { count: 0, errorCount: 0, lastSummary: "-" };
            return e(
              "button",
              {
                key: domainItem.key,
                type: "button",
                className: `btn tool-filter-btn ${opsDomainFilter === domainItem.key ? "active" : ""}`,
                onClick: () => applyDomainFocus(domainItem.key)
              },
              `${domainItem.label} (${stat.count})`
            );
          })
        ),
        e("div", { className: "table-wrap mt8" },
          e("table", { className: "model-table" },
            e("thead", null,
              e("tr", null,
                e("th", null, "시각(UTC)"),
                e("th", null, "도메인"),
                e("th", null, "소스"),
                e("th", null, "상태"),
                e("th", null, "요약")
              )
            ),
            e("tbody", null,
              filteredOpsFlowItems.length === 0
                ? e("tr", null, e("td", { colSpan: 5 }, "선택한 도메인에 해당하는 운영 이벤트가 없습니다."))
                : filteredOpsFlowItems.slice(0, 12).map((item) => e(
                  "tr",
                  { key: item.id, className: item.hasError ? "tool-result-row error" : "tool-result-row" },
                  e("td", null, item.capturedAt || "-"),
                  e("td", null, item.domain || "-"),
                  e("td", null, item.source || "-"),
                  e("td", null, e("span", { className: `tool-status-chip ${item.statusTone || "neutral"}` }, item.statusLabel || "-")),
                  e("td", null, item.summary || "-")
                ))
            )
          )
        ),
        e("div", { className: "tiny mt8" },
          `전체 ${opsDomainStats.all.count}건 / 오류 ${opsDomainStats.all.errorCount}건 / 최신 ${opsDomainStats.all.lastSummary || "-"}`
        ),
        e("button", {
          className: "btn mt8",
          onClick: () => {
            if (workerRef.current) {
              workerRef.current.postMessage({ type: "clear_logs" });
            }
          }
        }, "로그 비우기")
      );
      const toolPanel = renderToolControlPanel();
      const desktopSettingsGrid = e("div", { className: "settings-grid" },
        otpPanel,
        telegramPanel,
        llmPanel,
        geminiUsagePanel,
        copilotPremiumPanel,
        copilotModelsPanel,
        groqModelsPanel,
        consolePanel,
        toolPanel
      );
      const mobileSettingsStack = e("div", { className: "settings-mobile-shell" },
        renderResponsiveSectionTabs(settingsMobileSections, currentSettingsPane, (paneKey) => setResponsivePane("settings", paneKey), "settings-mobile-tabs"),
        currentSettingsPane === "auth"
          ? e("div", { className: "responsive-panel-stack" }, otpPanel)
          : null,
        currentSettingsPane === "integration"
          ? e("div", { className: "responsive-panel-stack" }, telegramPanel, llmPanel, geminiUsagePanel)
          : null,
        currentSettingsPane === "model"
          ? e("div", { className: "responsive-panel-stack" }, copilotPremiumPanel, copilotModelsPanel, groqModelsPanel)
          : null,
        currentSettingsPane === "ops"
          ? e("div", { className: "responsive-panel-stack" }, consolePanel, toolPanel)
          : null
      );
      return e(
        "section",
        { className: "settings" },
        isPortraitMobileLayout ? mobileSettingsStack : desktopSettingsGrid
      );
    }

    return e(
      "div",
      { className: "app-shell" },
      renderGlobalNav(),
      e(
        "main",
        { className: "main-shell", ref: mainShellRef },
        rootTab === "settings"
          ? renderSettings()
          : rootTab === "routine"
            ? renderRoutine()
            : renderWorkspace()
      ),
      memoryPreview.open
        ? e("div", { className: "modal" },
          e("div", { className: "modal-card" },
            e("div", { className: "modal-head" },
              e("strong", null, memoryPreview.name || "메모리 노트"),
              e("button", {
                className: "btn ghost",
                onClick: () => setMemoryPreview({ open: false, name: "", content: "" })
              }, "닫기")
            ),
            e("pre", { className: "modal-content" }, memoryPreview.content || "")
          )
        )
        : null,
      routineOutputPreview.open
        ? e("div", { className: "modal" },
          e("div", { className: "modal-card" },
            e("div", { className: "modal-head" },
              e("strong", null, routineOutputPreview.title || "실행 출력"),
              e("button", {
                className: "btn ghost",
                onClick: () => setRoutineOutputPreview({ open: false, title: "", content: "", imagePath: "", imageAlt: "" })
              }, "닫기")
            ),
            routineOutputPreview.imagePath
              ? e("div", { className: "routine-output-preview-image-wrap" },
                e("div", { className: "tiny" }, routineOutputPreview.imagePath),
                e("img", {
                  className: "routine-output-preview-image",
                  src: buildRoutineImagePreviewUrl(routineOutputPreview.imagePath),
                  alt: routineOutputPreview.imageAlt || "루틴 스크린샷"
                })
              )
              : null,
            e("pre", { className: "modal-content" }, routineOutputPreview.content || "출력 없음")
          )
        )
        : null
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(e(App));
})();
