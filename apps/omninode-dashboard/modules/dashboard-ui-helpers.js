export function autoResizeComposerTextarea(node) {
  if (!node) {
    return;
  }

  node.style.height = "0px";
  const nextHeight = Math.min(Math.max(node.scrollHeight, 46), 168);
  node.style.height = `${nextHeight}px`;
  node.style.overflowY = node.scrollHeight > 168 ? "auto" : "hidden";
}

export function createResponsiveSectionTabsRenderer(e) {
  return function renderResponsiveSectionTabs(items, activeKey, onSelect, extraClassName = "") {
    return e(
      "div",
      { className: `responsive-section-tabs ${extraClassName}`.trim() },
      items.map((item) => e(
        "button",
        {
          key: item.key,
          type: "button",
          className: `responsive-section-tab-btn ${activeKey === item.key ? "active" : ""}`,
          onClick: () => onSelect(item.key)
        },
        item.label
      ))
    );
  };
}
