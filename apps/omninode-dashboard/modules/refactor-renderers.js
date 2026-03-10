function clampPreviewText(value, maxLength = 160) {
  const normalized = `${value || ""}`.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function getModeLabel(mode) {
  switch (`${mode || ""}`) {
    case "lsp":
      return "이름 바꾸기";
    case "ast":
      return "패턴 치환";
    default:
      return "줄 범위 교체";
  }
}

function getModeDescription(mode) {
  switch (`${mode || ""}`) {
    case "lsp":
      return "함수명, 변수명 같은 이름을 관련 위치까지 함께 바꿉니다.";
    case "ast":
      return "코드 패턴을 찾아 같은 형태를 한 번에 바꿉니다.";
    default:
      return "선택한 줄 범위만 안전하게 바꿉니다.";
  }
}

function getPreviewActionLabel(mode) {
  switch (`${mode || ""}`) {
    case "lsp":
      return "이름 바꾸기 미리보기";
    case "ast":
      return "패턴 치환 미리보기";
    default:
      return "교체 미리보기";
  }
}

function buildRefactorStatus(state) {
  const preview = state.preview || null;
  const issues = Array.isArray(state.lastIssues) ? state.lastIssues : [];
  if (state.pending) {
    return { text: "요청 중", tone: "neutral" };
  }
  if (preview && preview.safeToApply && preview.previewId) {
    return { text: "preview 준비됨", tone: "ok" };
  }
  if (issues.length > 0 || state.lastError) {
    return { text: "확인 필요", tone: "error" };
  }
  if (`${state.mode || ""}` === "anchor" && state.readResult) {
    return { text: "기준 줄 로드됨", tone: "neutral" };
  }
  return { text: getModeLabel(state.mode), tone: "neutral" };
}

function renderModeSwitch(props) {
  const { e, state, actions } = props;
  const modes = [
    { key: "anchor", label: "줄 범위 교체" },
    { key: "lsp", label: "이름 바꾸기" },
    { key: "ast", label: "패턴 치환" }
  ];

  return e("div", { className: "refactor-mode-switch" },
    modes.map((item) => e("button", {
      key: item.key,
      type: "button",
      className: `btn ${state.mode === item.key ? "primary" : "secondary"} compact`,
      onClick: () => actions.setMode(item.key),
      disabled: state.pending
    }, item.label))
  );
}

function renderAnchorSection(props) {
  const {
    e,
    state,
    selectedLines,
    currentSnippet,
    selectedSummary,
    actions
  } = props;

  return [
    e("div", { key: "range-grid", className: "refactor-range-grid" },
      e("label", { className: "settings-inline-field" },
        e("span", null, "시작 줄"),
        e("input", {
          className: "input compact",
          type: "number",
          min: "1",
          value: state.selectedStartLine || "",
          onChange: (event) => actions.setSelectedStartLine(event.target.value)
        })
      ),
      e("label", { className: "settings-inline-field" },
        e("span", null, "끝 줄"),
        e("input", {
          className: "input compact",
          type: "number",
          min: "1",
          value: state.selectedEndLine || "",
          onChange: (event) => actions.setSelectedEndLine(event.target.value)
        })
      ),
      e("div", { className: "fixed-chip" }, selectedSummary || "바꿀 줄을 선택하세요")
    ),
    e("textarea", {
      key: "replacement",
      className: "textarea refactor-replacement",
      rows: 8,
      value: state.replacement || "",
      placeholder: "예: const total = price + tax;",
      onChange: (event) => actions.setReplacement(event.target.value)
    }),
    currentSnippet
      ? e("div", { key: "snippet", className: "coding-preview" },
        e("div", { className: "coding-preview-head" }, "선택 범위 원본"),
        e("pre", { className: "coding-preview-content" }, currentSnippet)
      )
      : e("div", { key: "snippet-empty", className: "empty-line" }, "줄을 선택하면 현재 원문 범위를 여기서 확인합니다."),
    state.readResult
      ? e("div", { key: "anchors", className: "refactor-anchor-list" },
        state.readResult.lines.map((line) => {
          const active = selectedLines.some((item) => item.lineNumber === line.lineNumber);
          return e(
            "button",
            {
              key: `anchor-${line.lineNumber}`,
              className: `refactor-anchor-row ${active ? "active" : ""}`,
              onClick: () => actions.selectAnchorLine(line.lineNumber)
            },
            e("span", { className: "refactor-anchor-meta" }, `L${line.lineNumber} · ${line.hash}`),
            e("span", { className: "refactor-anchor-content" }, clampPreviewText(line.content))
          );
        })
      )
      : null
  ];
}

function renderLspSection(props) {
  const { e, state, actions } = props;
  return e("div", { className: "refactor-structured-grid" },
    e("label", { className: "settings-inline-field" },
      e("span", null, "바꿀 이름"),
      e("input", {
        className: "input",
        value: state.symbol || "",
        placeholder: "예: addValue",
        onChange: (event) => actions.setSymbol(event.target.value)
      })
    ),
    e("label", { className: "settings-inline-field" },
      e("span", null, "새 이름"),
      e("input", {
        className: "input",
        value: state.newName || "",
        placeholder: "예: sumValue",
        onChange: (event) => actions.setNewName(event.target.value)
      })
    )
  );
}

function renderAstSection(props) {
  const { e, state, actions } = props;
  return [
    e("label", { key: "pattern", className: "settings-inline-field refactor-block-field" },
      e("span", null, "찾을 패턴"),
      e("textarea", {
        className: "textarea refactor-replacement",
        rows: 4,
        value: state.pattern || "",
        placeholder: "예: hello($A)",
        onChange: (event) => actions.setPattern(event.target.value)
      })
    ),
    e("label", { key: "rewrite", className: "settings-inline-field refactor-block-field" },
      e("span", null, "바꿀 코드"),
      e("textarea", {
        className: "textarea refactor-replacement",
        rows: 5,
        value: state.replacement || "",
        placeholder: "예: hi($A)",
        onChange: (event) => actions.setReplacement(event.target.value)
      })
    )
  ];
}

function renderPreviewBlock(props) {
  const { e, state, helpers } = props;
  const preview = state.preview || null;
  const changedPaths = Array.isArray(preview?.changedPaths) ? preview.changedPaths : [];
  if (!preview) {
    const emptyText = `${getModeLabel(state.mode)} 미리보기를 만들면 변경 diff가 여기 표시됩니다.`;
    return e("div", { className: "empty-line" }, emptyText);
  }

  return e("div", { className: "coding-preview" },
    e("div", { className: "coding-preview-head" },
      `${helpers.humanWorkspacePath(preview.path)} · ${preview.previewId}`
    ),
    changedPaths.length > 1
      ? e("div", { className: "refactor-preview-paths" },
        changedPaths.map((path) => e("span", { key: path, className: "fixed-chip" }, helpers.humanWorkspacePath(path)))
      )
      : null,
    e("pre", { className: "coding-preview-content" }, preview.unifiedDiff || "")
  );
}

function renderToolResult(props) {
  const { e, state } = props;
  const toolResult = state.toolResult || null;
  if (!toolResult) {
    return null;
  }

  const details = [
    toolResult.tool || "",
    toolResult.language || "",
    toolResult.binaryPath || "",
    toolResult.status || ""
  ].filter(Boolean).join(" · ");

  return e("div", { className: "empty-line refactor-tool-result" },
    details ? e("div", { className: "refactor-tool-meta" }, details) : null,
    e("div", null, toolResult.message || "")
  );
}

function renderIssues(props) {
  const { e, state } = props;
  const issues = Array.isArray(state.lastIssues) ? state.lastIssues : [];
  if (issues.length === 0) {
    return null;
  }

  return e("div", { className: "refactor-issues" },
    issues.map((issue, index) => e("article", { key: `refactor-issue-${index}`, className: "refactor-issue-item" },
      e("strong", null, `${issue.startLine || "?"}-${issue.endLine || "?"}줄`),
      e("div", null, issue.reason || "오류"),
      issue.currentSnippet
        ? e("pre", { className: "refactor-issue-snippet" }, issue.currentSnippet)
        : null
    ))
  );
}

function renderSafeRefactorCard(props) {
  const {
    e,
    state,
    selectedLines,
    currentSnippet,
    selectedSummary,
    helpers,
    actions,
    panelClassName,
    headerAction
  } = props;

  const readResult = state.readResult || null;
  const preview = state.preview || null;
  const safeToApply = !!(preview && preview.safeToApply && preview.previewId);
  const loadedCount = Array.isArray(readResult?.lines) ? readResult.lines.length : 0;
  const status = buildRefactorStatus(state);
  const mode = `${state.mode || "anchor"}`;
  const modeDescription = getModeDescription(mode);
  const actionLabel = getPreviewActionLabel(mode);

  return e(
    "section",
    { className: `coding-result support-card refactor-panel ${panelClassName || ""}`.trim() },
    e("div", { className: "coding-result-head refactor-panel-head" },
      e("div", { className: "refactor-panel-head-copy" },
        e("strong", null, "Safe Refactor"),
        e("span", null, `${getModeLabel(mode)} · ${status.text}`)
      ),
      headerAction || null
    ),
    readResult && mode === "anchor"
      ? e("div", { className: "coding-result-meta" },
      readResult && mode === "anchor"
        ? `${helpers.humanWorkspacePath(readResult.path)} · 줄 ${loadedCount}/${readResult.totalLines || loadedCount}${readResult.truncated ? " · 일부만 로드" : ""}`
        : ""
      )
      : null,
    renderModeSwitch(props),
    e("div", { className: "coding-result-meta refactor-mode-description" }, modeDescription),
    e("div", { className: "refactor-toolbar" },
      e("input", {
        className: "input refactor-path-input",
        value: state.filePath || "",
        placeholder: "예: src/app.js 또는 /절대/경로/app.js",
        onChange: (event) => actions.setFilePath(event.target.value)
      }),
      mode === "anchor"
        ? e("button", {
          className: "btn secondary",
          onClick: actions.readAnchors,
          disabled: state.pending
        }, state.pending && state.lastAction === "read" ? "읽는 중..." : "기준 줄 읽기")
        : null,
      e("button", {
        className: "btn secondary",
        onClick: actions.previewRefactor,
        disabled: state.pending || (mode === "anchor" && !readResult)
      }, state.pending && ["preview", "lsp_rename", "ast_replace"].includes(state.lastAction) ? "미리보기 생성 중..." : actionLabel),
      e("button", {
        className: "btn primary",
        onClick: actions.applyRefactor,
        disabled: state.pending || !safeToApply
      }, state.pending && state.lastAction === "apply" ? "적용 중..." : "적용")
    ),
    mode === "anchor"
      ? renderAnchorSection(props)
      : mode === "lsp"
        ? renderLspSection(props)
        : renderAstSection(props),
    renderPreviewBlock(props),
    renderToolResult(props),
    renderIssues(props),
    state.lastError
      ? e("div", { className: "empty-line refactor-status error" }, state.lastError)
      : state.lastMessage
        ? e("div", { className: "empty-line refactor-status" }, state.lastMessage)
        : null
  );
}

export function renderSafeRefactorPanel(props) {
  const { rootTab } = props;
  if (rootTab !== "coding") {
    return null;
  }

  return renderSafeRefactorCard(props);
}

export function renderSafeRefactorDock(props) {
  const {
    e,
    rootTab,
    state,
    selectedSummary,
    helpers,
    actions
  } = props;

  if (rootTab !== "coding") {
    return null;
  }

  const readResult = state.readResult || null;
  const preview = state.preview || null;
  const status = buildRefactorStatus(state);
  const modeLabel = getModeLabel(state.mode);
  const fileLabel = readResult?.path
    ? helpers.humanWorkspacePath(readResult.path)
    : state.filePath || "파일 미선택";
  const modeDetail = state.mode === "anchor"
    ? (selectedSummary || (preview?.previewId ? `${preview.previewId} 준비됨` : "필요할 때만 열어 preview/apply를 진행하세요."))
    : state.mode === "lsp"
      ? `${state.symbol || "이름 입력"} -> ${state.newName || "새 이름 입력"}`
      : (state.pattern ? clampPreviewText(state.pattern, 48) : "패턴 입력");
  const detail = [
    modeLabel,
    fileLabel,
    modeDetail
  ].filter(Boolean).join(" · ");

  return e(
    "div",
    { className: "compact-support-dock safe-refactor-dock" },
    e("div", { className: "compact-support-dock-copy" },
      e("div", { className: "compact-support-dock-head" },
        e("strong", null, "Safe Refactor"),
        e("span", { className: `compact-support-dock-status ${status.tone}` }, status.text)
      ),
      e("div", { className: "compact-support-dock-detail" }, detail)
    ),
    e("button", {
      type: "button",
      className: "btn secondary compact-support-dock-trigger",
      onClick: actions.openOverlay,
      title: "Safe Refactor 열기"
    },
    e("span", { className: "compact-support-dock-arrow", "aria-hidden": "true" }, "↑"),
    e("span", null, "열기"))
  );
}

export function renderSafeRefactorOverlay(props) {
  const {
    e,
    rootTab,
    open,
    actions
  } = props;

  if (rootTab !== "coding" || !open) {
    return null;
  }

  return e(
    "div",
    {
      className: "modal support-overlay-modal",
      onClick: actions.closeOverlay
    },
    e("div", {
      className: "support-overlay-shell",
      onClick: (event) => event.stopPropagation()
    },
    renderSafeRefactorCard({
      ...props,
      panelClassName: "refactor-panel-modal",
      headerAction: e("button", {
        type: "button",
        className: "btn ghost",
        onClick: actions.closeOverlay
      }, "닫기")
    }))
  );
}
