export function requestRefactorRead(send, path, options = {}) {
  return send({ type: "refactor_read", path }, options);
}

export function requestRefactorPreview(send, path, edits, options = {}) {
  return send({
    type: "refactor_preview",
    mode: "anchor-edit",
    path,
    edits
  }, options);
}

export function requestRefactorApply(send, previewId, options = {}) {
  return send({ type: "refactor_apply", previewId }, options);
}

export function requestLspRename(send, path, symbol, newName, options = {}) {
  return send({ type: "lsp_rename", path, symbol, newName }, options);
}

export function requestAstReplace(send, path, pattern, replacement, options = {}) {
  return send({ type: "ast_replace", path, pattern, replacement }, options);
}
