export function createConversationState() {
  return {
    conversationLists: {},
    activeConversationByKey: {},
    conversationDetails: {},
    expandedFoldersByKey: {},
    conversationFilterByKey: {},
    selectionModeByKey: {},
    selectedConversationIdsByKey: {},
    selectedFoldersByKey: {},
    memoryNotes: [],
    selectedMemoryByConversation: {},
    metaTitle: "",
    metaProject: "기본",
    metaCategory: "일반",
    metaTags: "",
    memoryPreview: { open: false, name: "", content: "" },
    memoryPickerOpen: false,
    threadInfoOpenByScope: { chat: false, coding: false },
    pendingByKey: {},
    errorByKey: {},
    optimisticUserByKey: {},
    attachmentsByKey: {},
    attachmentPanelOpenByKey: {},
    attachmentDragActiveByKey: {}
  };
}

export function createChatState(options) {
  const {
    noneModel,
    defaultGroqSingleModel,
    defaultGroqWorkerModel,
    defaultGeminiWorkerModel,
    defaultCerebrasModel
  } = options;

  return {
    inputSingle: "",
    inputOrch: "",
    inputMulti: "",
    singleProvider: "groq",
    singleModel: defaultGroqSingleModel,
    orchProvider: "auto",
    orchModel: "",
    orchGroqModel: defaultGroqWorkerModel,
    orchGeminiModel: defaultGeminiWorkerModel,
    orchCerebrasModel: defaultCerebrasModel,
    orchCopilotModel: noneModel,
    orchCodexModel: noneModel,
    multiGroqModel: defaultGroqWorkerModel,
    multiGeminiModel: defaultGeminiWorkerModel,
    multiCerebrasModel: defaultCerebrasModel,
    multiCopilotModel: noneModel,
    multiCodexModel: noneModel,
    multiSummaryProvider: "gemini",
    multiResultByConversation: {}
  };
}
