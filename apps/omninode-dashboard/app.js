import {
  CHAT_MODES,
  CODING_LANGUAGES,
  CODING_MODES,
  CODEX_MODEL_CHOICES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_MOBILE_PANES,
  DEFAULT_ROUTINE_AGENT_MODEL,
  DEFAULT_ROUTINE_AGENT_PROVIDER
} from "./modules/dashboard-constants.js";
import {
  buildRoutineImagePreviewUrl,
  buildRoutinePayloadFromForm,
  createRoutineFormState,
  getRoutineLocalTimezone,
  getViewportSnapshot,
  hydrateRoutineFormFromRoutine,
  normalizeRoutineNotifyPolicy,
  normalizeRoutineScheduleSourceMode,
  normalizeRoutineWeekdays
} from "./modules/routine-utils.js";
import {
  createAuthMetaState,
  createCopilotLocalUsageState,
  createCopilotPremiumUsageState,
  createGeminiUsageState,
  createGuardAlertDispatchState,
  createSettingsState
} from "./modules/settings-state.js";
import {
  createChatState,
  createConversationState
} from "./modules/chat-state.js";
import { createCodingState } from "./modules/coding-state.js";
import {
  createRoutineOutputPreviewState,
  createRoutineProgressState,
  createRoutineState
} from "./modules/routine-state.js";
import {
  buildDashboardWsUrl,
  clearPersistedAuthSession,
  flushQueuedPayloads,
  getSavedAuthExpiry,
  getSavedAuthToken,
  persistAuthSession,
  sendWsPayload
} from "./modules/ws-client.js";
import {
  handleConversationMemoryMessage,
  handleExecutionFlowMessage,
  handleRoutineMessage
} from "./modules/dashboard-message-handlers.js";
import {
  renderChatMultiResultPanel,
  renderCodingResultPanel,
  renderComposerInputBar as renderComposerInputBarModule,
  renderResponsiveWorkspaceSupportPane as renderResponsiveWorkspaceSupportPaneModule,
  renderThreadSupportStack as renderThreadSupportStackModule
} from "./modules/dashboard-workspace-renderers.js";
import {
  renderMessagesPanel as renderMessagesPanelModule,
  renderThreadHeader as renderThreadHeaderModule,
  renderThreadInfoPanel as renderThreadInfoPanelModule,
  renderThreadModebar as renderThreadModebarModule
} from "./modules/dashboard-thread-renderers.js";
import {
  renderChatComposerPanel as renderChatComposerPanelModule,
  renderCodingComposerPanel as renderCodingComposerPanelModule
} from "./modules/dashboard-composer-renderers.js";
import {
  renderConversationPanel as renderConversationPanelModule,
  renderMemoryPicker as renderMemoryPickerModule
} from "./modules/dashboard-sidebar-renderers.js";
import { renderRoutineTab as renderRoutineTabModule } from "./modules/dashboard-routine-renderers.js";
import { renderToolControlPanel as renderToolControlPanelModule } from "./modules/dashboard-ops-renderers.js";
import { renderSettingsPanel as renderSettingsPanelModule } from "./modules/dashboard-settings-renderers.js";

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
  const CONVERSATION_STATE_DEFAULTS = createConversationState();
  const CHAT_STATE_DEFAULTS = createChatState({
    noneModel: NONE_MODEL,
    defaultGroqSingleModel: DEFAULT_GROQ_SINGLE_MODEL,
    defaultGroqWorkerModel: DEFAULT_GROQ_WORKER_MODEL,
    defaultGeminiWorkerModel: DEFAULT_GEMINI_WORKER_MODEL,
    defaultCerebrasModel: DEFAULT_CEREBRAS_MODEL
  });
  const CODING_STATE_DEFAULTS = createCodingState({
    noneModel: NONE_MODEL,
    defaultGroqWorkerModel: DEFAULT_GROQ_WORKER_MODEL,
    defaultGeminiWorkerModel: DEFAULT_GEMINI_WORKER_MODEL,
    defaultCerebrasModel: DEFAULT_CEREBRAS_MODEL
  });
  const ROUTINE_STATE_DEFAULTS = createRoutineState({
    defaultMobilePanes: DEFAULT_MOBILE_PANES
  });
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
      const stageText = `${msg.stageTitle || ""}`.trim();
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
        detail: `${stageText ? `stage=${stageText} ` : ""}phase=${msg.phase || "-"} iter=${Number.isFinite(msg.iteration) ? msg.iteration : "-"}`
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
    const [authMeta, setAuthMeta] = useState(() => createAuthMetaState());

    const [settingsState, setSettingsState] = useState(() => createSettingsState());

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

    const [geminiUsage, setGeminiUsage] = useState(() => createGeminiUsageState());
    const [copilotPremiumUsage, setCopilotPremiumUsage] = useState(() => createCopilotPremiumUsageState());
    const [copilotLocalUsage, setCopilotLocalUsage] = useState(() => createCopilotLocalUsageState());

    const [conversationLists, setConversationLists] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.conversationLists }));
    const [activeConversationByKey, setActiveConversationByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.activeConversationByKey }));
    const [conversationDetails, setConversationDetails] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.conversationDetails }));
    const [expandedFoldersByKey, setExpandedFoldersByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.expandedFoldersByKey }));
    const [conversationFilterByKey, setConversationFilterByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.conversationFilterByKey }));
    const [selectionModeByKey, setSelectionModeByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.selectionModeByKey }));
    const [selectedConversationIdsByKey, setSelectedConversationIdsByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.selectedConversationIdsByKey }));
    const [selectedFoldersByKey, setSelectedFoldersByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.selectedFoldersByKey }));
    const [memoryNotes, setMemoryNotes] = useState(() => [...CONVERSATION_STATE_DEFAULTS.memoryNotes]);
    const [selectedMemoryByConversation, setSelectedMemoryByConversation] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.selectedMemoryByConversation }));
    const [metaTitle, setMetaTitle] = useState(CONVERSATION_STATE_DEFAULTS.metaTitle);
    const [metaProject, setMetaProject] = useState(CONVERSATION_STATE_DEFAULTS.metaProject);
    const [metaCategory, setMetaCategory] = useState(CONVERSATION_STATE_DEFAULTS.metaCategory);
    const [metaTags, setMetaTags] = useState(CONVERSATION_STATE_DEFAULTS.metaTags);
    const [codingResultByConversation, setCodingResultByConversation] = useState(() => ({ ...CODING_STATE_DEFAULTS.resultByConversation }));
    const [memoryPreview, setMemoryPreview] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.memoryPreview }));
    const [routineOutputPreview, setRoutineOutputPreview] = useState(() => createRoutineOutputPreviewState());
    const [memoryPickerOpen, setMemoryPickerOpen] = useState(CONVERSATION_STATE_DEFAULTS.memoryPickerOpen);
    const [threadInfoOpenByScope, setThreadInfoOpenByScope] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.threadInfoOpenByScope }));

    const [pendingByKey, setPendingByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.pendingByKey }));
    const [errorByKey, setErrorByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.errorByKey }));
    const [optimisticUserByKey, setOptimisticUserByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.optimisticUserByKey }));
    const [codingProgressByKey, setCodingProgressByKey] = useState(() => ({ ...CODING_STATE_DEFAULTS.progressByKey }));
    const [filePreviewByConversation, setFilePreviewByConversation] = useState(() => ({ ...CODING_STATE_DEFAULTS.filePreviewByConversation }));
    const [showExecutionLogsByConversation, setShowExecutionLogsByConversation] = useState(() => ({ ...CODING_STATE_DEFAULTS.showExecutionLogsByConversation }));
    const [attachmentsByKey, setAttachmentsByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.attachmentsByKey }));
    const [attachmentPanelOpenByKey, setAttachmentPanelOpenByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.attachmentPanelOpenByKey }));
    const [attachmentDragActiveByKey, setAttachmentDragActiveByKey] = useState(() => ({ ...CONVERSATION_STATE_DEFAULTS.attachmentDragActiveByKey }));
    const [clockTick, setClockTick] = useState(Date.now());

    const [chatInputSingle, setChatInputSingle] = useState(CHAT_STATE_DEFAULTS.inputSingle);
    const [chatInputOrch, setChatInputOrch] = useState(CHAT_STATE_DEFAULTS.inputOrch);
    const [chatInputMulti, setChatInputMulti] = useState(CHAT_STATE_DEFAULTS.inputMulti);

    const [chatSingleProvider, setChatSingleProvider] = useState(CHAT_STATE_DEFAULTS.singleProvider);
    const [chatSingleModel, setChatSingleModel] = useState(CHAT_STATE_DEFAULTS.singleModel);
    const [chatOrchProvider, setChatOrchProvider] = useState(CHAT_STATE_DEFAULTS.orchProvider);
    const [chatOrchModel, setChatOrchModel] = useState(CHAT_STATE_DEFAULTS.orchModel);
    const [chatOrchGroqModel, setChatOrchGroqModel] = useState(CHAT_STATE_DEFAULTS.orchGroqModel);
    const [chatOrchGeminiModel, setChatOrchGeminiModel] = useState(CHAT_STATE_DEFAULTS.orchGeminiModel);
    const [chatOrchCerebrasModel, setChatOrchCerebrasModel] = useState(CHAT_STATE_DEFAULTS.orchCerebrasModel);
    const [chatOrchCopilotModel, setChatOrchCopilotModel] = useState(CHAT_STATE_DEFAULTS.orchCopilotModel);
    const [chatOrchCodexModel, setChatOrchCodexModel] = useState(CHAT_STATE_DEFAULTS.orchCodexModel);
    const [chatMultiGroqModel, setChatMultiGroqModel] = useState(CHAT_STATE_DEFAULTS.multiGroqModel);
    const [chatMultiGeminiModel, setChatMultiGeminiModel] = useState(CHAT_STATE_DEFAULTS.multiGeminiModel);
    const [chatMultiCerebrasModel, setChatMultiCerebrasModel] = useState(CHAT_STATE_DEFAULTS.multiCerebrasModel);
    const [chatMultiCopilotModel, setChatMultiCopilotModel] = useState(CHAT_STATE_DEFAULTS.multiCopilotModel);
    const [chatMultiCodexModel, setChatMultiCodexModel] = useState(CHAT_STATE_DEFAULTS.multiCodexModel);
    const [chatMultiSummaryProvider, setChatMultiSummaryProvider] = useState(CHAT_STATE_DEFAULTS.multiSummaryProvider);
    const [chatMultiResultByConversation, setChatMultiResultByConversation] = useState(() => ({ ...CHAT_STATE_DEFAULTS.multiResultByConversation }));

    const [codingInputSingle, setCodingInputSingle] = useState(CODING_STATE_DEFAULTS.inputSingle);
    const [codingInputOrch, setCodingInputOrch] = useState(CODING_STATE_DEFAULTS.inputOrch);
    const [codingInputMulti, setCodingInputMulti] = useState(CODING_STATE_DEFAULTS.inputMulti);

    const [codingSingleProvider, setCodingSingleProvider] = useState(CODING_STATE_DEFAULTS.singleProvider);
    const [codingSingleModel, setCodingSingleModel] = useState(CODING_STATE_DEFAULTS.singleModel);
    const [codingSingleLanguage, setCodingSingleLanguage] = useState(CODING_STATE_DEFAULTS.singleLanguage);

    const [codingOrchProvider, setCodingOrchProvider] = useState(CODING_STATE_DEFAULTS.orchProvider);
    const [codingOrchModel, setCodingOrchModel] = useState(CODING_STATE_DEFAULTS.orchModel);
    const [codingOrchLanguage, setCodingOrchLanguage] = useState(CODING_STATE_DEFAULTS.orchLanguage);
    const [codingOrchGroqModel, setCodingOrchGroqModel] = useState(CODING_STATE_DEFAULTS.orchGroqModel);
    const [codingOrchGeminiModel, setCodingOrchGeminiModel] = useState(CODING_STATE_DEFAULTS.orchGeminiModel);
    const [codingOrchCerebrasModel, setCodingOrchCerebrasModel] = useState(CODING_STATE_DEFAULTS.orchCerebrasModel);
    const [codingOrchCopilotModel, setCodingOrchCopilotModel] = useState(CODING_STATE_DEFAULTS.orchCopilotModel);
    const [codingOrchCodexModel, setCodingOrchCodexModel] = useState(CODING_STATE_DEFAULTS.orchCodexModel);

    const [codingMultiProvider, setCodingMultiProvider] = useState(CODING_STATE_DEFAULTS.multiProvider);
    const [codingMultiModel, setCodingMultiModel] = useState(CODING_STATE_DEFAULTS.multiModel);
    const [codingMultiLanguage, setCodingMultiLanguage] = useState(CODING_STATE_DEFAULTS.multiLanguage);
    const [codingMultiGroqModel, setCodingMultiGroqModel] = useState(CODING_STATE_DEFAULTS.multiGroqModel);
    const [codingMultiGeminiModel, setCodingMultiGeminiModel] = useState(CODING_STATE_DEFAULTS.multiGeminiModel);
    const [codingMultiCerebrasModel, setCodingMultiCerebrasModel] = useState(CODING_STATE_DEFAULTS.multiCerebrasModel);
    const [codingMultiCopilotModel, setCodingMultiCopilotModel] = useState(CODING_STATE_DEFAULTS.multiCopilotModel);
    const [codingMultiCodexModel, setCodingMultiCodexModel] = useState(CODING_STATE_DEFAULTS.multiCodexModel);

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
    const [guardAlertDispatchState, setGuardAlertDispatchState] = useState(() => createGuardAlertDispatchState());
    const [toolResultFilter, setToolResultFilter] = useState("all");
    const [toolDomainFilter, setToolDomainFilter] = useState("all");
    const [opsDomainFilter, setOpsDomainFilter] = useState("all");
    const [selectedToolResultId, setSelectedToolResultId] = useState("");
    const [routines, setRoutines] = useState(() => [...ROUTINE_STATE_DEFAULTS.routines]);
    const [routineCreateForm, setRoutineCreateForm] = useState(() => createRoutineFormState());
    const [routineEditForm, setRoutineEditForm] = useState(() => createRoutineFormState());
    const [routineSelectedId, setRoutineSelectedId] = useState(ROUTINE_STATE_DEFAULTS.routineSelectedId);
    const [routineProgress, setRoutineProgress] = useState(() => createRoutineProgressState(ROUTINE_STATE_DEFAULTS.progress));
    const [groqUsageWindowBaseByModel, setGroqUsageWindowBaseByModel] = useState(() => ({ ...ROUTINE_STATE_DEFAULTS.groqUsageWindowBaseByModel }));
    const [viewportSize, setViewportSize] = useState(() => getViewportSnapshot());
    const [mainShellViewportTop, setMainShellViewportTop] = useState(0);
    const [mobilePaneByTab, setMobilePaneByTab] = useState(() => ({ ...ROUTINE_STATE_DEFAULTS.mobilePaneByTab }));

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

    function clearToolControlResults() {
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

    function selectToolResultItem(item) {
      setSelectedToolResultId(item.id);
      setToolResultPreview(item.preview || "결과 대기 중");
      if (item.errorText) {
        setToolControlError(item.errorText);
      }
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

    function saveAuthToken(token, expiresAtUtc) {
      persistAuthSession(token, expiresAtUtc);
      setAuthExpiry(expiresAtUtc || "");
    }

    function clearAuthToken() {
      clearPersistedAuthSession();
      setAuthExpiry("");
    }

    function log(text, level) {
      if (workerRef.current) {
        workerRef.current.postMessage({ type: "log", payload: text, level: level || "info" });
      }
    }

    function connect() {
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        return;
      }

      const ws = new WebSocket(buildDashboardWsUrl());
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
        flushQueuedPayloads(ws, outboundQueueRef.current);
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
      return sendWsPayload({
        ws: wsRef.current,
        payload,
        outboundQueue: outboundQueueRef.current,
        queueIfClosed: !!options.queueIfClosed,
        silent: !!options.silent,
        hasOpenedSocket: hasOpenedSocketRef.current,
        log
      });
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
            stageKey: "",
            stageTitle: "",
            stageDetail: "",
            stageIndex: 0,
            stageTotal: 0,
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
        log(msg.message || "설정 적용 완료", msg.ok === false ? "error" : "info");
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

      if (handleConversationMemoryMessage(msg, {
        autoCreateConversationRef,
        setSelectedConversationIdsByKey,
        setSelectedFoldersByKey,
        setConversationLists,
        setActiveConversationByKey,
        requestConversationDetail,
        requestAutoCreateConversation,
        setConversationDetails,
        setSelectedMemoryByConversation,
        setChatMultiResultByConversation,
        log,
        setMemoryNotes,
        setMemoryPreview,
        currentConversationId,
        send,
        setError,
        currentKey,
        setFilePreviewByConversation
      })) {
        return;
      }

      if (handleRoutineMessage(msg, {
        setRoutines,
        setRoutineSelectedId,
        setRoutineProgress,
        isPortraitMobileLayout,
        setResponsivePane,
        log,
        setError,
        routineBrowserAgentPreviewRef,
        send,
        setRoutineOutputPreview
      })) {
        return;
      }

      if (handleExecutionFlowMessage(msg, {
        setCodingProgressByKey,
        setPendingByKey,
        setActiveConversationByKey,
        setOptimisticUserByKey,
        normalizeChatMultiResultMessage: chatMultiUtils.normalizeChatMultiResultMessage,
        setChatMultiResultByConversation,
        attachLatencyMetaToConversation,
        setConversationDetails,
        setSelectedMemoryByConversation,
        finishPendingRequest,
        setError,
        setCodingResultByConversation,
        setShowExecutionLogsByConversation,
        setFilePreviewByConversation,
        send,
        log,
        setMetrics
      })) {
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
        const now = Date.now();
        setRoutineProgress(createRoutineProgressState({
          active: true,
          operation: "create",
          percent: 6,
          message: "루틴 생성 요청을 전송했습니다.",
          stageKey: "request_analysis",
          stageTitle: "요청 분석",
          stageDetail: "스케줄과 실행 경로를 확인하고 있습니다.",
          stageIndex: 1,
          stageTotal: 5,
          done: false,
          ok: null,
          startedAt: now,
          updatedAt: now,
          completedAt: 0
        }));
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
        const now = Date.now();
        setRoutineProgress(createRoutineProgressState({
          active: false,
          operation: "create",
          percent: 0,
          message: "오류: WebSocket 연결이 끊어졌습니다.",
          stageKey: "request_analysis",
          stageTitle: "요청 분석",
          stageDetail: "루틴 생성 요청을 보내지 못했습니다.",
          stageIndex: 1,
          stageTotal: 5,
          done: true,
          ok: false,
          startedAt: now,
          updatedAt: now,
          completedAt: now
        }));
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
      return renderConversationPanelModule({
        e,
        currentConversationFilter,
        setConversationFilterByKey,
        currentKey,
        rootTab,
        scope,
        mode,
        currentConversationList,
        groupedConversationList,
        isFolderExpanded,
        currentSelectedFolders,
        selectionMode,
        toggleFolderSelection,
        toggleFolder,
        currentSelectedConversationIds,
        toggleConversationSelection,
        currentConversationId,
        selectConversation,
        toneForCategory,
        buildConversationAvatarText,
        formatConversationUpdatedLabel,
        createConversation,
        metaProject,
        metaCategory,
        parseTags,
        metaTags,
        toggleSelectionMode,
        clearScopeMemory,
        selectedDeleteConversationIds,
        deleteConversation
      });
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
      return renderMemoryPickerModule({
        e,
        currentConversationId,
        send,
        createManualMemoryNote,
        currentCheckedMemoryNotes,
        deleteSelectedMemoryNotes,
        setMemoryPickerOpen,
        memoryNotes,
        currentMemoryNotes,
        toggleMemoryNote,
        renameMemoryNote
      });
    }

    function renderThreadInfoPanel(previewMeta) {
      return renderThreadInfoPanelModule({
        e,
        previewMeta,
        metaTitle,
        setMetaTitle,
        metaProject,
        setMetaProject,
        metaCategory,
        setMetaCategory,
        metaTags,
        setMetaTags,
        toneForCategory,
        currentConversationId,
        saveConversationMeta
      });
    }

    function renderThreadModebar(extraClassName = "") {
      return renderThreadModebarModule({
        e,
        rootTab,
        renderModeTabs,
        extraClassName
      });
    }

    function renderThreadHeader(options = {}) {
      return renderThreadHeaderModule({
        e,
        rootTab,
        currentConversationId,
        currentConversationTitle,
        scope,
        mode,
        currentMemoryNotesCount: currentMemoryNotes.length,
        threadInfoOpen,
        memoryPickerOpen,
        toneForCategory,
        buildThreadPreviewMeta,
        toggleThreadInfoPanel,
        setMemoryPickerOpen,
        isPortraitMobileLayout,
        setResponsivePane,
        responsiveWorkspaceKey,
        renderThreadModebar,
        renderThreadInfoPanel,
        options
      });
    }

    function renderMessages() {
      return renderMessagesPanelModule({
        e,
        MarkdownBubbleText,
        currentKey,
        currentConversationId,
        currentMessages,
        optimisticUserByKey,
        pendingByKey,
        codingProgressByKey,
        isConversationBoundEntryVisible,
        elapsedSeconds,
        sanitizeCodingAssistantText,
        messageListRef
      });
    }

    function renderCodingResult() {
      return renderCodingResultPanel({
        e,
        MarkdownBubbleText,
        rootTab,
        currentConversationId,
        codingResultByConversation,
        filePreviewByConversation,
        showExecutionLogsByConversation,
        sanitizeCodingAssistantText,
        requestWorkspaceFilePreview,
        humanPath,
        setShowExecutionLogsByConversation
      });
    }

    function renderChatMultiResult() {
      return renderChatMultiResultPanel({
        e,
        MarkdownBubbleText,
        rootTab,
        mode,
        currentConversationId,
        chatMultiResultByConversation,
        buildChatMultiRenderSnapshot: chatMultiUtils.buildChatMultiRenderSnapshot
      });
    }

    function renderComposerInputBar({ value, onChange, onSend, pendingKey, placeholder }) {
      return renderComposerInputBarModule({
        e,
        value,
        onChange,
        onSend,
        pending: isRequestPending(pendingKey),
        placeholder,
        attachmentPanelVisible,
        toggleAttachmentPanel,
        autoResizeComposerTextarea,
        onInputKeyDown,
        attachments: currentAttachments,
        attachmentDragActive,
        handleAttachmentDragOver,
        handleAttachmentDrop,
        attachmentFileInputId,
        onAttachmentSelected,
        onClearAttachments: () => setAttachmentsByKey((prev) => ({ ...prev, [currentKey]: [] }))
      });
    }

    function renderThreadSupportStack() {
      return renderThreadSupportStackModule({
        e,
        renderChatMultiResult,
        renderCodingResult,
        memoryPickerOpen,
        renderMemoryPicker
      });
    }

    function renderResponsiveWorkspaceSupportPane() {
      return renderResponsiveWorkspaceSupportPaneModule({
        e,
        currentConversationId,
        renderThreadModebar,
        renderThreadInfoPanel,
        buildThreadPreviewMeta,
        renderMemoryPicker,
        renderChatMultiResult,
        renderCodingResult
      });
    }

    function renderChatComposer() {
      return renderChatComposerPanelModule({
        e,
        mode,
        renderComposerInputBar,
        constants: {
          NONE_MODEL,
          DEFAULT_GROQ_SINGLE_MODEL,
          DEFAULT_CODEX_MODEL,
          DEFAULT_GEMINI_WORKER_MODEL,
          DEFAULT_CEREBRAS_MODEL,
          CEREBRAS_MODEL_CHOICES
        },
        optionSets: {
          groqModelOptions,
          copilotModelOptions,
          codexModelOptions,
          geminiModelOptions,
          groqWorkerModelOptions,
          geminiWorkerModelOptions,
          copilotWorkerModelOptions,
          codexWorkerModelOptions
        },
        selectedModels: {
          selectedGroqModel,
          selectedCopilotModel
        },
        values: {
          chatSingleProvider,
          chatSingleModel,
          chatInputSingle,
          chatOrchProvider,
          chatOrchModel,
          chatInputOrch,
          chatOrchGroqModel,
          chatOrchGeminiModel,
          chatOrchCerebrasModel,
          chatOrchCopilotModel,
          chatOrchCodexModel,
          chatMultiGroqModel,
          chatMultiGeminiModel,
          chatMultiCerebrasModel,
          chatMultiCopilotModel,
          chatMultiCodexModel,
          chatMultiSummaryProvider,
          chatInputMulti
        },
        setters: {
          setChatSingleProvider,
          setChatSingleModel,
          setChatInputSingle,
          setChatOrchProvider,
          setChatOrchModel,
          setChatInputOrch,
          setChatOrchGroqModel,
          setChatOrchGeminiModel,
          setChatOrchCerebrasModel,
          setChatOrchCopilotModel,
          setChatOrchCodexModel,
          setChatMultiGroqModel,
          setChatMultiGeminiModel,
          setChatMultiCerebrasModel,
          setChatMultiCopilotModel,
          setChatMultiCodexModel,
          setChatMultiSummaryProvider,
          setChatInputMulti
        },
        helpers: {
          isNoneModel
        },
        actions: {
          sendChatSingle,
          sendChatOrchestration,
          sendChatMulti
        }
      });
    }

    function renderCodingComposer() {
      return renderCodingComposerPanelModule({
        e,
        mode,
        renderComposerInputBar,
        constants: {
          NONE_MODEL,
          DEFAULT_CODEX_MODEL,
          DEFAULT_GEMINI_WORKER_MODEL,
          DEFAULT_CEREBRAS_MODEL,
          CEREBRAS_MODEL_CHOICES
        },
        optionSets: {
          groqModelOptions,
          copilotModelOptions,
          codexModelOptions,
          geminiModelOptions,
          groqWorkerModelOptions,
          geminiWorkerModelOptions,
          copilotWorkerModelOptions,
          codexWorkerModelOptions
        },
        selectedModels: {
          selectedGroqModel,
          selectedCopilotModel
        },
        values: {
          codingSingleProvider,
          codingSingleModel,
          codingSingleLanguage,
          codingInputSingle,
          codingOrchProvider,
          codingOrchModel,
          codingOrchLanguage,
          codingInputOrch,
          codingOrchGroqModel,
          codingOrchGeminiModel,
          codingOrchCerebrasModel,
          codingOrchCopilotModel,
          codingOrchCodexModel,
          codingMultiProvider,
          codingMultiModel,
          codingMultiLanguage,
          codingInputMulti,
          codingMultiGroqModel,
          codingMultiGeminiModel,
          codingMultiCerebrasModel,
          codingMultiCopilotModel,
          codingMultiCodexModel
        },
        setters: {
          setCodingSingleProvider,
          setCodingSingleModel,
          setCodingSingleLanguage,
          setCodingInputSingle,
          setCodingOrchProvider,
          setCodingOrchModel,
          setCodingOrchLanguage,
          setCodingInputOrch,
          setCodingOrchGroqModel,
          setCodingOrchGeminiModel,
          setCodingOrchCerebrasModel,
          setCodingOrchCopilotModel,
          setCodingOrchCodexModel,
          setCodingMultiProvider,
          setCodingMultiModel,
          setCodingMultiLanguage,
          setCodingInputMulti,
          setCodingMultiGroqModel,
          setCodingMultiGeminiModel,
          setCodingMultiCerebrasModel,
          setCodingMultiCopilotModel,
          setCodingMultiCodexModel
        },
        helpers: {
          isNoneModel
        },
        actions: {
          sendCodingSingle,
          sendCodingOrchestration,
          sendCodingMulti
        }
      });
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

    function renderRoutine() {
      return renderRoutineTabModule({
        e,
        routines,
        routineSelectedId,
        currentRoutinePane,
        isPortraitMobileLayout,
        errorByKey,
        routineCreateForm,
        routineEditForm,
        routineProgress,
        routineAgentProviderOptions,
        routineAgentModelOptions,
        patchRoutineForm,
        toggleRoutineWeekday,
        createRoutineFromUi,
        updateRoutineFromUi,
        onInputKeyDown,
        refreshRoutines,
        setRoutineSelectedId,
        setResponsivePane,
        runRoutineNow,
        testRoutineBrowserAgent,
        testRoutineTelegram,
        setRoutineEnabled,
        deleteRoutineById,
        openRoutineRunDetail,
        resendRoutineRunTelegram,
        setRoutineOutputPreview,
        renderResponsiveSectionTabs
      });
    }

    function renderToolControlPanel() {
      return renderToolControlPanelModule({
        e,
        authed,
        toolControlError,
        opsDomainFilter,
        applyDomainFocus,
        providerHealthSummary,
        toolDomainStats,
        providerRuntimeRows,
        guardObsStats,
        guardAlertSummary,
        formatGuardAlertThreshold,
        guardRetryTimeline,
        guardRetryTimelineRows,
        guardRetryTimelineSource,
        guardRetryTimelineApiFetchedAt,
        guardRetryTimelineApiError,
        guardAlertPipelineFieldRows: GUARD_ALERT_PIPELINE_FIELD_ROWS,
        submitGuardAlertDispatch,
        guardAlertDispatchState,
        guardAlertPipelinePreview,
        toolResultGroups: TOOL_RESULT_GROUPS,
        toolResultStats,
        toolResultFilter,
        setToolResultFilter,
        toolResultFilters: TOOL_RESULT_FILTERS,
        toolDomainFilters: TOOL_DOMAIN_FILTERS,
        toolResultItems,
        submitSessionsList,
        submitCronStatus,
        submitBrowserStatus,
        submitCanvasStatus,
        submitNodesStatus,
        toolSessionKey,
        setToolSessionKey,
        submitSessionsHistory,
        submitSessionSend,
        toolSpawnTask,
        setToolSpawnTask,
        submitSessionSpawn,
        toolSessionMessage,
        setToolSessionMessage,
        toolCronJobId,
        setToolCronJobId,
        submitCronList,
        submitCronRun,
        toolBrowserUrl,
        setToolBrowserUrl,
        submitBrowserNavigate,
        toolCanvasTarget,
        setToolCanvasTarget,
        submitCanvasPresent,
        toolNodesNode,
        setToolNodesNode,
        toolNodesRequestId,
        setToolNodesRequestId,
        submitNodesPending,
        toolNodesInvokeCommand,
        setToolNodesInvokeCommand,
        toolNodesInvokeParamsJson,
        setToolNodesInvokeParamsJson,
        submitNodesInvoke,
        toolTelegramStubText,
        setToolTelegramStubText,
        submitTelegramStubCommand,
        toolWebSearchQuery,
        setToolWebSearchQuery,
        submitWebSearchProbe,
        toolWebFetchUrl,
        setToolWebFetchUrl,
        submitWebFetchProbe,
        toolMemorySearchQuery,
        setToolMemorySearchQuery,
        submitMemorySearchProbe,
        toolMemoryGetPath,
        setToolMemoryGetPath,
        submitMemoryGetProbe,
        clearToolControlResults,
        toolResultPreview,
        filteredToolResultItems,
        selectedToolResultId,
        selectToolResultItem
      });
    }

    function renderSettings() {
      return renderSettingsPanelModule({
        e,
        authMeta,
        otp,
        setOtp,
        authTtlHours,
        setAuthTtlHours,
        log,
        send,
        authExpiry,
        authLocalOffset,
        telegramBotToken,
        setTelegramBotToken,
        telegramChatId,
        setTelegramChatId,
        persist,
        setPersist,
        settingsState,
        groqApiKey,
        setGroqApiKey,
        geminiApiKey,
        setGeminiApiKey,
        cerebrasApiKey,
        setCerebrasApiKey,
        codexApiKey,
        setCodexApiKey,
        copilotStatus,
        copilotDetail,
        codexStatus,
        setCodexStatus,
        codexDetail,
        setCodexDetail,
        geminiUsage,
        copilotPremiumUsage,
        copilotPremiumPercent,
        copilotPremiumQuotaText,
        formatDecimal,
        copilotLocalUsage,
        copilotPremiumRows,
        copilotLocalRows,
        selectedCopilotModel,
        setSelectedCopilotModel,
        copilotModels,
        copilotRows,
        selectedGroqModel,
        setSelectedGroqModel,
        groqModels,
        groqRows,
        command,
        setCommand,
        authed,
        metrics,
        logs,
        opsDomainFilter,
        opsDomainFilters: OPS_DOMAIN_FILTERS,
        opsDomainStats,
        applyDomainFocus,
        filteredOpsFlowItems,
        workerRef,
        toolPanel: renderToolControlPanel(),
        currentSettingsPane,
        renderResponsiveSectionTabs,
        setResponsivePane,
        isPortraitMobileLayout
      });
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
