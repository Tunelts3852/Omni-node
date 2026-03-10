export function createContextState() {
  return {
    loaded: false,
    loading: false,
    loadingSkills: false,
    loadingCommands: false,
    lastError: "",
    lastAction: "",
    snapshot: null,
    skills: [],
    commands: []
  };
}
