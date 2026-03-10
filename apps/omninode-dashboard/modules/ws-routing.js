export function requestRoutingPolicyGet(send, options = {}) {
  return send({ type: "routing_policy_get" }, options);
}

export function requestRoutingPolicySave(send, policy, options = {}) {
  return send({ type: "routing_policy_save", policy }, options);
}

export function requestRoutingPolicyReset(send, options = {}) {
  return send({ type: "routing_policy_reset" }, options);
}

export function requestRoutingDecisionGetLast(send, options = {}) {
  return send({ type: "routing_decision_get_last" }, options);
}
