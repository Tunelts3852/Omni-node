export function handleConversationMemoryMessage(msg, context) {
  const {
    autoCreateConversationRef,
    setSelectedConversationIdsByKey,
    setSelectedFoldersByKey,
    setConversationLists,
    setActiveConversationByKey,
    requestConversationDetail,
    requestAutoCreateConversation,
    setConversationDetails,
    setSelectedMemoryByConversation,
    setChatMultiResultByConversation,
    log,
    setMemoryNotes,
    setMemoryPreview,
    currentConversationId,
    send,
    setError,
    currentKey,
    setFilePreviewByConversation
  } = context

  if (msg.type === "conversations") {
    const list = Array.isArray(msg.items) ? msg.items : []
    const key = `${msg.scope || "chat"}:${msg.mode || "single"}`
    if (list.length > 0) {
      autoCreateConversationRef.current[key] = false
    }

    setSelectedConversationIdsByKey((prev) => {
      const base = Array.isArray(prev[key]) ? prev[key] : []
      if (base.length === 0) {
        return prev
      }

      const allowed = new Set(list.map((item) => item.id))
      const next = base.filter((id) => allowed.has(id))
      return next.length === base.length ? prev : { ...prev, [key]: next }
    })
    setSelectedFoldersByKey((prev) => {
      const base = Array.isArray(prev[key]) ? prev[key] : []
      if (base.length === 0) {
        return prev
      }

      const allowed = new Set(list.map((item) => ((item.project || "기본").trim() || "기본")))
      const next = base.filter((project) => allowed.has(project))
      return next.length === base.length ? prev : { ...prev, [key]: next }
    })
    setConversationLists((prev) => ({ ...prev, [key]: list }))
    setActiveConversationByKey((prev) => {
      const active = prev[key]
      if (active && list.some((x) => x.id === active)) {
        return prev
      }

      if (list.length > 0) {
        requestConversationDetail(list[0].id)
        return { ...prev, [key]: list[0].id }
      }

      requestAutoCreateConversation(msg.scope || "chat", msg.mode || "single")
      return prev
    })
    return true
  }

  if (msg.type === "conversation_created" || msg.type === "conversation_detail") {
    const conversation = msg.conversation
    if (!conversation || !conversation.id) {
      return true
    }

    const key = `${conversation.scope}:${conversation.mode}`
    autoCreateConversationRef.current[key] = false
    setConversationDetails((prev) => ({ ...prev, [conversation.id]: conversation }))
    setConversationLists((prev) => {
      const list = Array.isArray(prev[key]) ? prev[key] : []
      if (list.length === 0) {
        return prev
      }

      const index = list.findIndex((item) => item.id === conversation.id)
      if (index < 0) {
        return prev
      }

      const current = list[index]
      const nextItem = {
        ...current,
        title: conversation.title || current.title || "제목 없음",
        preview: conversation.preview || current.preview || "",
        messageCount: Number.isFinite(conversation.messageCount) ? conversation.messageCount : current.messageCount,
        project: conversation.project || current.project || "기본",
        category: conversation.category || current.category || "일반",
        tags: Array.isArray(conversation.tags) ? conversation.tags : (current.tags || [])
      }
      const nextList = list.slice()
      nextList[index] = nextItem
      return { ...prev, [key]: nextList }
    })
    setActiveConversationByKey((prev) => ({ ...prev, [key]: conversation.id }))
    setSelectedMemoryByConversation((prev) => {
      const incoming = Array.isArray(conversation.linkedMemoryNotes) ? conversation.linkedMemoryNotes : []
      const current = Array.isArray(prev[conversation.id]) ? prev[conversation.id] : null
      if (current && current.length === incoming.length && current.every((value, index) => value === incoming[index])) {
        return prev
      }
      return { ...prev, [conversation.id]: incoming }
    })
    return true
  }

  if (msg.type === "conversation_deleted") {
    const conversationId = msg.conversationId || ""
    if (!conversationId) {
      return true
    }

    setSelectedConversationIdsByKey((prev) => {
      const next = {}
      let changed = false
      Object.entries(prev).forEach(([key, ids]) => {
        if (!Array.isArray(ids)) {
          next[key] = ids
          return
        }

        const filtered = ids.filter((id) => id !== conversationId)
        next[key] = filtered
        if (filtered.length !== ids.length) {
          changed = true
        }
      })
      return changed ? next : prev
    })
    setConversationDetails((prev) => {
      const next = { ...prev }
      delete next[conversationId]
      return next
    })
    setChatMultiResultByConversation((prev) => {
      const next = { ...prev }
      delete next[conversationId]
      return next
    })
    return true
  }

  if (msg.type === "memory_cleared") {
    const scopeText = String(msg.scope || "chat").toLowerCase()
    const refreshScope = scopeText === "telegram" ? "chat" : scopeText
    if (refreshScope === "all") {
      ["chat", "coding"].forEach((targetScope) => {
        ["single", "orchestration", "multi"].forEach((targetMode) => {
          const key = `${targetScope}:${targetMode}`
          autoCreateConversationRef.current[key] = false
        })
      })
    } else if (refreshScope === "chat" || refreshScope === "coding") {
      ["single", "orchestration", "multi"].forEach((targetMode) => {
        const key = `${refreshScope}:${targetMode}`
        autoCreateConversationRef.current[key] = false
      })
    }

    if (msg.message) {
      log(`[memory] ${msg.message}`, "info")
    }
    return true
  }

  if (msg.type === "memory_notes") {
    setMemoryNotes(Array.isArray(msg.items) ? msg.items : [])
    return true
  }

  if (msg.type === "memory_note_content") {
    setMemoryPreview({
      open: true,
      name: msg.name || "",
      content: msg.content || ""
    })
    return true
  }

  if (msg.type === "memory_note_created") {
    const ok = !!msg.ok
    const conversationId = msg.conversationId || currentConversationId || ""
    const noteName = msg.note && typeof msg.note.name === "string" ? msg.note.name : ""
    if (ok && conversationId && noteName) {
      setSelectedMemoryByConversation((prev) => {
        const base = Array.isArray(prev[conversationId]) ? prev[conversationId] : []
        if (base.includes(noteName)) {
          return prev
        }

        return { ...prev, [conversationId]: base.concat([noteName]) }
      })
    }

    if (msg.message) {
      log(`[memory] ${msg.message}`, ok ? "info" : "error")
    }
    send({ type: "list_memory_notes" }, { silent: true, queueIfClosed: false })
    return true
  }

  if (msg.type === "memory_note_deleted") {
    const ok = !!msg.ok
    const removedNames = Array.isArray(msg.removedNames)
      ? msg.removedNames.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim())
      : []

    if (removedNames.length > 0) {
      setSelectedMemoryByConversation((prev) => {
        const next = {}
        Object.entries(prev).forEach(([conversationId, names]) => {
          next[conversationId] = Array.isArray(names)
            ? names.filter((name) => !removedNames.includes(name))
            : names
        })
        return next
      })
      setConversationDetails((prev) => {
        const next = {}
        Object.entries(prev).forEach(([conversationId, detail]) => {
          next[conversationId] = detail && Array.isArray(detail.linkedMemoryNotes)
            ? { ...detail, linkedMemoryNotes: detail.linkedMemoryNotes.filter((name) => !removedNames.includes(name)) }
            : detail
        })
        return next
      })
      setMemoryPreview((prev) => (
        removedNames.includes(prev.name)
          ? { open: false, name: "", content: "" }
          : prev
      ))
    }

    if (msg.message) {
      log(`[memory] ${msg.message}`, ok ? "info" : "error")
    }
    send({ type: "list_memory_notes" }, { silent: true, queueIfClosed: false })
    return true
  }

  if (msg.type === "memory_note_renamed") {
    const ok = !!msg.ok
    const oldName = typeof msg.oldName === "string" ? msg.oldName.trim() : ""
    const newName = typeof msg.newName === "string" ? msg.newName.trim() : ""

    if (ok && oldName && newName) {
      setSelectedMemoryByConversation((prev) => {
        const next = {}
        Object.entries(prev).forEach(([conversationId, names]) => {
          next[conversationId] = Array.isArray(names)
            ? names.map((name) => name === oldName ? newName : name)
            : names
        })
        return next
      })
      setConversationDetails((prev) => {
        const next = {}
        Object.entries(prev).forEach(([conversationId, detail]) => {
          next[conversationId] = detail && Array.isArray(detail.linkedMemoryNotes)
            ? {
                ...detail,
                linkedMemoryNotes: detail.linkedMemoryNotes.map((name) => name === oldName ? newName : name)
              }
            : detail
        })
        return next
      })
      setMemoryPreview((prev) => (
        prev.name === oldName
          ? { ...prev, name: newName }
          : prev
      ))
    }

    if (msg.message) {
      log(`[memory] ${msg.message}`, ok ? "info" : "error")
    }
    send({ type: "list_memory_notes" }, { silent: true, queueIfClosed: false })
    return true
  }

  if (msg.type === "workspace_file_preview") {
    const conversationId = msg.conversationId || currentConversationId || ""
    if (!conversationId) {
      return true
    }

    if (!msg.ok) {
      setError(currentKey, msg.message || "파일 프리뷰를 불러오지 못했습니다.")
      return true
    }

    setFilePreviewByConversation((prev) => ({
      ...prev,
      [conversationId]: {
        path: msg.path || "",
        content: msg.content || ""
      }
    }))
    return true
  }

  return false
}

