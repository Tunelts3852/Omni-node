const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { buildChatMultiRenderSnapshot } = require("./chat-multi-utils.js");

const repoRoot = path.resolve(__dirname, "..");
const middlewareProjectPath = path.resolve(repoRoot, "omninode-middleware", "OmniNode.Middleware.csproj");
const runtimeRoot = path.resolve(repoRoot, ".runtime", "loop81-chat-multi-browser-e2e");
const wsPort = Number.parseInt(process.env.OMNINODE_E2E_WS_PORT || "18881", 10);

function ensureRuntimeLayout() {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "memory-notes"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "code-runs"), { recursive: true });
}

function buildMiddlewareEnv() {
  const disableKeychainRaw = (process.env.OMNINODE_E2E_DISABLE_KEYCHAIN || "").trim().toLowerCase();
  const disableKeychain =
    disableKeychainRaw === "1"
    || disableKeychainRaw === "true"
    || disableKeychainRaw === "yes"
    || disableKeychainRaw === "on";

  const base = {
    ...process.env,
    OMNINODE_WS_PORT: `${wsPort}`,
    OMNINODE_ENABLE_LOCAL_OTP_FALLBACK: "1",
    OMNINODE_DASHBOARD_INDEX: path.resolve(repoRoot, "omninode-dashboard", "index.html"),
    OMNINODE_LLM_USAGE_STATE_PATH: path.join(runtimeRoot, "llm_usage.json"),
    OMNINODE_COPILOT_USAGE_STATE_PATH: path.join(runtimeRoot, "copilot_usage.json"),
    OMNINODE_CONVERSATION_STATE_PATH: path.join(runtimeRoot, "conversations.json"),
    OMNINODE_AUTH_SESSION_STATE_PATH: path.join(runtimeRoot, "auth_sessions.json"),
    OMNINODE_MEMORY_NOTES_DIR: path.join(runtimeRoot, "memory-notes"),
    OMNINODE_CODE_RUNS_DIR: path.join(runtimeRoot, "code-runs"),
    OMNINODE_AUDIT_LOG_PATH: path.join(runtimeRoot, "audit.log"),
    OMNINODE_GATEWAY_HEALTH_STATE_PATH: path.join(runtimeRoot, "gateway_health.json"),
    OMNINODE_GATEWAY_STARTUP_PROBE_STATE_PATH: path.join(runtimeRoot, "gateway_startup_probe.json"),
    OMNINODE_TELEGRAM_TOKEN_KEYCHAIN_SERVICE: "__none__",
    OMNINODE_TELEGRAM_CHAT_ID_KEYCHAIN_SERVICE: "__none__"
  };

  if (disableKeychain) {
    base.OMNINODE_GROQ_KEYCHAIN_SERVICE = "__none__";
    base.OMNINODE_GEMINI_KEYCHAIN_SERVICE = "__none__";
    base.OMNINODE_CEREBRAS_KEYCHAIN_SERVICE = "__none__";
  }

  return base;
}

function consumeLines(bufferState, chunk, sink) {
  bufferState.value += chunk;
  let idx = bufferState.value.indexOf("\n");
  while (idx >= 0) {
    const line = bufferState.value.slice(0, idx).replace(/\r$/, "");
    bufferState.value = bufferState.value.slice(idx + 1);
    if (line) {
      sink.push(line);
    }
    idx = bufferState.value.indexOf("\n");
  }
}

function startMiddleware() {
  const stdoutLines = [];
  const stderrLines = [];
  const proc = spawn(
    "dotnet",
    ["run", "--project", middlewareProjectPath, "--no-build"],
    {
      cwd: repoRoot,
      env: buildMiddlewareEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const stdoutBuffer = { value: "" };
  const stderrBuffer = { value: "" };

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => consumeLines(stdoutBuffer, chunk, stdoutLines));
  proc.stderr.on("data", (chunk) => consumeLines(stderrBuffer, chunk, stderrLines));

  return { proc, stdoutLines, stderrLines };
}

async function waitForCondition(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(message);
}

async function waitForServerReady(ctx) {
  const dashboardLine = await waitForCondition(
    () => ctx.stdoutLines.find((line) => line.includes("[web] dashboard=http://127.0.0.1:")),
    30000,
    "미들웨어 기동 로그를 찾지 못했습니다."
  );

  return dashboardLine;
}

function parseOtpFromLines(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const match = line.match(/\[otp\] local fallback otp=(\d{6}) session=([a-zA-Z0-9\-]+)/);
    if (match) {
      return {
        otp: match[1],
        sessionId: match[2]
      };
    }
  }

  return null;
}

async function stopMiddleware(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) {
    return;
  }

  proc.kill("SIGINT");
  const exitedBySigInt = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (exitedBySigInt) {
    return;
  }

  proc.kill("SIGTERM");
  const exitedBySigTerm = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exitedBySigTerm) {
    proc.kill("SIGKILL");
    await new Promise((resolve) => proc.once("exit", () => resolve()));
  }
}

