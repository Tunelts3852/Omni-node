function renderPaperclipIcon(e) {
  return e(
    "svg",
    { viewBox: "0 0 24 24", className: "icon-svg", "aria-hidden": "true" },
    e("path", {
      d: "M9.5 19.5 17 12a4.5 4.5 0 1 0-6.364-6.364L3.5 12.772a6.5 6.5 0 0 0 9.192 9.192L19 15.656",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.9",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    })
  );
}

function renderSendIcon(e) {
  return e(
    "svg",
    { viewBox: "0 0 24 24", className: "icon-svg", "aria-hidden": "true" },
    e("path", {
      d: "M21 3 10 14",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.9",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }),
    e("path", {
      d: "m21 3-7 18-4-7-7-4 18-7Z",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.9",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    })
  );
}

function renderRichInputControls(props) {
  const {
    e,
    attachments,
    attachmentDragActive,
    handleAttachmentDragOver,
    handleAttachmentDrop,
    attachmentFileInputId,
    onAttachmentSelected,
    onClearAttachments
  } = props;

  return e(
    "div",
    { className: "rich-input messenger-rich-input" },
    e(
      "div",
      {
        className: `rich-input-row compact-attachment-row ${attachmentDragActive ? "drag-active" : ""}`,
        onDragOver: handleAttachmentDragOver,
        onDrop: handleAttachmentDrop
      },
      attachmentDragActive
        ? e("div", { className: "attachment-drop-message" }, "여기에 파일 추가")
        : [
            e("input", {
              key: "file-input",
              id: attachmentFileInputId,
              type: "file",
              className: "file-upload-input",
              onChange: onAttachmentSelected,
              multiple: true,
              tabIndex: -1,
              "aria-hidden": "true",
              accept: "image/*,.pdf,.txt,.md,.json,.csv,.log,.py,.js,.ts,.java,.kt,.c,.cpp,.cs,.html,.css,.sh,.yaml,.yml,.xml"
            }),
            e("label", {
              key: "file-button",
              className: "btn ghost file-upload-label",
              htmlFor: attachmentFileInputId
            }, "파일 추가"),
            attachments.length > 0
              ? e("div", { key: "summary", className: "attachment-compact-summary" }, `첨부 ${attachments.length}개`)
              : e("div", { key: "summary-empty", className: "attachment-compact-summary empty" }, "첨부 없음"),
            attachments.length > 0
              ? e("button", {
                  key: "clear",
                  className: "btn ghost attachment-clear-btn",
                  onClick: onClearAttachments
                }, "비우기")
              : null
          ]
    )
  );
}

export function renderComposerInputBar(props) {
  const {
    e,
    value,
    onChange,
    onSend,
    pending,
    placeholder,
    attachmentPanelVisible,
    toggleAttachmentPanel,
    autoResizeComposerTextarea,
    onInputKeyDown,
    attachments,
    attachmentDragActive,
    handleAttachmentDragOver,
    handleAttachmentDrop,
    attachmentFileInputId,
    onAttachmentSelected,
    onClearAttachments
  } = props;

  return e(
    "div",
    { className: "composer-message-stack" },
    e("div", { className: "composer-input-shell" },
      e("textarea", {
        className: "textarea composer-main-input",
        rows: 1,
        value,
        ref: (node) => autoResizeComposerTextarea(node),
        onInput: (event) => autoResizeComposerTextarea(event.target),
        onChange,
        onKeyDown: (event) => onInputKeyDown(event, onSend),
        placeholder
      }),
      e("div", { className: "composer-side-actions" },
        e("button", {
          type: "button",
          className: `composer-icon-btn attach ${attachmentPanelVisible ? "active" : ""}`,
          title: attachmentPanelVisible ? "첨부 패널 닫기" : "첨부 패널 열기",
          onClick: toggleAttachmentPanel
        }, renderPaperclipIcon(e)),
        e("button", {
          type: "button",
          className: "composer-icon-btn send",
          title: "전송",
          onClick: onSend,
          disabled: pending
        }, renderSendIcon(e))
      )
    ),
    attachmentPanelVisible
      ? renderRichInputControls({
          e,
          attachments,
          attachmentDragActive,
          handleAttachmentDragOver,
          handleAttachmentDrop,
          attachmentFileInputId,
          onAttachmentSelected,
          onClearAttachments
        })
      : null
  );
}

export function renderCodingResultPanel(props) {
  const {
    e,
    MarkdownBubbleText,
    rootTab,
    currentConversationId,
    codingResultByConversation,
    filePreviewByConversation,
    showExecutionLogsByConversation,
    sanitizeCodingAssistantText,
    requestWorkspaceFilePreview,
    humanPath,
    setShowExecutionLogsByConversation
  } = props;

  if (rootTab !== "coding" || !currentConversationId) {
    return null;
  }

  const result = codingResultByConversation[currentConversationId];
  if (!result) {
    return null;
  }

  const changedFiles = Array.isArray(result.changedFiles) ? result.changedFiles.filter(Boolean) : [];
  const preview = filePreviewByConversation[currentConversationId] || null;
  const runDir = result.execution?.runDirectory || "";
  const showExecutionLogs = !!showExecutionLogsByConversation[currentConversationId];
  const safeSummary = sanitizeCodingAssistantText(result.summary || "");

  return e(
    "section",
    { className: "coding-result support-card" },
    e("div", { className: "coding-result-head" },
      e("strong", null, "최근 코딩 결과"),
      e("span", null, `${result.provider || "-"}/${result.model || "-"} · ${result.language || "-"}`)
    ),
    e("div", { className: "coding-result-meta" },
      `status=${result.execution?.status || "-"} · exit=${result.execution?.exitCode ?? "-"} · command=${result.execution?.command || "(none)"}`
    ),
    changedFiles.length > 0
      ? e("div", { className: "coding-files" },
        e("div", { className: "coding-files-head" }, `생성/수정 파일 (${changedFiles.length})`),
        e("div", { className: "coding-files-list" },
          changedFiles.map((pathValue) => {
            const selected = preview?.path === pathValue;
            return e(
              "button",
              {
                key: pathValue,
                className: `file-chip ${selected ? "active" : ""}`,
                onClick: () => requestWorkspaceFilePreview(pathValue, currentConversationId)
              },
              humanPath(pathValue, runDir)
            );
          })
        )
      )
      : e("div", { className: "coding-files empty-line" }, "변경 파일이 감지되지 않았습니다."),
    preview
      ? e("div", { className: "coding-preview" },
        e("div", { className: "coding-preview-head" }, `프리뷰: ${humanPath(preview.path, runDir)}`),
        e("pre", { className: "coding-preview-content" }, preview.content || "")
      )
      : e("div", { className: "coding-preview empty-line" }, "파일을 선택하면 프리뷰를 볼 수 있습니다."),
    e("div", { className: "coding-log-controls" },
      e("button", {
        className: "btn ghost",
        onClick: () => setShowExecutionLogsByConversation((prev) => ({
          ...prev,
          [currentConversationId]: !showExecutionLogs
        }))
      }, showExecutionLogs ? "실행 로그 숨기기" : "실행 로그 보기")
    ),
    showExecutionLogs
      ? e("pre", { className: "coding-output" }, `[stdout]\n${result.execution?.stdout || ""}\n\n[stderr]\n${result.execution?.stderr || ""}`)
      : e("div", { className: "coding-output empty-line" }, "실행 로그는 숨김 상태입니다."),
    safeSummary
      ? e("div", { className: "coding-summary markdown-panel" },
        e(MarkdownBubbleText, { text: safeSummary })
      )
      : null
  );
}

export function renderChatMultiResultPanel(props) {
  const {
    e,
    MarkdownBubbleText,
    rootTab,
    mode,
    currentConversationId,
    chatMultiResultByConversation,
    buildChatMultiRenderSnapshot
  } = props;

  if (rootTab !== "chat" || mode !== "multi" || !currentConversationId) {
    return null;
  }

  const result = chatMultiResultByConversation[currentConversationId];
  if (!result) {
    return null;
  }

  const snapshot = buildChatMultiRenderSnapshot(result);
  const sectionNodes = snapshot.sections.map((section) => e(
    "div",
    { key: `chat-multi-${section.provider}`, className: "coding-preview" },
    e("div", { className: "coding-preview-head" }, section.heading),
    e("div", { className: "coding-preview-content markdown-panel" },
      e(MarkdownBubbleText, { text: section.body })
    )
  ));

  return e(
    "section",
    { className: "coding-result support-card" },
    e("div", { className: "coding-result-head" },
      e("strong", null, "다중 LLM 상세 결과"),
      e("span", null, result.updatedUtc || "-")
    ),
    ...sectionNodes
  );
}

export function renderThreadSupportStack(props) {
  const {
    e,
    renderChatMultiResult,
    renderCodingResult,
    memoryPickerOpen,
    renderMemoryPicker
  } = props;

  const slots = [];
  const multiResult = renderChatMultiResult();
  if (multiResult) {
    slots.push(e("div", { key: "support-multi", className: "thread-support-slot" }, multiResult));
  }

  const codingResult = renderCodingResult();
  if (codingResult) {
    slots.push(e("div", { key: "support-coding", className: "thread-support-slot" }, codingResult));
  }

  if (memoryPickerOpen) {
    slots.push(e("div", { key: "support-memory", className: "thread-support-slot" }, renderMemoryPicker()));
  }

  if (slots.length === 0) {
    return null;
  }

  return e("div", { className: "thread-support-stack" }, slots);
}

export function renderResponsiveWorkspaceSupportPane(props) {
  const {
    e,
    currentConversationId,
    renderThreadModebar,
    renderThreadInfoPanel,
    buildThreadPreviewMeta,
    renderMemoryPicker,
    renderChatMultiResult,
    renderCodingResult
  } = props;

  const blocks = [];
  if (currentConversationId) {
    blocks.push(e("div", { key: "support-modebar", className: "thread-support-slot" }, renderThreadModebar("thread-modebar-support")));
    blocks.push(e("div", { key: "support-info", className: "thread-support-slot" }, renderThreadInfoPanel(buildThreadPreviewMeta())));
    blocks.push(e("div", { key: "support-memory", className: "thread-support-slot" }, renderMemoryPicker()));
  }

  const multiResult = renderChatMultiResult();
  if (multiResult) {
    blocks.push(e("div", { key: "support-multi", className: "thread-support-slot" }, multiResult));
  }

  const codingResult = renderCodingResult();
  if (codingResult) {
    blocks.push(e("div", { key: "support-coding", className: "thread-support-slot" }, codingResult));
  }

  if (blocks.length === 0) {
    return e("div", { className: "thread-support-stack thread-support-stack-mobile" },
      e("div", { className: "support-card responsive-empty-card" }, "이 화면에서는 응답 전략, 정보, 메모리, 실행 결과 같은 보조 요소를 따로 확인합니다.")
    );
  }

  return e("div", { className: "thread-support-stack thread-support-stack-mobile" }, blocks);
}

export function renderRoutineRunHistoryPanel(props) {
  const {
    e,
    routineId,
    runs,
    openRoutineRunDetail,
    resendRoutineRunTelegram
  } = props;

  if (!Array.isArray(runs) || runs.length === 0) {
    return e("div", { className: "empty routine-history-empty" }, "실행 이력이 아직 없습니다.");
  }

  return e("div", { className: "routine-history-list" },
    runs.map((run) => e("article", { key: `${run.ts}-${run.runAtLocal}`, className: "routine-run-item" },
      e("div", { className: "routine-run-head" },
        e("div", { className: "routine-run-main" },
          e("span", { className: `meta-chip ${run.status === "error" ? "error" : run.status === "success" ? "ok" : "neutral"}` }, run.status || "-"),
          e("strong", null, run.runAtLocal || "-")
        ),
        e("div", { className: "routine-run-meta" }, `${run.source || "-"} · ${run.durationText || "-"} · ${Math.max(1, Number(run.attemptCount || 1))}회`)
      ),
      e("div", { className: "routine-run-summary" }, run.summary || "요약 없음"),
      run.error ? e("div", { className: "routine-run-error" }, run.error) : null,
      run.agentProvider || run.agentModel
        ? e("div", { className: "routine-run-next" }, `agent ${run.agentProvider || "-"}:${run.agentModel || "-"}`)
        : null,
      run.finalUrl ? e("div", { className: "routine-run-next" }, `최종 URL ${run.finalUrl}`) : null,
      run.pageTitle ? e("div", { className: "routine-run-next" }, `페이지 ${run.pageTitle}`) : null,
      run.screenshotPath ? e("div", { className: "routine-run-next" }, `스크린샷 ${run.screenshotPath}`) : null,
      run.telegramStatus ? e("div", { className: "routine-run-next" }, `텔레그램 ${run.telegramStatus}`) : null,
      run.nextRunLocal ? e("div", { className: "routine-run-next" }, `다음 실행 ${run.nextRunLocal}`) : null,
      e("div", { className: "routine-run-actions" },
        e("button", {
          type: "button",
          className: "btn",
          onClick: () => openRoutineRunDetail(routineId, run.ts)
        }, "상세"),
        e("button", {
          type: "button",
          className: "btn",
          onClick: () => resendRoutineRunTelegram(routineId, run.ts)
        }, "텔레그램 재전송")
      )
    ))
  );
}
