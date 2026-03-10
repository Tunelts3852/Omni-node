export function requestContextScan(send, options = {}) {
  return send({ type: "context_scan" }, options);
}

export function requestSkillsList(send, options = {}) {
  return send({ type: "skills_list" }, options);
}

export function requestCommandsList(send, options = {}) {
  return send({ type: "commands_list" }, options);
}
