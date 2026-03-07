export function createRoutineOutputPreviewState() {
  return {
    open: false,
    title: "",
    content: "",
    imagePath: "",
    imageAlt: ""
  };
}

export function createRoutineState(options) {
  const { defaultMobilePanes } = options;
  return {
    routines: [],
    routineSelectedId: "",
    groqUsageWindowBaseByModel: {},
    mobilePaneByTab: { ...defaultMobilePanes }
  };
}
