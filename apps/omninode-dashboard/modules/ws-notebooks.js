function normalizeProjectKey(projectKey) {
  const normalized = `${projectKey || ""}`.trim();
  return normalized || undefined;
}

export function requestNotebookGet(send, projectKey, options = {}) {
  return send({
    type: "notebook_get",
    projectKey: normalizeProjectKey(projectKey)
  }, options);
}

export function requestNotebookAppend(send, payload, options = {}) {
  return send({
    type: "notebook_append",
    projectKey: normalizeProjectKey(payload && payload.projectKey),
    kind: payload && payload.kind ? `${payload.kind}`.trim() : undefined,
    content: payload && payload.content ? `${payload.content}` : ""
  }, options);
}

export function requestHandoffCreate(send, projectKey, options = {}) {
  return send({
    type: "handoff_create",
    projectKey: normalizeProjectKey(projectKey)
  }, options);
}