export function handleRoutineMessage(msg, context) {
  const {
    setRoutines,
    setRoutineSelectedId,
    isPortraitMobileLayout,
    setResponsivePane,
    log,
    setError,
    routineBrowserAgentPreviewRef,
    send,
    setRoutineOutputPreview
  } = context

  if (msg.type === "routines_state") {
    const items = Array.isArray(msg.items) ? msg.items : []
    setRoutines(items)
    setRoutineSelectedId((prev) => {
      if (prev && items.some((x) => x.id === prev)) {
        return prev
      }
      return items.length > 0 ? (items[0].id || "") : ""
    })
    if (isPortraitMobileLayout && items.length === 0) {
      setResponsivePane("routine", "overview")
    }
    return true
  }

  if (msg.type === "routine_result") {
    const ok = !!msg.ok
    const messageText = msg.message || (ok ? "루틴 처리 완료" : "루틴 처리 실패")
    log(messageText, ok ? "info" : "error")
    setError("routine:main", ok ? "" : `오류: ${messageText}`)
    if (msg.routine && msg.routine.id) {
      setRoutineSelectedId(msg.routine.id)
      if (isPortraitMobileLayout) {
        setResponsivePane("routine", "detail")
      }
    }
    if (routineBrowserAgentPreviewRef.current
      && msg.routine
      && msg.routine.id === routineBrowserAgentPreviewRef.current) {
      const newestRun = Array.isArray(msg.routine.runs) && msg.routine.runs.length > 0
        ? msg.routine.runs[0]
        : null
      routineBrowserAgentPreviewRef.current = ""
      if (newestRun && newestRun.ts) {
        send({ type: "get_routine_run_detail", routineId: msg.routine.id, ts: newestRun.ts })
      } else {
        setRoutineOutputPreview({
          open: true,
          title: `${msg.routine.title || msg.routine.id} · 브라우저 에이전트 테스트`,
          content: msg.message || "출력 없음",
          imagePath: "",
          imageAlt: ""
        })
      }
    }
    send({ type: "get_routines" })
    return true
  }

  if (msg.type === "routine_run_detail") {
    const ok = !!msg.ok
    if (!ok) {
      const errorText = msg.error || "실행 이력을 불러오지 못했습니다."
      setError("routine:main", `오류: ${errorText}`)
      log(errorText, "error")
      return true
    }

    const titleParts = [
      msg.title || "루틴 실행 상세",
      msg.runAtLocal || "",
      msg.status || ""
    ].filter(Boolean)
    const meta = [
      msg.source ? `source=${msg.source}` : "",
      Number.isFinite(Number(msg.attemptCount)) ? `attempts=${Number(msg.attemptCount)}` : "",
      msg.telegramStatus ? `telegram=${msg.telegramStatus}` : "",
      msg.artifactPath ? `artifact=${msg.artifactPath}` : "",
      msg.agentSessionId ? `agentSessionId=${msg.agentSessionId}` : "",
      msg.agentRunId ? `agentRunId=${msg.agentRunId}` : "",
      msg.agentProvider || msg.agentModel ? `agent=${msg.agentProvider || "-"}:${msg.agentModel || "-"}` : "",
      msg.toolProfile ? `toolProfile=${msg.toolProfile}` : "",
      msg.startUrl ? `startUrl=${msg.startUrl}` : "",
      msg.finalUrl ? `finalUrl=${msg.finalUrl}` : "",
      msg.pageTitle ? `pageTitle=${msg.pageTitle}` : "",
      msg.screenshotPath ? `screenshot=${msg.screenshotPath}` : ""
    ].filter(Boolean).join("\n")
    setRoutineOutputPreview({
      open: true,
      title: titleParts.join(" · "),
      content: meta ? `${meta}\n\n${msg.content || ""}` : (msg.content || ""),
      imagePath: msg.screenshotPath || "",
      imageAlt: msg.pageTitle || msg.title || "루틴 스크린샷"
    })
    return true
  }

  return false
}

