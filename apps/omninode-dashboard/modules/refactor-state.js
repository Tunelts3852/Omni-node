export function createRefactorState() {
  return {
    mode: "anchor",
    filePath: "",
    loadedPath: "",
    readResult: null,
    selectedStartLine: "",
    selectedEndLine: "",
    symbol: "",
    newName: "",
    pattern: "",
    replacement: "",
    preview: null,
    pending: false,
    lastAction: "",
    lastError: "",
    lastMessage: "",
    lastIssues: [],
    toolResult: null
  };
}
