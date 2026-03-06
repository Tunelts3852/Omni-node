(function () {
  const { useEffect, useMemo, useRef, useState } = React;
  const e = React.createElement;

  const CHAT_MODES = [
    { key: "single", label: "단일 모델" },
    { key: "orchestration", label: "오케스트레이션" },
    { key: "multi", label: "다중 LLM" }
  ];

  const CODING_MODES = [
    { key: "single", label: "단일 코딩" },
    { key: "orchestration", label: "오케스트레이션 코딩" },
    { key: "multi", label: "다중 코딩" }
  ];

  const CODING_LANGUAGES = [
    ["auto", "자동"],
    ["python", "Python"],
    ["javascript", "JavaScript"],
    ["c", "C"],
    ["cpp", "C++"],
    ["csharp", "C#"],
    ["java", "Java"],
    ["kotlin", "Kotlin"],
    ["html", "HTML"],
    ["css", "CSS"],
    ["bash", "Bash"]
  ];
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
  const PROVIDER_RUNTIME_KEYS = ["groq", "gemini", "cerebras", "copilot", "auto", "unknown"];
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
            summary: this._toText(msg && msg.summary),
            groqModel: this._toMetaText(msg && msg.groqModel),
            geminiModel: this._toMetaText(msg && msg.geminiModel),
            cerebrasModel: this._toMetaText(msg && msg.cerebrasModel),
            copilotModel: this._toMetaText(msg && msg.copilotModel),
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
            summaryLabel: result && (result.requestedSummaryProvider || result.resolvedSummaryProvider)
              ? `요약 (요청=${result.requestedSummaryProvider || "-"}, 실제=${result.resolvedSummaryProvider || "-"})`
              : "요약"
          };
        },
        buildChatMultiRenderSnapshot(value) {
          const normalized = this.normalizeChatMultiResultMessage(value);
          const labels = this.buildChatMultiDisplayLabels(normalized);
          return {
            normalized,
            labels,
            sections: [
              { provider: "groq", heading: labels.groqLabel, body: normalized.groq || "-" },
              { provider: "gemini", heading: labels.geminiLabel, body: normalized.gemini || "-" },
              { provider: "cerebras", heading: labels.cerebrasLabel, body: normalized.cerebras || "-" },
              { provider: "copilot", heading: labels.copilotLabel, body: normalized.copilot || "-" },
              { provider: "summary", heading: labels.summaryLabel, body: normalized.summary || "-" }
            ]
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
    const trimmed = `${line ?? ""}`.trim();
    if (trimmed.length < 3) {
      return false;
    }
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      return false;
    }
    return countMatches(trimmed, /\|/g) >= 2;
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
    const trimmed = `${line ?? ""}`.trim();
    if (!trimmed.includes("|")) {
      return false;
    }

    let candidate = trimmed;
    if (!candidate.startsWith("|")) {
      candidate = `|${candidate}`;
    }
    if (!candidate.endsWith("|")) {
      candidate = `${candidate}|`;
    }

    return /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|$/.test(candidate);
  }

  function splitMarkdownTableCells(line) {
    const trimmed = `${line ?? ""}`.trim();
    if (!trimmed) {
      return [];
    }

    let candidate = trimmed;
    if (!candidate.startsWith("|")) {
      candidate = `|${candidate}`;
    }
    if (!candidate.endsWith("|")) {
      candidate = `${candidate}|`;
    }

    return candidate
      .slice(1, -1)
      .split("|")
      .map((cell) => escapeHtml(`${cell ?? ""}`.trim()));
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
        chunks.push(escapeHtml(line));
      }
      i += 1;
    }

    return chunks.join("<br>").replace(/(?:<br>){3,}/g, "<br><br>");
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

    text = normalizeMarkdownTableSeparators(text);
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
      if (/\|\s*[-:]{3,}\s*\|/.test(text) && !/<table[\s>]/i.test(html)) {
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
        { key: "copilot", model: msg.copilotModel, text: msg.copilot }
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
      telegramBotTokenMasked: "",
      telegramChatIdMasked: "",
      groqApiKeyMasked: "",
      geminiApiKeyMasked: "",
      cerebrasApiKeyMasked: ""
    });

    const [telegramBotToken, setTelegramBotToken] = useState("");
    const [telegramChatId, setTelegramChatId] = useState("");
    const [groqApiKey, setGroqApiKey] = useState("");
    const [geminiApiKey, setGeminiApiKey] = useState("");
    const [cerebrasApiKey, setCerebrasApiKey] = useState("");
    const [persist, setPersist] = useState(true);

    const [copilotStatus, setCopilotStatus] = useState("확인 전");
    const [copilotDetail, setCopilotDetail] = useState("-");
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
    const [memoryNotes, setMemoryNotes] = useState([]);
    const [selectedMemoryByConversation, setSelectedMemoryByConversation] = useState({});
    const [metaTitle, setMetaTitle] = useState("");
    const [metaProject, setMetaProject] = useState("기본");
    const [metaCategory, setMetaCategory] = useState("일반");
    const [metaTags, setMetaTags] = useState("");
    const [codingResultByConversation, setCodingResultByConversation] = useState({});
    const [memoryPreview, setMemoryPreview] = useState({ open: false, name: "", content: "" });
    const [memoryPickerOpen, setMemoryPickerOpen] = useState(false);

    const [pendingByKey, setPendingByKey] = useState({});
    const [errorByKey, setErrorByKey] = useState({});
    const [optimisticUserByKey, setOptimisticUserByKey] = useState({});
    const [codingProgressByKey, setCodingProgressByKey] = useState({});
    const [filePreviewByConversation, setFilePreviewByConversation] = useState({});
    const [showExecutionLogsByConversation, setShowExecutionLogsByConversation] = useState({});
    const [attachmentsByKey, setAttachmentsByKey] = useState({});
    const [webUrlsByKey, setWebUrlsByKey] = useState({});
    const [webSearchByKey, setWebSearchByKey] = useState({});
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
    const [chatMultiGroqModel, setChatMultiGroqModel] = useState(DEFAULT_GROQ_WORKER_MODEL);
    const [chatMultiGeminiModel, setChatMultiGeminiModel] = useState(DEFAULT_GEMINI_WORKER_MODEL);
    const [chatMultiCerebrasModel, setChatMultiCerebrasModel] = useState(DEFAULT_CEREBRAS_MODEL);
    const [chatMultiCopilotModel, setChatMultiCopilotModel] = useState(NONE_MODEL);
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

    const [codingMultiProvider, setCodingMultiProvider] = useState("gemini");
    const [codingMultiModel, setCodingMultiModel] = useState("");
    const [codingMultiLanguage, setCodingMultiLanguage] = useState("auto");
    const [codingMultiGroqModel, setCodingMultiGroqModel] = useState(DEFAULT_GROQ_WORKER_MODEL);
    const [codingMultiGeminiModel, setCodingMultiGeminiModel] = useState(DEFAULT_GEMINI_WORKER_MODEL);
    const [codingMultiCerebrasModel, setCodingMultiCerebrasModel] = useState(DEFAULT_CEREBRAS_MODEL);
    const [codingMultiCopilotModel, setCodingMultiCopilotModel] = useState(NONE_MODEL);

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
    const [routineRequestInput, setRoutineRequestInput] = useState("");
    const [routineSelectedId, setRoutineSelectedId] = useState("");
    const [groqUsageWindowBaseByModel, setGroqUsageWindowBaseByModel] = useState({});

    const wsRef = useRef(null);
    const workerRef = useRef(null);
    const reconnectTimerRef = useRef(null);
    const unmountedRef = useRef(false);
    const messageListRef = useRef(null);
    const outboundQueueRef = useRef([]);
    const hasOpenedSocketRef = useRef(false);
    const groqAutoRefreshWindowRef = useRef({ minute: "", hour: "", day: "" });

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
    const currentAttachments = attachmentsByKey[currentKey] || [];
    const currentWebUrlDraft = webUrlsByKey[currentKey] || "";
    const currentWebSearchEnabled = Object.prototype.hasOwnProperty.call(webSearchByKey, currentKey)
      ? !!webSearchByKey[currentKey]
      : true;
    const currentConversationFilter = conversationFilterByKey[currentKey] || "";
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
        }
      ];
    }, [
      copilotStatus,
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
      if (!chatOrchCopilotModel && selectedCopilotModel) {
        setChatOrchCopilotModel(selectedCopilotModel);
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
      if (codingMultiProvider === "copilot" && !codingMultiModel && selectedCopilotModel) {
        setCodingMultiModel(selectedCopilotModel);
      }
    }, [
      selectedCopilotModel,
      chatMultiCopilotModel,
      chatOrchCopilotModel,
      codingSingleProvider,
      codingSingleModel,
      codingOrchProvider,
      codingOrchModel,
      codingOrchCopilotModel,
      codingMultiProvider,
      codingMultiModel
    ]);

    useEffect(() => {
      requestConversations(scope, mode);
    }, [scope, mode]);

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
          startedUtc: new Date(now).toISOString()
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
      send({
        type: "create_conversation",
        scope: targetScope,
        mode: targetMode,
        conversationTitle: title || `${targetScope}-${targetMode}-${new Date().toLocaleTimeString("ko-KR", { hour12: false })}`,
        project: (project || "").trim() || undefined,
        category: (category || "").trim() || undefined,
        tags: Array.isArray(tags) && tags.length > 0 ? tags : undefined
      });
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
      if (!currentConversationId) {
        return;
      }

      send({
        type: "delete_conversation",
        scope,
        mode,
        conversationId: currentConversationId
      });
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

    function selectConversation(item) {
      const key = `${item.scope}:${item.mode}`;
      setActiveConversationByKey((prev) => ({ ...prev, [key]: item.id }));
      requestConversationDetail(item.id);
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
      const rich = getRichInputPayload();
      const effectiveText = text || (rich.attachments.length > 0 ? "첨부 파일을 분석해줘" : "");
      if (!effectiveText) {
        return;
      }

      const model = chatSingleProvider === "groq"
        ? (chatSingleModel || selectedGroqModel || undefined)
        : chatSingleProvider === "copilot"
          ? (chatSingleModel || selectedCopilotModel || undefined)
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
      const rich = getRichInputPayload();
      const effectiveText = text || (rich.attachments.length > 0 ? "첨부 파일을 분석해줘" : "");
      if (!effectiveText) {
        return;
      }

      const model = chatOrchProvider === "groq"
        ? (chatOrchModel || selectedGroqModel || undefined)
        : chatOrchProvider === "copilot"
          ? (chatOrchModel || selectedCopilotModel || undefined)
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
      const rich = getRichInputPayload();
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
      const rich = getRichInputPayload();
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
      const rich = getRichInputPayload();
      const pendingLabel = text || (rich.attachments.length > 0 ? "첨부 파일 반영 코딩" : "(입력 없음) 워커 자동 역할 협의 모드");

      const aggregateModel = codingOrchProvider === "groq"
        ? (codingOrchModel || selectedGroqModel || undefined)
        : codingOrchProvider === "copilot"
          ? (codingOrchModel || selectedCopilotModel || undefined)
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
      const rich = getRichInputPayload();
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
          : (isNoneModel(codingMultiModel) ? undefined : (codingMultiModel || undefined)),
        groqModel: normalizeModelChoice(codingMultiGroqModel, DEFAULT_GROQ_WORKER_MODEL),
        geminiModel: normalizeModelChoice(codingMultiGeminiModel, DEFAULT_GEMINI_WORKER_MODEL),
        cerebrasModel: normalizeModelChoice(codingMultiCerebrasModel, DEFAULT_CEREBRAS_MODEL),
        copilotModel: normalizeModelChoice(codingMultiCopilotModel, NONE_MODEL),
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
          telegramBotTokenMasked: msg.telegramBotTokenMasked || "",
          telegramChatIdMasked: msg.telegramChatIdMasked || "",
          groqApiKeyMasked: msg.groqApiKeyMasked || "",
          geminiApiKeyMasked: msg.geminiApiKeyMasked || "",
          cerebrasApiKeyMasked: msg.cerebrasApiKeyMasked || ""
        });
        return;
      }

      if (msg.type === "settings_result") {
        log(msg.message || "설정 적용 완료");
        send({ type: "get_settings" });
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

          createConversation(msg.scope || "chat", msg.mode || "single");
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
              requestConversations(targetScope, targetMode);
            });
          });
        } else if (refreshScope === "chat" || refreshScope === "coding") {
          ["single", "orchestration", "multi"].forEach((targetMode) => {
            requestConversations(refreshScope, targetMode);
          });
        }

        send({ type: "list_memory_notes" }, { silent: true, queueIfClosed: false });
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
        return;
      }

      if (msg.type === "routine_result") {
        const ok = !!msg.ok;
        const messageText = msg.message || (ok ? "루틴 처리 완료" : "루틴 처리 실패");
        log(messageText, ok ? "info" : "error");
        setError("routine:main", ok ? "" : `오류: ${messageText}`);
        if (msg.routine && msg.routine.id) {
          setRoutineSelectedId(msg.routine.id);
        }
        send({ type: "get_routines" });
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
        setConversationDetails((prev) => ({ ...prev, [conv.id]: conv }));
        setActiveConversationByKey((prev) => {
          if (prev[key]) {
            return prev;
          }
          return { ...prev, [key]: conv.id };
        });
        setSelectedMemoryByConversation((prev) => ({
          ...prev,
          [conv.id]: conv.linkedMemoryNotes || prev[conv.id] || []
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

    function refreshRoutines() {
      send({ type: "get_routines" });
    }

    function createRoutineFromUi() {
      if (!ensureAuthed()) {
        return;
      }

      const text = routineRequestInput.trim();
      if (!text) {
        setError("routine:main", "루틴 요청을 입력하세요.");
        return;
      }

      setError("routine:main", "");
      const ok = send({ type: "create_routine", text });
      if (ok) {
        setRoutineRequestInput("");
      } else {
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

    function getRichInputPayload() {
      return {
        attachments: currentAttachments,
        webUrls: parseWebUrls(currentWebUrlDraft),
        webSearchEnabled: !!currentWebSearchEnabled
      };
    }

    function clearRichInputDraft(key) {
      setAttachmentsByKey((prev) => ({ ...prev, [key]: [] }));
      setWebUrlsByKey((prev) => ({ ...prev, [key]: "" }));
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

    async function onAttachmentSelected(event) {
      const fileList = event.target.files ? Array.from(event.target.files) : [];
      if (fileList.length === 0) {
        return;
      }

      const key = currentKey;
      const existing = attachmentsByKey[key] || [];
      const maxCount = 6;
      const maxBytes = 15 * 1024 * 1024;
      const next = [...existing];
      for (const file of fileList) {
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

      setAttachmentsByKey((prev) => ({ ...prev, [key]: next }));
      event.target.value = "";
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

    const geminiModelOptions = useMemo(() => {
      return GEMINI_MODEL_CHOICES.map((item) =>
        e("option", { key: `gemini-${item.id}`, value: item.id }, item.label)
      );
    }, []);

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
          e("strong", null, `${scope.toUpperCase()} · ${mode}`),
          e("div", { className: "conversation-actions" },
            e("button", {
              className: "btn ghost",
              onClick: () => createConversation(scope, mode, "", metaProject, metaCategory, parseTags(metaTags))
            }, "새 대화"),
            e("button", { className: "btn ghost", disabled: !currentConversationId, onClick: deleteConversation }, "삭제"),
            e("button", { className: "btn ghost", onClick: () => clearScopeMemory(scope) }, "메모리 초기화")
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
              return e(
                "div",
                { key: `group-${group.project}`, className: "conversation-group" },
                e("button", {
                  type: "button",
                  className: `group-title folder-title folder-toggle ${expanded ? "expanded" : ""}`,
                  onClick: () => toggleFolder(currentKey, group.project),
                  "aria-expanded": expanded ? "true" : "false"
                },
                e("span", { className: "folder-chevron" }, "▸"),
                e("span", { className: "folder-badge" }, "폴더"),
                e("span", { className: "folder-name" }, group.project),
                e("span", { className: "folder-count" }, `${group.items.length}`)
                ),
                e("div", { className: `folder-children ${expanded ? "expanded" : "collapsed"}` },
                  expanded
                    ? group.items.map((item) => e(
                      "button",
                      {
                        key: item.id,
                        className: `conversation-item ${currentConversationId === item.id ? "active" : ""}`,
                        onClick: () => selectConversation({ ...item, scope, mode })
                      },
                      e("div", { className: "item-title" }, item.title || "제목 없음"),
                      e("div", { className: "item-preview" }, item.preview || ""),
                      e("div", { className: "item-meta" },
                        e("span", { className: `meta-chip category-${toneForCategory(item.category || "일반")}` }, item.category || "일반"),
                        e("span", { className: "meta-chip neutral" }, `${item.messageCount || 0} msgs`)
                      ),
                      Array.isArray(item.tags) && item.tags.length > 0
                        ? e("div", { className: "item-tags" }, item.tags.slice(0, 3).map((tag) => e("span", { key: `${item.id}-${tag}`, className: "tag-chip" }, `#${tag}`)))
                        : null
                    ))
                    : null
                )
              );
            })
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
        { className: "memory-dock" },
        e("div", { className: "memory-dock-head" },
          e("strong", null, "공유 메모리 노트"),
          e("div", { className: "memory-dock-actions" },
            e("button", { className: "btn ghost", onClick: () => send({ type: "list_memory_notes" }) }, "새로고침"),
            e("button", {
              className: "btn ghost",
              disabled: !currentConversationId,
              onClick: () => createManualMemoryNote(false)
            }, "수동 생성"),
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
                e("button", {
                  className: "link-btn",
                  onClick: (event) => {
                    event.preventDefault();
                    send({ type: "read_memory_note", noteName: note.name });
                  }
                }, "보기")
              );
            })
        )
      );
    }

    function renderChatHeader() {
      const previewTags = parseTags(metaTags).slice(0, 6);
      const previewProject = metaProject.trim() || "기본";
      const previewCategory = metaCategory.trim() || "일반";
      return e(
        "div",
        { className: "chat-header" },
        e("div", { className: "chat-header-text" },
          e("div", { className: "chat-header-title" }, currentConversationTitle),
          e("div", { className: "chat-header-sub" }, `${scope.toUpperCase()} · ${mode} · 연결된 메모리 ${currentMemoryNotes.length}개`)
        ),
        e("div", { className: "chat-header-actions" },
          e("div", { className: "meta-editor" },
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
            e("label", { className: "meta-field wide" },
              e("span", { className: "meta-label" }, "태그"),
              e("input", {
                className: "input compact wide",
                value: metaTags,
                onChange: (event) => setMetaTags(event.target.value),
                placeholder: "예: backend,urgent,release"
              })
            )
          ),
          e("div", { className: "meta-preview-row" },
            e("span", { className: "folder-pill" }, `폴더 · ${previewProject}`),
            e("span", { className: `meta-chip category-${toneForCategory(previewCategory)}` }, previewCategory),
            previewTags.length > 0
              ? previewTags.map((tag) => e("span", { key: `preview-${tag}`, className: "tag-chip" }, `#${tag}`))
              : e("span", { className: "meta-chip neutral" }, "태그 없음")
          ),
          e("div", { className: "header-btn-row" },
            e("button", {
              className: "btn ghost",
              disabled: !currentConversationId,
              onClick: saveConversationMeta
            }, "메타 저장"),
            e("button", {
              className: "btn ghost",
              disabled: !currentConversationId,
              onClick: () => setMemoryPickerOpen((prev) => !prev)
            }, memoryPickerOpen ? "메모리 닫기" : "메모리 열기")
          )
        )
      );
    }

    function renderMessages() {
      const optimisticUserEntry = optimisticUserByKey[currentKey];
      const pendingEntry = pendingByKey[currentKey];
      const progressEntry = codingProgressByKey[currentKey];
      const optimisticUser = isConversationBoundEntryVisible(optimisticUserEntry, currentConversationId) ? optimisticUserEntry : null;
      const progress = isConversationBoundEntryVisible(progressEntry, currentConversationId) ? progressEntry : null;
      const isPendingVisible = isConversationBoundEntryVisible(pendingEntry, currentConversationId) && !!(pendingEntry && pendingEntry.active);
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
            return e(
              "div",
              { key: `${item.createdUtc || index}-${index}`, className: `bubble ${item.role === "user" ? "user" : "assistant"}` },
              item.meta ? e("div", { className: "bubble-meta" }, item.meta) : null,
              e(MarkdownBubbleText, { text: bubbleText })
            );
          }),
        optimisticUser
          ? e(
            "div",
            { className: "bubble user pending-user" },
            e("div", { className: "bubble-meta" }, "사용자 (전송됨)"),
            e(MarkdownBubbleText, { text: optimisticUser.text || "" })
          )
          : null,
        isPendingVisible
          ? e(
            "div",
            { className: "bubble assistant pending-bubble" },
            e("div", { className: "bubble-meta" }, "assistant"),
            e("div", { className: "pending" }, "작성중..."),
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
        { className: "coding-result" },
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
        { className: "coding-result" },
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
        e("div", { className: "toolbar" },
          e("input", {
            className: "input",
            value: currentWebUrlDraft,
            onChange: (event) => setWebUrlsByKey((prev) => ({ ...prev, [currentKey]: event.target.value })),
            placeholder: "참조할 웹 주소 입력 (쉼표/줄바꿈 구분)"
          }),
          e("label", { className: "toggle-inline" },
            e("input", {
              type: "checkbox",
              checked: !!currentWebSearchEnabled,
              onChange: (event) => setWebSearchByKey((prev) => ({ ...prev, [currentKey]: !!event.target.checked }))
            }),
            e("span", null, "URL 웹 참조 사용")
          )
        ),
        e("div", { className: "toolbar" },
          e("label", { className: "btn ghost file-upload-label" },
            "이미지/파일 첨부",
            e("input", {
              type: "file",
              className: "file-upload-input",
              onChange: onAttachmentSelected,
              multiple: true,
              accept: "image/*,.pdf,.txt,.md,.json,.csv,.log,.py,.js,.ts,.java,.kt,.c,.cpp,.cs,.html,.css,.sh,.yaml,.yml,.xml"
            })
          ),
          attachments.length > 0
            ? e("button", { className: "btn ghost", onClick: () => setAttachmentsByKey((prev) => ({ ...prev, [currentKey]: [] })) }, "첨부 비우기")
            : null
        ),
        attachments.length > 0
          ? e("div", { className: "attachment-list" },
            attachments.map((item, index) => e(
              "div",
              { key: `${item.name}-${index}`, className: "attachment-chip" },
              e("span", { className: "attachment-name" }, `${item.name} (${formatBytes(item.sizeBytes)})`),
              e("button", { className: "attachment-remove", onClick: () => removeAttachment(currentKey, index) }, "x")
            ))
          )
          : e("div", { className: "hint" }, "첨부는 최대 6개/파일당 15MB. 멀티모달 모델은 이미지/파일을 해석하고, 미지원 모델은 안내 메시지를 반환합니다.")
      );
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
            e("option", { value: "copilot" }, "Copilot")),
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
          e("textarea", {
            className: "textarea",
            value: chatInputSingle,
            onChange: (event) => setChatInputSingle(event.target.value),
            onKeyDown: (event) => onInputKeyDown(event, sendChatSingle),
            placeholder: "질문 입력"
          }),
          renderRichInputControls(),
          e("button", { className: "btn primary", onClick: sendChatSingle, disabled: isRequestPending("chat:single") }, "전송")
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
            e("option", { value: "copilot" }, "Copilot")),
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
            }, copilotWorkerModelOptions)
          ),
          e("textarea", {
            className: "textarea",
            value: chatInputOrch,
            onChange: (event) => setChatInputOrch(event.target.value),
            onKeyDown: (event) => onInputKeyDown(event, sendChatOrchestration),
            placeholder: "병렬 통합 질문 입력"
          }),
          renderRichInputControls(),
          e("button", { className: "btn primary", onClick: sendChatOrchestration, disabled: isRequestPending("chat:orchestration") }, "전송")
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
            value: chatMultiSummaryProvider,
            onChange: (event) => setChatMultiSummaryProvider(event.target.value)
          },
          e("option", { value: "auto" }, "요약: AUTO"),
          e("option", { value: "gemini" }, "요약: Gemini"),
          e("option", { value: "groq" }, "요약: Groq"),
          e("option", { value: "cerebras" }, "요약: Cerebras"),
          e("option", { value: "copilot" }, "요약: Copilot"))
        ),
        e("textarea", {
          className: "textarea",
          value: chatInputMulti,
          onChange: (event) => setChatInputMulti(event.target.value),
          onKeyDown: (event) => onInputKeyDown(event, sendChatMulti),
          placeholder: "다중 LLM 비교 질문 입력"
        }),
        renderRichInputControls(),
        e("button", { className: "btn primary", onClick: sendChatMulti, disabled: isRequestPending("chat:multi") }, "전송")
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
            e("option", { value: "copilot" }, "Copilot")),
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
          e("textarea", {
            className: "textarea",
            value: codingInputSingle,
            onChange: (event) => setCodingInputSingle(event.target.value),
            onKeyDown: (event) => onInputKeyDown(event, sendCodingSingle),
            placeholder: "요구사항 입력 시 코드 생성/실행"
          }),
          renderRichInputControls(),
          e("button", { className: "btn primary", onClick: sendCodingSingle, disabled: isRequestPending("coding:single") }, "코딩 실행")
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
            e("option", { value: "copilot" }, "집계: Copilot")),
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
            }, copilotWorkerModelOptions)
          ),
          e("textarea", {
            className: "textarea",
            value: codingInputOrch,
            onChange: (event) => setCodingInputOrch(event.target.value),
            onKeyDown: (event) => onInputKeyDown(event, sendCodingOrchestration),
            placeholder: "모델별 역할 분배 병렬 코딩"
          }),
          renderRichInputControls(),
          e("button", { className: "btn primary", onClick: sendCodingOrchestration, disabled: isRequestPending("coding:orchestration") }, "오케스트레이션 실행")
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
          e("option", { value: "copilot" }, "요약: Copilot")),
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
          }, copilotWorkerModelOptions)
        ),
        e("textarea", {
          className: "textarea",
          value: codingInputMulti,
          onChange: (event) => setCodingInputMulti(event.target.value),
          onKeyDown: (event) => onInputKeyDown(event, sendCodingMulti),
          placeholder: "여러 모델별 코드 생성/실행 + 공통점 요약"
        }),
        renderRichInputControls(),
        e("button", { className: "btn primary", onClick: sendCodingMulti, disabled: isRequestPending("coding:multi") }, "다중 실행")
      );
    }

    function renderWorkspace() {
      return e(
        "div",
        { className: "workspace-grid" },
        renderConversationPanel(),
        e(
          "section",
          { className: "chat-panel" },
          renderModeTabs(),
          renderChatHeader(),
          errorByKey[currentKey] ? e("div", { className: "error-banner" }, errorByKey[currentKey]) : null,
          renderMessages(),
          renderChatMultiResult(),
          renderCodingResult(),
          memoryPickerOpen ? renderMemoryPicker() : null,
          rootTab === "chat" ? renderChatComposer() : renderCodingComposer()
        )
      );
    }

    function renderRoutine() {
      const selected = routines.find((item) => item.id === routineSelectedId) || null;
      return e(
        "section",
        { className: "routine-tab" },
        e("div", { className: "routine-layout" },
          e("section", { className: "routine-list-panel" },
            e("div", { className: "routine-head" },
              e("h2", null, "루틴 자동화"),
              e("button", { className: "btn", onClick: refreshRoutines }, "새로고침")
            ),
            e("p", { className: "hint" }, "요청을 입력하면 계획 → 코드 생성 → 저장 → 즉시 1회 실행까지 진행됩니다."),
            errorByKey["routine:main"] ? e("div", { className: "error-banner" }, errorByKey["routine:main"]) : null,
            e("textarea", {
              className: "textarea routine-input",
              value: routineRequestInput,
              onChange: (event) => setRoutineRequestInput(event.target.value),
              onKeyDown: (event) => onInputKeyDown(event, createRoutineFromUi),
              placeholder: "예: 매일 아침 8시에 네이버 뉴스 핵심 기사 요약 정리 해줘"
            }),
            e("button", { className: "btn primary", onClick: createRoutineFromUi }, "루틴 생성"),
            e("div", { className: "routine-list" },
              routines.length === 0
                ? e("div", { className: "empty" }, "등록된 루틴이 없습니다.")
                : routines.map((item) => e(
                  "button",
                  {
                    key: item.id,
                    className: `routine-item ${routineSelectedId === item.id ? "active" : ""}`,
                    onClick: () => setRoutineSelectedId(item.id)
                  },
                  e("div", { className: "routine-item-title" }, item.title || item.id),
                  e("div", { className: "routine-item-meta" },
                    e("span", { className: `meta-chip ${item.enabled ? "ok" : "neutral"}` }, item.enabled ? "ON" : "OFF"),
                    e("span", { className: "meta-chip neutral" }, item.scheduleText || "-")
                  ),
                  e("div", { className: "item-preview" }, item.request || "")
                ))
            )
          ),
          e("section", { className: "routine-detail-panel" },
            !selected
              ? e("div", { className: "empty" }, "루틴을 선택하세요.")
              : e(
                React.Fragment,
                null,
                e("div", { className: "routine-detail-head" },
                  e("strong", null, selected.title || selected.id),
                  e("div", { className: "row" },
                    e("button", { className: "btn primary", onClick: () => runRoutineNow(selected.id) }, "지금 실행"),
                    e("button", { className: "btn", onClick: () => setRoutineEnabled(selected.id, !selected.enabled) }, selected.enabled ? "비활성화" : "활성화"),
                    e("button", { className: "btn ghost", onClick: () => deleteRoutineById(selected.id) }, "삭제")
                  )
                ),
                e("div", { className: "routine-kv" },
                  e("div", null, `ID: ${selected.id}`),
                  e("div", null, `스케줄: ${selected.scheduleText || "-"}`),
                  e("div", null, `다음 실행: ${selected.nextRunLocal || "-"}`),
                  e("div", null, `마지막 실행: ${selected.lastRunLocal || "-"}`),
                  e("div", null, `상태: ${selected.lastStatus || "-"}`),
                  e("div", null, `언어: ${selected.language || "-"}`),
                  e("div", null, `모델: ${selected.coderModel || "-"}`),
                  e("div", null, `스크립트: ${selected.scriptPath || "-"}`)
                ),
                e("div", { className: "routine-subtitle" }, "요청 원문"),
                e("pre", { className: "routine-output" }, selected.request || ""),
                e("div", { className: "routine-subtitle" }, "최근 실행 출력"),
                e("pre", { className: "routine-output" }, selected.lastOutput || "출력 없음")
              )
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
      return e(
        "section",
        { className: "settings" },
        e("div", { className: "settings-grid" },
          e("section", { className: "panel" },
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
          ),

          e("section", { className: "panel" },
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
          ),

          e("section", { className: "panel" },
            e("h2", null, "LLM / Copilot"),
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
            e("div", { className: "row" },
              e("button", {
                className: "btn primary",
                onClick: () => send({
                  type: "set_llm_credentials",
                  groqApiKey: groqApiKey.trim() || undefined,
                  geminiApiKey: geminiApiKey.trim() || undefined,
                  cerebrasApiKey: cerebrasApiKey.trim() || undefined,
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
            )
          ),

          e("section", { className: "panel" },
            e("h2", null, "Gemini 사용량 / 추정 과금"),
            e("div", { className: "tiny" }, `단가: 입력 $${geminiUsage.input_price_per_million_usd}/1M, 출력 $${geminiUsage.output_price_per_million_usd}/1M`),
            e("div", { className: "meta mt8" }, `요청 수: ${geminiUsage.requests || 0}`),
            e("div", { className: "meta" }, `입력 토큰: ${geminiUsage.prompt_tokens || 0}`),
            e("div", { className: "meta" }, `출력 토큰: ${geminiUsage.completion_tokens || 0}`),
            e("div", { className: "meta" }, `총 토큰: ${geminiUsage.total_tokens || 0}`),
            e("div", { className: "meta" }, `예상 비용: $${geminiUsage.estimated_cost_usd || "0.000000"}`),
            e("button", { className: "btn mt8", onClick: () => send({ type: "get_usage_stats" }) }, "사용량 새로고침")
          ),

          e("section", { className: "panel span2 ops-panel" },
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
          ),

          e("section", { className: "panel span2 ops-panel" },
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
          ),

          e("section", { className: "panel span2 ops-panel" },
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
          ),

          e("section", { className: "panel span2 ops-panel" },
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
          ),
          renderToolControlPanel()
        )
      );
    }

    return e(
      "div",
      { className: "app-shell" },
      renderGlobalNav(),
      e(
        "main",
        { className: "main-shell" },
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
        : null
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(e(App));
})();
