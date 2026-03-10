export function createRoutingPolicyState() {
  return {
    loaded: false,
    loading: false,
    pending: false,
    lastError: "",
    lastAction: "",
    snapshot: null,
    draftChains: {}
  };
}
