import { renderDoctorPanel } from "./doctor-renderers.js";
import { renderPlansPanel } from "./plans-renderers.js";
import { renderContextPanel } from "./context-renderers.js";
import { renderRoutingPolicyPanel } from "./routing-policy-renderers.js";
import { renderTaskGraphPanel } from "./task-graph-renderers.js";
import { renderNotebooksPanel } from "./notebooks-renderers.js";

export function renderSettingsPanel(props) {
  const {
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
    doctorState,
    runDoctorReport,
    refreshDoctorReport,
    contextState,
    routingPolicyState,
    plansState,
    taskGraphState,
    notebooksState,
    refreshProjectContext,
    refreshSkillsList,
    refreshCommandsList,
    setRoutingPolicyChain,
    refreshRoutingPolicy,
    saveRoutingPolicy,
    resetRoutingPolicy,
    refreshRoutingDecision,
    setPlanCreateObjective,
    setPlanCreateConstraintsText,
    setPlanCreateMode,
    refreshPlansList,
    loadPlanSnapshot,
    submitPlanCreate,
    reviewPlan,
    approvePlan,
    runPlan,
    setTaskGraphCreatePlanId,
    useSelectedPlanForTaskGraph,
    refreshTaskGraphList,
    loadTaskGraph,
    submitTaskGraphCreate,
    runTaskGraph,
    loadTaskOutput,
    cancelTask,
    setNotebookProjectKey,
    setNotebookAppendKind,
    setNotebookAppendText,
    refreshNotebook,
    appendNotebook,
    createNotebookHandoff,
    appendSelectedPlanDecision,
    appendSelectedTaskVerification,
    appendDoctorVerification,
    appendRefactorVerification,
    opsDomainFilter,
    opsDomainFilters,
    opsDomainStats,
    applyDomainFocus,
    filteredOpsFlowItems,
    workerRef,
    toolPanel,
    currentSettingsPane,
    renderResponsiveSectionTabs,
    setResponsivePane,
    isPortraitMobileLayout
  } = props;

  const settingsMobileSections = [
    { key: "auth", label: "인증" },
    { key: "integration", label: "연동" },
    { key: "model", label: "모델" },
    { key: "context", label: "문맥" },
    { key: "plan", label: "계획" },
    { key: "notes", label: "노트" },
    { key: "ops", label: "운영" }
  ];

  const otpPanel = e("section", { className: "panel" },
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
  );

  const telegramPanel = e("section", { className: "panel" },
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
    e("div", { className: "tiny" }, persist ? "체크된 상태면 macOS는 키체인, Linux는 0600 보안 저장소에 함께 저장됩니다." : "체크 해제 상태면 현재 실행 중인 프로세스에만 반영되고, 재시작하면 사라집니다."),
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
  );

  const llmPanel = e("section", { className: "panel" },
    e("h2", null, "LLM / Copilot / Codex"),
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
    e("input", {
      className: "input",
      value: codexApiKey,
      onChange: (event) => setCodexApiKey(event.target.value),
      placeholder: `Codex API Key (${settingsState.codexApiKeyMasked || "미설정"})`
    }),
    e("div", { className: "row" },
      e("button", {
        className: "btn primary",
        onClick: () => send({
          type: "set_llm_credentials",
          groqApiKey: groqApiKey.trim() || undefined,
          geminiApiKey: geminiApiKey.trim() || undefined,
          cerebrasApiKey: cerebrasApiKey.trim() || undefined,
          codexApiKey: codexApiKey.trim() || undefined,
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
          setCodexApiKey("");
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
    ),
    e("div", { className: "meta mt8" }, `Codex 상태: ${codexStatus}`),
    e("div", { className: "tiny" }, `상세: ${codexDetail}`),
    e("div", { className: "row mt8" },
      e("button", { className: "btn", onClick: () => send({ type: "get_codex_status" }) }, "상태 조회"),
      e("button", {
        className: "btn",
        onClick: () => {
          setCodexStatus("로그인 시작 중");
          setCodexDetail("브라우저 인증 흐름을 시작하는 중입니다...");
          send({ type: "start_codex_login" });
        }
      }, "OAuth 로그인 시작"),
      e("button", {
        className: "btn ghost",
        onClick: () => {
          setCodexStatus("로그아웃 처리 중");
          setCodexDetail("Codex 인증 정보를 정리하는 중입니다...");
          send({ type: "logout_codex" });
        }
      }, "OAuth 로그아웃")
    )
  );

  const geminiUsagePanel = e("section", { className: "panel" },
    e("h2", null, "Gemini 사용량 / 추정 과금"),
    e("div", { className: "tiny" }, `단가: 입력 $${geminiUsage.input_price_per_million_usd}/1M, 출력 $${geminiUsage.output_price_per_million_usd}/1M`),
    e("div", { className: "meta mt8" }, `요청 수: ${geminiUsage.requests || 0}`),
    e("div", { className: "meta" }, `입력 토큰: ${geminiUsage.prompt_tokens || 0}`),
    e("div", { className: "meta" }, `출력 토큰: ${geminiUsage.completion_tokens || 0}`),
    e("div", { className: "meta" }, `총 토큰: ${geminiUsage.total_tokens || 0}`),
    e("div", { className: "meta" }, `예상 비용: $${geminiUsage.estimated_cost_usd || "0.000000"}`),
    e("button", { className: "btn mt8", onClick: () => send({ type: "get_usage_stats" }) }, "사용량 새로고침")
  );

  const copilotPremiumPanel = e("section", { className: "panel span2 ops-panel" },
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
  );

  const copilotModelsPanel = e("section", { className: "panel span2 ops-panel" },
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
  );

  const groqModelsPanel = e("section", { className: "panel span2 ops-panel" },
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
  );

  const consolePanel = e("section", { className: "panel span2 ops-panel" },
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
      opsDomainFilters.map((domainItem) => {
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
  );

  const doctorPanel = renderDoctorPanel({
    e,
    authed,
    doctorState,
    runDoctorReport,
    refreshDoctorReport
  });

  const plansPanel = renderPlansPanel({
    e,
    authed,
    plansState,
    setPlanCreateObjective,
    setPlanCreateConstraintsText,
    setPlanCreateMode,
    refreshPlansList,
    loadPlanSnapshot,
    submitPlanCreate,
    reviewPlan,
    approvePlan,
    runPlan
  });

  const routingPolicyPanel = renderRoutingPolicyPanel({
    e,
    authed,
    routingPolicyState,
    setRoutingPolicyChain,
    refreshRoutingPolicy,
    saveRoutingPolicy,
    resetRoutingPolicy,
    refreshRoutingDecision
  });

  const contextPanel = renderContextPanel({
    e,
    authed,
    contextState,
    refreshProjectContext,
    refreshSkillsList,
    refreshCommandsList
  });

  const taskGraphPanel = renderTaskGraphPanel({
    e,
    authed,
    plansState,
    taskGraphState,
    setTaskGraphCreatePlanId,
    useSelectedPlanForTaskGraph,
    refreshTaskGraphList,
    loadTaskGraph,
    submitTaskGraphCreate,
    runTaskGraph,
    loadTaskOutput,
    cancelTask
  });

  const notebooksPanel = renderNotebooksPanel({
    e,
    authed,
    notebooksState,
    setNotebookProjectKey,
    setNotebookAppendKind,
    setNotebookAppendText,
    refreshNotebook,
    appendNotebook,
    createNotebookHandoff,
    appendSelectedPlanDecision,
    appendSelectedTaskVerification,
    appendDoctorVerification,
    appendRefactorVerification
  });

  const settingsPrimaryGrid = e("div", { className: "settings-primary-grid" },
    otpPanel,
    telegramPanel,
    llmPanel
  );

  const desktopSettingsGrid = e("div", { className: "settings-grid" },
    settingsPrimaryGrid,
    routingPolicyPanel,
    contextPanel,
    plansPanel,
    taskGraphPanel,
    notebooksPanel,
    doctorPanel,
    geminiUsagePanel,
    copilotPremiumPanel,
    copilotModelsPanel,
    groqModelsPanel,
    consolePanel,
    toolPanel
  );

  const mobileSettingsStack = e("div", { className: "settings-mobile-shell" },
    renderResponsiveSectionTabs(settingsMobileSections, currentSettingsPane, (paneKey) => setResponsivePane("settings", paneKey), "settings-mobile-tabs"),
    currentSettingsPane === "auth"
      ? e("div", { className: "responsive-panel-stack" }, otpPanel)
      : null,
    currentSettingsPane === "integration"
      ? e("div", { className: "responsive-panel-stack" }, telegramPanel, llmPanel, geminiUsagePanel)
      : null,
    currentSettingsPane === "model"
      ? e("div", { className: "responsive-panel-stack" }, copilotPremiumPanel, copilotModelsPanel, groqModelsPanel, routingPolicyPanel)
      : null,
    currentSettingsPane === "context"
      ? e("div", { className: "responsive-panel-stack" }, contextPanel)
      : null,
    currentSettingsPane === "plan"
      ? e("div", { className: "responsive-panel-stack" }, plansPanel, taskGraphPanel)
      : null,
    currentSettingsPane === "notes"
      ? e("div", { className: "responsive-panel-stack" }, notebooksPanel)
      : null,
    currentSettingsPane === "ops"
      ? e("div", { className: "responsive-panel-stack" }, doctorPanel, consolePanel, toolPanel)
      : null
  );

  return e(
    "section",
    { className: "settings" },
    isPortraitMobileLayout ? mobileSettingsStack : desktopSettingsGrid
  );
}