async function fetchStatus(url) {
  const res = await fetch(url, { method: "GET" });
  return res.status;
}

async function waitForHttpStatus(url, expected, timeoutMs) {
  const start = Date.now();
  let lastStatus = null;

  while (Date.now() - start < timeoutMs) {
    try {
      lastStatus = await fetchStatus(url);
      if (lastStatus === expected) {
        return lastStatus;
      }
    } catch {
      lastStatus = null;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`${url} 상태 코드가 ${expected}가 아닙니다: ${lastStatus ?? "no_response"}`);
}

async function run() {
  ensureRuntimeLayout();
  const middleware = startMiddleware();
  let browser;

  try {
    await waitForServerReady(middleware);

    const baseUrl = `http://127.0.0.1:${wsPort}`;
    const healthz = await waitForHttpStatus(`${baseUrl}/healthz`, 200, 15000);
    const readyz = await fetchStatus(`${baseUrl}/readyz`);
    assert.equal(healthz, 200, `/healthz 상태 코드가 200이 아닙니다: ${healthz}`);
    assert.ok(
      readyz === 200 || readyz === 503,
      `/readyz 상태 코드가 허용 범위를 벗어났습니다(200/503): ${readyz}`
    );

    const wsFrames = [];
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();

    page.on("websocket", (ws) => {
      ws.on("framereceived", (frame) => {
        try {
          const parsed = JSON.parse(frame.payload);
          wsFrames.push(parsed);
        } catch {
        }
      });
    });

    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: "설정" }).click();
    await page.getByRole("button", { name: "OTP 요청" }).click();

    const otpInfo = await waitForCondition(
      () => parseOtpFromLines(middleware.stdoutLines),
      15000,
      "fallback OTP 로그를 찾지 못했습니다."
    );

    await page.locator("input[placeholder='OTP 6자리']").fill(otpInfo.otp);
    await page.getByRole("button", { name: "OTP 인증" }).click();

    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll(".pill")).some((node) =>
        (node.textContent || "").includes("세션 인증됨")
      );
    }, null, { timeout: 15000 });

    await page.getByRole("button", { name: "대화" }).click();
    await page.getByRole("button", { name: "다중 LLM" }).click();

    await page.locator("textarea[placeholder='다중 LLM 비교 질문 입력']").fill("loop-81 dashboard payload-render parity");
    await page.getByRole("button", { name: "전송" }).click();

    const multiPayload = await waitForCondition(
      () => wsFrames.find((msg) => msg && msg.type === "llm_chat_multi_result"),
      30000,
      "llm_chat_multi_result 프레임을 수신하지 못했습니다."
    );

    const expected = buildChatMultiRenderSnapshot(multiPayload);

    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll(".multi-inline-carousel .result-carousel-current-label")).some(
        (node) => `${node.textContent || ""}`.trim().length > 0
      );
    }, null, { timeout: 15000 });

    const actual = await page.evaluate(() => {
      const carousel = Array.from(document.querySelectorAll(".multi-inline-carousel")).find((node) => {
        const title = node.querySelector(".result-carousel-copy strong");
        return (title?.textContent || "").includes("다중 LLM");
      });
      if (!carousel) {
        return null;
      }

      const supportSectionExists = Array.from(document.querySelectorAll("section.coding-result")).some((node) => {
        const title = node.querySelector(".coding-result-head strong");
        return (title?.textContent || "").includes("다중 LLM 상세 결과");
      });

      return {
        title: (carousel.querySelector(".result-carousel-copy strong")?.textContent || "").trim(),
        activeHeading: (carousel.querySelector(".result-carousel-current-label")?.textContent || "").trim(),
        activeBody: carousel.querySelector(".thread-inline-carousel-body")?.textContent || "",
        supportSectionExists
      };
    });

    assert.ok(actual, "메시지 안의 다중 LLM inline 캐러셀을 찾지 못했습니다.");
    assert.equal(actual.title, "다중 LLM", "메시지 안 비교 캐러셀 제목이 예상과 다릅니다.");
    assert.equal(actual.supportSectionExists, false, "별도 다중 LLM 상세 결과 패널이 남아 있으면 안 됩니다.");
    assert.ok(
      expected.entries.some((entry) => entry.heading === actual.activeHeading),
      "활성 모델 heading이 WebSocket payload와 일치하지 않습니다."
    );

    const result = {
      ok: true,
      wsPort,
      healthz,
      readyz,
      conversationId: multiPayload.conversationId,
      requestedSummaryProvider: multiPayload.requestedSummaryProvider,
      resolvedSummaryProvider: multiPayload.resolvedSummaryProvider,
      frameCount: wsFrames.length,
      activeHeading: actual.activeHeading,
      supportSectionExists: actual.supportSectionExists
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (browser) {
      await browser.close();
    }

    await stopMiddleware(middleware.proc);
  }
}

run().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error?.message || String(error)
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
