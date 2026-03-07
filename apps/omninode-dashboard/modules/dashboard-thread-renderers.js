export function renderThreadInfoPanel(props) {
  const {
    e,
    previewMeta,
    metaTitle,
    setMetaTitle,
    metaProject,
    setMetaProject,
    metaCategory,
    setMetaCategory,
    metaTags,
    setMetaTags,
    toneForCategory,
    currentConversationId,
    saveConversationMeta
  } = props;

  const previewTags = previewMeta.previewTags || [];
  const previewProject = previewMeta.previewProject || "기본";
  const previewCategory = previewMeta.previewCategory || "일반";
  return e("div", { className: "thread-info-panel" },
    e("div", { className: "thread-info-grid" },
      e("label", { className: "meta-field" },
        e("span", { className: "meta-label" }, "대화방 이름"),
        e("input", {
          className: "input compact",
          value: metaTitle,
          onChange: (event) => setMetaTitle(event.target.value),
          placeholder: "대화방 이름"
        })
      ),
      e("label", { className: "meta-field" },
        e("span", { className: "meta-label" }, "프로젝트 폴더"),
        e("input", {
          className: "input compact",
          value: metaProject,
          onChange: (event) => setMetaProject(event.target.value),
          placeholder: "예: Omni-node 운영"
        })
      ),
      e("label", { className: "meta-field" },
        e("span", { className: "meta-label" }, "카테고리"),
        e("input", {
          className: "input compact",
          value: metaCategory,
          onChange: (event) => setMetaCategory(event.target.value),
          placeholder: "예: 설계, 버그, 문서"
        })
      ),
      e("label", { className: "meta-field" },
        e("span", { className: "meta-label" }, "태그"),
        e("input", {
          className: "input compact",
          value: metaTags,
          onChange: (event) => setMetaTags(event.target.value),
          placeholder: "예: backend,urgent,release"
        })
      )
    ),
    e("div", { className: "thread-info-footer" },
      e("div", { className: "meta-preview-row" },
        e("span", { className: "folder-pill" }, `폴더 · ${previewProject}`),
        e("span", { className: `meta-chip category-${toneForCategory(previewCategory)}` }, previewCategory),
        previewTags.length > 0
          ? previewTags.map((tag) => e("span", { key: `info-${tag}`, className: "tag-chip" }, `#${tag}`))
          : e("span", { className: "meta-chip neutral" }, "태그 없음")
      ),
      e("button", {
        className: "btn primary thread-save-btn",
        disabled: !currentConversationId,
        onClick: saveConversationMeta
      }, "메타 저장")
    )
  );
}

export function renderThreadModebar(props) {
  const {
    e,
    rootTab,
    renderModeTabs,
    extraClassName = ""
  } = props;

  return e("div", { className: `thread-modebar ${extraClassName}`.trim() },
    e("div", { className: "thread-modebar-copy" },
      e("div", { className: "thread-mode-kicker" }, rootTab === "coding" ? "코딩 워크플로" : "응답 전략"),
      e("div", { className: "thread-mode-hint" }, rootTab === "coding"
        ? "단일 실행부터 오케스트레이션, 다중 코딩까지 한 흐름으로 관리합니다."
        : "단일 답변, 오케스트레이션, 다중 LLM을 대화 흐름 안에서 전환합니다.")
    ),
    renderModeTabs()
  );
}

export function renderThreadHeader(props) {
  const {
    e,
    rootTab,
    currentConversationId,
    currentConversationTitle,
    scope,
    mode,
    currentMemoryNotesCount,
    threadInfoOpen,
    memoryPickerOpen,
    toneForCategory,
    buildThreadPreviewMeta,
    toggleThreadInfoPanel,
    setMemoryPickerOpen,
    isPortraitMobileLayout,
    setResponsivePane,
    responsiveWorkspaceKey,
    renderThreadModebar,
    renderThreadInfoPanel,
    options = {}
  } = props;

  const previewMeta = buildThreadPreviewMeta();
  const previewTags = previewMeta.previewTags;
  const previewProject = previewMeta.previewProject;
  const previewCategory = previewMeta.previewCategory;
  const summaryTokens = [
    previewProject,
    previewCategory,
    `연결된 메모리 ${currentMemoryNotesCount}개`
  ];
  const showInfoPanel = options.showInfoPanel !== false && threadInfoOpen;
  const showActionButtons = options.showActionButtons !== false;
  const showModebar = options.showModebar !== false;
  return e(
    "div",
    { className: "thread-header-shell" },
    e("div", { className: "thread-topbar" },
      e("div", { className: "thread-identity" },
        e("div", { className: `thread-avatar ${rootTab === "coding" ? "coding" : "chat"} ${currentConversationId ? "active" : "idle"}` }, rootTab === "coding" ? "</>" : "AI"),
        e("div", { className: "thread-copy" },
          e("div", { className: "thread-title-row" },
            e("div", { className: "thread-title" }, currentConversationTitle),
            currentConversationId
              ? e("span", { className: `thread-context-badge ${rootTab === "coding" ? "coding" : "chat"}` }, `${scope.toUpperCase()} · ${mode}`)
              : null
          ),
          e("div", { className: "thread-subline" }, summaryTokens.join(" · ")),
          e("div", { className: "thread-chip-row" },
            e("span", { className: "folder-pill" }, `폴더 · ${previewProject}`),
            e("span", { className: `meta-chip category-${toneForCategory(previewCategory)}` }, previewCategory),
            previewTags.length > 0
              ? previewTags.map((tag) => e("span", { key: `preview-${tag}`, className: "tag-chip" }, `#${tag}`))
              : e("span", { className: "meta-chip neutral" }, "태그 없음")
          )
        )
      ),
      showActionButtons
        ? e("div", { className: "thread-actions" },
          e("button", {
            className: `btn ghost thread-action-btn ${threadInfoOpen ? "active" : ""}`,
            disabled: !currentConversationId,
            onClick: toggleThreadInfoPanel
          }, threadInfoOpen ? "정보 닫기" : "정보"),
          e("button", {
            className: "btn ghost thread-action-btn",
            disabled: !currentConversationId,
            onClick: () => {
              const next = !memoryPickerOpen;
              setMemoryPickerOpen(next);
              if (isPortraitMobileLayout && next) {
                setResponsivePane(responsiveWorkspaceKey, "support");
              }
            }
          }, memoryPickerOpen ? "메모리 닫기" : "메모리")
        )
        : null
    ),
    showModebar ? renderThreadModebar() : null,
    showInfoPanel ? renderThreadInfoPanel(previewMeta) : null
  );
}