export function handleExecutionFlowMessage(msg, context) {
  const {
    setCodingProgressByKey,
    setPendingByKey,
    setActiveConversationByKey,
    setOptimisticUserByKey,
    normalizeChatMultiResultMessage,
    setChatMultiResultByConversation,
    attachLatencyMetaToConversation,
    setConversationDetails,
    setSelectedMemoryByConversation,
    finishPendingRequest,
    setError,
    setCodingResultByConversation,
    setShowExecutionLogsByConversation,
    setFilePreviewByConversation,
    send,
    log,
    setMetrics
  } = context

  if (msg.type === "coding_progress") {
    const key = `${msg.scope || "coding"}:${msg.mode || "single"}`
    setCodingProgressByKey((prev) => {
      const now = Date.now()
      const base = prev[key] || {}
      const conversationId = `${msg.conversationId || base.conversationId || ""}`.trim()
      return {
        ...prev,
        [key]: {
          phase: msg.phase || base.phase || "",
          message: msg.message || base.message || "",
          iteration: Number.isFinite(msg.iteration) ? msg.iteration : (base.iteration || 0),
          maxIterations: Number.isFinite(msg.maxIterations) ? msg.maxIterations : (base.maxIterations || 0),
          percent: Number.isFinite(msg.percent) ? msg.percent : (base.percent || 0),
          done: !!msg.done,
          provider: msg.provider || base.provider || "",
          model: msg.model || base.model || "",
          conversationId,
          startedAt: base.startedAt || now,
          updatedAt: now
        }
      }
    })
    return true
  }

  if (msg.type === "llm_chat_stream_chunk") {
    const key = `${msg.scope || "chat"}:${msg.mode || "single"}`
    const conversationId = `${msg.conversationId || ""}`.trim()
    setPendingByKey((prev) => {
      const now = Date.now()
      const base = prev[key] || {}
      const baseDraft = typeof base.draftText === "string" ? base.draftText : ""
      const delta = typeof msg.delta === "string" ? msg.delta : ""
      return {
        ...prev,
        [key]: {
          ...base,
          active: true,
          conversationId,
          startedUtc: base.startedUtc || new Date(now).toISOString(),
          updatedAt: now,
          draftText: `${baseDraft}${delta}`,
          provider: msg.provider || base.provider || "",
          model: msg.model || base.model || "",
          route: msg.route || base.route || "",
          chunkIndex: Number.isFinite(msg.chunkIndex) ? msg.chunkIndex : (base.chunkIndex || 0)
        }
      }
    })
    setActiveConversationByKey((prev) => {
      if (!conversationId) {
        return prev
      }

      const current = `${prev[key] || ""}`.trim()
      if (current) {
        return prev
      }

      return { ...prev, [key]: conversationId }
    })
    setOptimisticUserByKey((prev) => {
      const base = prev[key]
      if (!base || !conversationId) {
        return prev
      }

      const currentConversationId = `${base.conversationId || ""}`.trim()
      if (currentConversationId) {
        return prev
      }

      return {
        ...prev,
        [key]: {
          ...base,
          conversationId
        }
      }
    })
    return true
  }

  if (msg.type === "llm_chat_result" || msg.type === "llm_chat_multi_result" || msg.type === "coding_result") {
    const conv = msg.conversation
    if (!conv || !conv.id) {
      return true
    }

    if (msg.type === "llm_chat_multi_result") {
      const normalizedResult = normalizeChatMultiResultMessage(msg)
      setChatMultiResultByConversation((prev) => ({
        ...prev,
        [conv.id]: {
          ...normalizedResult,
          updatedUtc: new Date().toISOString()
        }
      }))
    }

    const key = `${conv.scope}:${conv.mode}`
    const normalizedConversation = msg.type === "llm_chat_result"
      ? attachLatencyMetaToConversation(conv, msg)
      : conv
    setConversationDetails((prev) => ({ ...prev, [conv.id]: normalizedConversation }))
    setActiveConversationByKey((prev) => {
      if (prev[key]) {
        return prev
      }
      return { ...prev, [key]: conv.id }
    })
    setSelectedMemoryByConversation((prev) => ({
      ...prev,
      [conv.id]: normalizedConversation.linkedMemoryNotes || prev[conv.id] || []
    }))
    finishPendingRequest(key)
    setError(key, "")

    if (msg.type === "coding_result") {
      setCodingResultByConversation((prev) => ({ ...prev, [conv.id]: msg }))
      setShowExecutionLogsByConversation((prev) => ({ ...prev, [conv.id]: false }))
      setFilePreviewByConversation((prev) => {
        const next = { ...prev }
        delete next[conv.id]
        return next
      })
    }

    if (msg.autoMemoryNote) {
      send({ type: "list_memory_notes" })
      log(`자동 컨텍스트 압축 노트 생성: ${msg.autoMemoryNote.name}`)
    }
    return true
  }

  if (msg.type === "metrics" || msg.type === "metrics_stream") {
    const text = typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload, null, 2)
    setMetrics(text)
    return true
  }

  if (msg.type === "command_result") {
    log(`결과: ${msg.text || ""}`)
    return true
  }

  return false
}
