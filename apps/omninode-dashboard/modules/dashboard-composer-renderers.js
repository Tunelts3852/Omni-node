import { CODING_LANGUAGES } from "./dashboard-constants.js";

function renderCerebrasOptions(e, prefix, items) {
  return items.map((item) =>
    e("option", { key: `${prefix}-${item.id}`, value: item.id }, item.label)
  );
}

function renderCerebrasWorkerOptions(e, prefix, noneModel, items) {
  return [
    e("option", { key: `${prefix}-none`, value: noneModel }, "Cerebras: 선택 안함"),
    ...renderCerebrasOptions(e, prefix, items)
  ];
}

function renderLanguageOptions(e) {
  return CODING_LANGUAGES.map((item) => e("option", { key: item[0], value: item[0] }, item[1]));
}

export function renderChatComposerPanel(props) {
  const {
    e,
    mode,
    renderComposerInputBar,
    constants,
    optionSets,
    selectedModels,
    values,
    setters,
    helpers,
    actions
  } = props;

  const {
    NONE_MODEL,
    DEFAULT_GROQ_SINGLE_MODEL,
    DEFAULT_CODEX_MODEL,
    DEFAULT_GEMINI_WORKER_MODEL,
    DEFAULT_CEREBRAS_MODEL,
    CEREBRAS_MODEL_CHOICES
  } = constants;
  const {
    groqModelOptions,
    copilotModelOptions,
    codexModelOptions,
    geminiModelOptions,
    groqWorkerModelOptions,
    geminiWorkerModelOptions,
    copilotWorkerModelOptions,
    codexWorkerModelOptions
  } = optionSets;
  const {
    selectedGroqModel,
    selectedCopilotModel
  } = selectedModels;
  const {
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
  } = values;
  const {
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
  } = setters;
  const { isNoneModel } = helpers;
  const {
    sendChatSingle,
    sendChatOrchestration,
    sendChatMulti
  } = actions;

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
                }, renderCerebrasOptions(e, "chat-single-cerebras", CEREBRAS_MODEL_CHOICES))
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
            }, renderCerebrasOptions(e, "chat-orch-cerebras", CEREBRAS_MODEL_CHOICES))
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
        }, renderCerebrasWorkerOptions(e, "chat-orch-cerebras-worker", NONE_MODEL, CEREBRAS_MODEL_CHOICES)),
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
      }, renderCerebrasWorkerOptions(e, "chat-multi-cerebras-worker", NONE_MODEL, CEREBRAS_MODEL_CHOICES)),
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

export function renderCodingComposerPanel(props) {
  const {
    e,
    mode,
    renderComposerInputBar,
    constants,
    optionSets,
    selectedModels,
    values,
    setters,
    helpers,
    actions
  } = props;

  const {
    NONE_MODEL,
    DEFAULT_CODEX_MODEL,
    DEFAULT_GEMINI_WORKER_MODEL,
    DEFAULT_CEREBRAS_MODEL,
    CEREBRAS_MODEL_CHOICES
  } = constants;
  const {
    groqModelOptions,
    copilotModelOptions,
    codexModelOptions,
    geminiModelOptions,
    groqWorkerModelOptions,
    geminiWorkerModelOptions,
    copilotWorkerModelOptions,
    codexWorkerModelOptions
  } = optionSets;
  const {
    selectedGroqModel,
    selectedCopilotModel
  } = selectedModels;
  const {
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
  } = values;
  const {
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
  } = setters;
  const { isNoneModel } = helpers;
  const {
    sendCodingSingle,
    sendCodingOrchestration,
    sendCodingMulti
  } = actions;

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
                }, renderCerebrasOptions(e, "coding-single-cerebras", CEREBRAS_MODEL_CHOICES))
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
        }, renderLanguageOptions(e))
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
                }, renderCerebrasOptions(e, "coding-orch-cerebras", CEREBRAS_MODEL_CHOICES))
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
        }, renderLanguageOptions(e))
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
        }, renderCerebrasWorkerOptions(e, "coding-orch-cerebras-worker", NONE_MODEL, CEREBRAS_MODEL_CHOICES)),
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
              }, renderCerebrasOptions(e, "coding-multi-cerebras", CEREBRAS_MODEL_CHOICES))
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
      }, renderLanguageOptions(e))
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
      }, renderCerebrasWorkerOptions(e, "coding-multi-cerebras-worker", NONE_MODEL, CEREBRAS_MODEL_CHOICES)),
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
