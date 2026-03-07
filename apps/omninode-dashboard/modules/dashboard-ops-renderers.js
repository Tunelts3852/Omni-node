export function renderToolControlPanel(props) {
  const {
    e,
    authed,
    toolControlError,
    opsDomainFilter,
    applyDomainFocus,
    providerHealthSummary,
    toolDomainStats,
    providerRuntimeRows,
    guardObsStats,
    guardAlertSummary,
    formatGuardAlertThreshold,
    guardRetryTimeline,
    guardRetryTimelineRows,
    guardRetryTimelineSource,
    guardRetryTimelineApiFetchedAt,
    guardRetryTimelineApiError,
    guardAlertPipelineFieldRows,
    submitGuardAlertDispatch,
    guardAlertDispatchState,
    guardAlertPipelinePreview,
    toolResultGroups,
    toolResultStats,
    toolResultFilter,
    setToolResultFilter,
    toolResultFilters,
    toolDomainFilters,
    toolResultItems,
    submitSessionsList,
    submitCronStatus,
    submitBrowserStatus,
    submitCanvasStatus,
    submitNodesStatus,
    toolSessionKey,
    setToolSessionKey,
    submitSessionsHistory,
    submitSessionSend,
    toolSpawnTask,
    setToolSpawnTask,
    submitSessionSpawn,
    toolSessionMessage,
    setToolSessionMessage,
    toolCronJobId,
    setToolCronJobId,
    submitCronList,
    submitCronRun,
    toolBrowserUrl,
    setToolBrowserUrl,
    submitBrowserNavigate,
    toolCanvasTarget,
    setToolCanvasTarget,
    submitCanvasPresent,
    toolNodesNode,
    setToolNodesNode,
    toolNodesRequestId,
    setToolNodesRequestId,
    submitNodesPending,
    toolNodesInvokeCommand,
    setToolNodesInvokeCommand,
    toolNodesInvokeParamsJson,
    setToolNodesInvokeParamsJson,
    submitNodesInvoke,
    toolTelegramStubText,
    setToolTelegramStubText,
    submitTelegramStubCommand,
    toolWebSearchQuery,
    setToolWebSearchQuery,
    submitWebSearchProbe,
    toolWebFetchUrl,
    setToolWebFetchUrl,
    submitWebFetchProbe,
    toolMemorySearchQuery,
    setToolMemorySearchQuery,
    submitMemorySearchProbe,
    toolMemoryGetPath,
    setToolMemoryGetPath,
    submitMemoryGetProbe,
    clearToolControlResults,
    toolResultPreview,
    filteredToolResultItems,
    selectedToolResultId,
    selectToolResultItem
  } = props;

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
      e("div", { className: "tool-summary-meta" }, `상태 ${providerHealthSummary.lastStatus}`)),
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
    e("div", { className: "hint" },
      `retry 시계열 source=${guardRetryTimelineSource}`,
      guardRetryTimelineSource === "server_api" && guardRetryTimelineApiFetchedAt ? ` · fetchedAt=${guardRetryTimelineApiFetchedAt}` : "",
      guardRetryTimelineSource === "memory_fallback" && guardRetryTimelineApiError ? ` · fallbackReason=${guardRetryTimelineApiError}` : ""
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
          guardAlertPipelineFieldRows.map((field) => e("tr", { key: `guard-alert-schema-${field.path}` },
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
      toolResultGroups.map((group) => {
        const stat = toolResultStats.byGroup[group.key] || { count: 0, errorCount: 0, lastAction: "-", lastStatus: "-" };
        return e("button", {
          key: group.key,
          type: "button",
          className: `tool-summary-card ${toolResultFilter === group.key ? "active" : ""}`,
          onClick: () => setToolResultFilter(group.key)
        },
        e("div", { className: "tool-summary-title" }, group.label),
        e("div", { className: "tool-summary-main" }, `${stat.count}건`),
        e("div", { className: "tool-summary-meta" }, `오류 ${stat.errorCount}건`),
        e("div", { className: "tool-summary-meta" }, `최근 ${stat.lastAction}/${stat.lastStatus}`));
      })
    ),
    e("div", { className: "tool-filter-row mt8" },
      toolResultFilters.map((filterItem) => {
        const count = filterItem.key === "all"
          ? toolResultStats.total
          : (filterItem.key === "errors" ? toolResultStats.errors : ((toolResultStats.byGroup[filterItem.key] || {}).count || 0));
        return e("button", {
          key: filterItem.key,
          type: "button",
          className: `btn tool-filter-btn ${toolResultFilter === filterItem.key ? "active" : ""}`,
          onClick: () => setToolResultFilter(filterItem.key)
        }, `${filterItem.label} (${count})`);
      })
    ),
    e("div", { className: "tool-filter-row mt8" },
      toolDomainFilters.map((domainItem) => {
        const count = domainItem.key === "all" ? toolResultItems.length : ((toolDomainStats[domainItem.key] || {}).count || 0);
        return e("button", {
          key: domainItem.key,
          type: "button",
          className: `btn tool-filter-btn ${opsDomainFilter === domainItem.key ? "active" : ""}`,
          onClick: () => applyDomainFocus(domainItem.key)
        }, `${domainItem.label} (${count})`);
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
      e("button", { className: "btn ghost", onClick: clearToolControlResults }, "결과 비우기")
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
              : filteredToolResultItems.map((item) => e("tr", {
                key: item.id,
                className: `tool-result-row ${selectedToolResultId === item.id ? "selected" : ""} ${item.hasError ? "error" : ""}`,
                onClick: () => selectToolResultItem(item)
              },
              e("td", null, item.capturedAt || "-"),
              e("td", null, item.domain || "-"),
              e("td", null, item.group || "-"),
              e("td", null, item.action || "-"),
              e("td", null, item.type || "-"),
              e("td", null, e("span", { className: `tool-status-chip ${item.statusTone || "neutral"}` }, item.statusLabel || "-")),
              e("td", null, item.summary || "-", item.errorText ? e("div", { className: "tool-error-text" }, item.errorText) : null)
              )))
        )
      )
    )
  );
}