export function renderMessagesPanel(props) {
  const {
    e,
    MarkdownBubbleText,
    currentKey,
    currentConversationId,
    currentMessages,
    optimisticUserByKey,
    pendingByKey,
    codingProgressByKey,
    isConversationBoundEntryVisible,
    elapsedSeconds,
    sanitizeCodingAssistantText,
    messageListRef
  } = props;

  const optimisticUserEntry = optimisticUserByKey[currentKey];
  const pendingEntry = pendingByKey[currentKey];
  const progressEntry = codingProgressByKey[currentKey];
  const optimisticUser = isConversationBoundEntryVisible(optimisticUserEntry, currentConversationId) ? optimisticUserEntry : null;
  const pending = isConversationBoundEntryVisible(pendingEntry, currentConversationId) ? pendingEntry : null;
  const progress = isConversationBoundEntryVisible(progressEntry, currentConversationId) ? progressEntry : null;
  const isPendingVisible = !!(pending && pending.active);
  const isCodingScope = currentKey.startsWith("coding:");
  const elapsed = elapsedSeconds(progress);
  const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
  return e(
    "div",
    { className: "message-list", ref: messageListRef },
    currentMessages.length === 0 && !optimisticUser
      ? e("div", { className: "empty" }, "대화를 시작하세요.")
      : currentMessages.map((item, index) => {
        const bubbleText = isCodingScope && item.role === "assistant"
          ? sanitizeCodingAssistantText(item.text || "")
          : (item.text || "");
        const isUser = item.role === "user";
        return e(
          "div",
          { key: `${item.createdUtc || index}-${index}`, className: `message-row ${isUser ? "user" : "assistant"}` },
          !isUser
            ? e("div", { className: `message-avatar ${isCodingScope ? "coding" : "assistant"}` }, isCodingScope ? "DEV" : "AI")
            : null,
          e(
            "div",
            { className: `bubble ${isUser ? "user" : "assistant"}` },
            item.meta ? e("div", { className: "bubble-meta" }, item.meta) : null,
            e(MarkdownBubbleText, { text: bubbleText })
          ),
          isUser
            ? e("div", { className: "message-avatar self" }, "ME")
            : null
        );
      }),
    optimisticUser
      ? e(
        "div",
        { className: "message-row user pending-user-row" },
        e(
          "div",
          { className: "bubble user pending-user" },
          e("div", { className: "bubble-meta" }, "사용자 (전송됨)"),
          e(MarkdownBubbleText, { text: optimisticUser.text || "" })
        ),
        e("div", { className: "message-avatar self" }, "ME")
      )
      : null,
    isPendingVisible
      ? e(
        "div",
        { className: "message-row assistant pending-assistant-row" },
        e("div", { className: `message-avatar ${isCodingScope ? "coding" : "assistant"}` }, isCodingScope ? "DEV" : "AI"),
        e(
          "div",
          { className: "bubble assistant pending-bubble" },
          e("div", { className: "bubble-meta" }, "assistant"),
          e("div", { className: "pending" }, "작성중..."),
          !isCodingScope && pending?.provider
            ? e("div", { className: "pending-route" }, `${pending.provider || "-"}:${pending.model || "-"}${pending.route ? ` · ${pending.route}` : ""}`)
            : null,
          !isCodingScope && pending?.draftText
            ? e(MarkdownBubbleText, { text: pending.draftText })
            : null,
          isCodingScope
            ? e("div", { className: "pending-details" },
              e("div", { className: "pending-meta-row" },
                e("span", { className: "pending-phase" }, progress?.phase || "processing"),
                e("span", { className: "pending-time" }, `${elapsed}s`)
              ),
              progress?.message ? e("div", { className: "pending-message" }, progress.message) : null,
              progress?.provider || progress?.model
                ? e("div", { className: "pending-route" }, `${progress.provider || "-"}:${progress.model || "-"}`)
                : null,
              progress?.maxIterations > 0
                ? e("div", { className: "pending-iteration" }, `${progress.iteration || 0}/${progress.maxIterations}`)
                : null,
              e("div", { className: "progress-track" },
                e("div", { className: "progress-fill", style: { width: `${percent}%` } })
              )
            )
            : null
        )
      )
      : null
  );
}
