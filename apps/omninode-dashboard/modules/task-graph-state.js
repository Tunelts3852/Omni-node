export function createTaskGraphState() {
  return {
    items: [],
    loaded: false,
    loading: false,
    pending: false,
    lastError: "",
    lastAction: "",
    selectedGraphId: "",
    selectedTaskId: "",
    snapshot: null,
    output: null,
    createPlanId: ""
  };
}
