const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeChatMultiResultMessage,
  buildChatMultiDisplayLabels,
  buildChatMultiRenderSnapshot
} = require("./chat-multi-utils.js");

const gatewaySourcePath = path.resolve(__dirname, "../omninode-middleware/src/WebSocketGateway.cs");
const expectedGatewayKeys = [
  "type",
  "conversationId",
  "groq",
  "gemini",
  "cerebras",
  "copilot",
  "summary",
  "groqModel",
  "geminiModel",
  "cerebrasModel",
  "copilotModel",
  "requestedSummaryProvider",
  "resolvedSummaryProvider",
  "conversation",
  "autoMemoryNote"
];

function extractGatewayMultiResultKeys(sourceText) {
  const startToken = "private static string BuildMultiChatResultJson(ConversationMultiResult result)";
  const endToken = "private static string BuildConversationJson";
  const start = sourceText.indexOf(startToken);
  assert.notEqual(start, -1, "WebSocketGateway.cs에서 BuildMultiChatResultJson 함수를 찾을 수 없습니다.");

  const end = sourceText.indexOf(endToken, start);
  assert.notEqual(end, -1, "WebSocketGateway.cs에서 BuildConversationJson 함수를 찾을 수 없습니다.");

  const methodBody = sourceText.slice(start, end);
  const keyRegex = /\\\"([a-zA-Z0-9_]+)\\\":/g;
  const keys = [];
  let match = null;
  while ((match = keyRegex.exec(methodBody)) !== null) {
    keys.push(match[1]);
  }

  return [...new Set(keys)];
}

function assertGatewayContract() {
  const sourceText = fs.readFileSync(gatewaySourcePath, "utf8");
  const keys = extractGatewayMultiResultKeys(sourceText);
  const missingKeys = expectedGatewayKeys.filter((key) => !keys.includes(key));
  assert.equal(missingKeys.length, 0, `llm_chat_multi_result 계약 누락 필드: ${missingKeys.join(", ")}`);
  return {
    keys,
    missingKeys,
    extraKeys: keys.filter((key) => !expectedGatewayKeys.includes(key))
  };
}

function run() {
  const gatewayContract = assertGatewayContract();

  const payload = {
    type: "llm_chat_multi_result",
    conversationId: "conv-001",
    groq: "g",
    gemini: "ge",
    cerebras: "c",
    copilot: "co",
    summary: "sum",
    groqModel: " openai/gpt-oss-120b ",
    geminiModel: " gemini-3-flash-preview ",
    cerebrasModel: " zai-glm-4.7 ",
    copilotModel: " gpt-5 ",
    requestedSummaryProvider: " auto ",
    resolvedSummaryProvider: " gemini ",
    conversation: { id: "conv-001", scope: "chat", mode: "multi", messages: [] },
    autoMemoryNote: null
  };

  const normalized = normalizeChatMultiResultMessage(payload);

  assert.equal(normalized.groqModel, "openai/gpt-oss-120b");
  assert.equal(normalized.geminiModel, "gemini-3-flash-preview");
  assert.equal(normalized.cerebrasModel, "zai-glm-4.7");
  assert.equal(normalized.copilotModel, "gpt-5");
  assert.equal(normalized.requestedSummaryProvider, "auto");
  assert.equal(normalized.resolvedSummaryProvider, "gemini");

  const labels = buildChatMultiDisplayLabels(normalized);
  assert.equal(labels.groqLabel, "Groq (openai/gpt-oss-120b)");
  assert.equal(labels.geminiLabel, "Gemini (gemini-3-flash-preview)");
  assert.equal(labels.cerebrasLabel, "Cerebras (zai-glm-4.7)");
  assert.equal(labels.copilotLabel, "Copilot (gpt-5)");
  assert.equal(labels.summaryLabel, "요약 (요청=auto, 실제=gemini)");

  const snapshot = buildChatMultiRenderSnapshot(payload);
  assert.deepEqual(
    snapshot.sections.map((section) => section.provider),
    ["groq", "gemini", "cerebras", "copilot", "summary"]
  );
  assert.deepEqual(
    snapshot.sections.map((section) => section.heading),
    [
      "Groq (openai/gpt-oss-120b)",
      "Gemini (gemini-3-flash-preview)",
      "Cerebras (zai-glm-4.7)",
      "Copilot (gpt-5)",
      "요약 (요청=auto, 실제=gemini)"
    ]
  );
  assert.deepEqual(
    snapshot.sections.map((section) => section.body),
    ["g", "ge", "c", "co", "sum"]
  );

  const fallbackSnapshot = buildChatMultiRenderSnapshot({});
  assert.deepEqual(
    fallbackSnapshot.sections.map((section) => section.heading),
    ["Groq", "Gemini", "Cerebras", "Copilot", "요약"]
  );
  assert.deepEqual(
    fallbackSnapshot.sections.map((section) => section.body),
    ["-", "-", "-", "-", "-"]
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: 4,
        gatewaySourcePath,
        gatewayKeys: gatewayContract.keys,
        gatewayExtraKeys: gatewayContract.extraKeys,
        summaryLabel: labels.summaryLabel,
        fallbackSummaryLabel: fallbackSnapshot.labels.summaryLabel
      },
      null,
      2
    )
  );
}

run();
