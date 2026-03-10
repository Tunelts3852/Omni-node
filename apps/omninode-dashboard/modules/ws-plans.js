export function requestPlanList(send, options = {}) {
  return send({ type: "plan_list" }, options);
}

export function requestPlanGet(send, planId, options = {}) {
  return send({ type: "plan_get", planId }, options);
}

export function requestPlanCreate(send, payload, options = {}) {
  return send({
    type: "plan_create",
    text: payload?.objective || "",
    constraints: Array.isArray(payload?.constraints) ? payload.constraints : [],
    mode: payload?.mode || "fast",
    conversationId: payload?.conversationId || undefined
  }, options);
}

export function requestPlanReview(send, planId, options = {}) {
  return send({ type: "plan_review", planId }, options);
}

export function requestPlanApprove(send, planId, options = {}) {
  return send({ type: "plan_approve", planId }, options);
}

export function requestPlanRun(send, planId, options = {}) {
  return send({ type: "plan_run", planId }, options);
}
