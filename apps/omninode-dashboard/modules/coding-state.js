export function createCodingState(options) {
  const {
    noneModel,
    defaultGroqWorkerModel,
    defaultGeminiWorkerModel,
    defaultCerebrasModel
  } = options;

  return {
    resultByConversation: {},
    progressByKey: {},
    filePreviewByConversation: {},
    runtimeByConversation: {},
    executionInputByConversation: {},
    showExecutionLogsByConversation: {},
    inputSingle: "",
    inputOrch: "",
    inputMulti: "",
    singleProvider: "codex",
    singleModel: "",
    singleLanguage: "auto",
    orchProvider: "auto",
    orchModel: "",
    orchLanguage: "auto",
    orchGroqModel: defaultGroqWorkerModel,
    orchGeminiModel: defaultGeminiWorkerModel,
    orchCerebrasModel: defaultCerebrasModel,
    orchCopilotModel: noneModel,
    orchCodexModel: noneModel,
    multiProvider: "gemini",
    multiModel: "",
    multiLanguage: "auto",
    multiGroqModel: defaultGroqWorkerModel,
    multiGeminiModel: defaultGeminiWorkerModel,
    multiCerebrasModel: defaultCerebrasModel,
    multiCopilotModel: noneModel,
    multiCodexModel: noneModel
  };
}
