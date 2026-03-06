const logs = [];
const wsParseErrorState = {
  lastSignature: "",
  lastAtMs: 0,
  suppressedCount: 0
};

function nowString() {
  return new Date().toLocaleTimeString("ko-KR", { hour12: false });
}

function pushLog(text, level = "info") {
  const line = `[${nowString()}] ${level.toUpperCase()} ${text}`;
  logs.push(line);
  if (logs.length > 500) {
    logs.shift();
  }
  postMessage({ type: "logs_updated", payload: logs.join("\n") });
}

self.onmessage = (event) => {
  const data = event.data || {};

  if (data.type === "clear_logs") {
    logs.length = 0;
    postMessage({ type: "logs_updated", payload: "" });
    return;
  }

  if (data.type === "log") {
    pushLog(data.payload || "", data.level || "info");
    return;
  }

  if (data.type === "parse_ws") {
    try {
      const parsed = JSON.parse(data.payload);
      postMessage({ type: "ws_message", payload: parsed });
    } catch {
      const raw = typeof data.payload === "string" ? data.payload : String(data.payload || "");
      const signature = raw.slice(0, 120);
      const nowMs = Date.now();
      const isDuplicate = signature === wsParseErrorState.lastSignature && (nowMs - wsParseErrorState.lastAtMs) < 30000;
      if (isDuplicate) {
        wsParseErrorState.suppressedCount += 1;
        return;
      }

      if (wsParseErrorState.suppressedCount > 0) {
        pushLog(`WS 파싱 경고 ${wsParseErrorState.suppressedCount}건 생략`, "info");
      }

      wsParseErrorState.suppressedCount = 0;
      wsParseErrorState.lastSignature = signature;
      wsParseErrorState.lastAtMs = nowMs;
      const preview = raw.replace(/\s+/g, " ").slice(0, 160);
      pushLog(`WS 파싱 실패(len=${raw.length}) preview=${preview}`, "warn");
    }
  }
};
