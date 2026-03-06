(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  root.OmniChatMultiUtils = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function toText(value) {
    if (typeof value === "string") {
      return value;
    }

    if (value === null || value === undefined) {
      return "";
    }

    return `${value}`;
  }

  function toMetaText(value) {
    return toText(value).trim();
  }

  function normalizeChatMultiResultMessage(message) {
    const msg = message && typeof message === "object" ? message : {};
    return {
      groq: toText(msg.groq),
      gemini: toText(msg.gemini),
      cerebras: toText(msg.cerebras),
      copilot: toText(msg.copilot),
      summary: toText(msg.summary),
      groqModel: toMetaText(msg.groqModel),
      geminiModel: toMetaText(msg.geminiModel),
      cerebrasModel: toMetaText(msg.cerebrasModel),
      copilotModel: toMetaText(msg.copilotModel),
      requestedSummaryProvider: toMetaText(msg.requestedSummaryProvider),
      resolvedSummaryProvider: toMetaText(msg.resolvedSummaryProvider)
    };
  }

  function buildProviderLabel(providerName, modelName) {
    const model = toMetaText(modelName);
    return model ? `${providerName} (${model})` : providerName;
  }

  function buildSummaryLabel(requestedProvider, resolvedProvider) {
    const requested = toMetaText(requestedProvider);
    const resolved = toMetaText(resolvedProvider);
    if (!requested && !resolved) {
      return "요약";
    }

    return `요약 (요청=${requested || "-"}, 실제=${resolved || "-"})`;
  }

  function buildChatMultiDisplayLabels(value) {
    const result = normalizeChatMultiResultMessage(value);
    return {
      groqLabel: buildProviderLabel("Groq", result.groqModel),
      geminiLabel: buildProviderLabel("Gemini", result.geminiModel),
      cerebrasLabel: buildProviderLabel("Cerebras", result.cerebrasModel),
      copilotLabel: buildProviderLabel("Copilot", result.copilotModel),
      summaryLabel: buildSummaryLabel(result.requestedSummaryProvider, result.resolvedSummaryProvider)
    };
  }

  function buildChatMultiRenderSnapshot(value) {
    const normalized = normalizeChatMultiResultMessage(value);
    const labels = buildChatMultiDisplayLabels(normalized);
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

  return {
    normalizeChatMultiResultMessage,
    buildChatMultiDisplayLabels,
    buildChatMultiRenderSnapshot
  };
});
