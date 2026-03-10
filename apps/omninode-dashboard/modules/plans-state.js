export function createPlansState() {
  return {
    items: [],
    loaded: false,
    loading: false,
    pending: false,
    lastError: "",
    lastAction: "",
    selectedPlanId: "",
    snapshot: null,
    createObjective: "",
    createConstraintsText: "",
    createMode: "fast"
  };
}
