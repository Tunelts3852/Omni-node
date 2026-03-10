const CATEGORY_TONES = ["blue", "teal", "green", "amber", "red", "indigo"];

function hashText(value) {
  const text = (value || "").trim();
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function toneForCategory(category) {
  if (!category) {
    return "blue";
  }

  const idx = hashText(category) % CATEGORY_TONES.length;
  return CATEGORY_TONES[idx];
}

export function localUtcOffsetLabel() {
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

export function buildTimeWindowKeys(timestamp) {
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

export function formatDecimal(value, digits) {
  const parsed = Number.parseFloat(`${value ?? ""}`);
  if (!Number.isFinite(parsed)) {
    return "-";
  }
  return parsed.toFixed(digits);
}

export function formatConversationUpdatedLabel(updatedUtc) {
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

export function buildConversationAvatarText(item) {
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

export function attachLatencyMetaToConversation(conversation, msg) {
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
