function escapeHtml(value) {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function countMatches(text, regex) {
  if (!text) {
    return 0;
  }
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function canonicalizeMarkdownTableRow(line) {
  const trimmed = `${line ?? ""}`.trim();
  if (!trimmed.includes("|")) {
    return "";
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return "";
  }

  let candidate = trimmed;
  if (!candidate.startsWith("|")) {
    candidate = `| ${candidate}`;
  }
  if (!candidate.endsWith("|")) {
    candidate = `${candidate} |`;
  }

  const cells = candidate
    .slice(1, -1)
    .split("|")
    .map((cell) => `${cell ?? ""}`.trim());
  if (cells.length < 2 || cells.every((cell) => !cell)) {
    return "";
  }

  return `| ${cells.join(" | ")} |`;
}

function canonicalizeMarkdownTableSeparatorLine(line, expectedCells = 0) {
  const dashVariantsRegex = /[\u2014\u2013\u2011\u2212\u2500\u2012]/g;
  const normalizedRow = canonicalizeMarkdownTableRow(line);
  if (!normalizedRow) {
    return "";
  }

  const rawCells = normalizedRow
    .slice(1, -1)
    .split("|")
    .map((cell) => `${cell ?? ""}`.trim());
  if (rawCells.length < 2) {
    return "";
  }
  if (expectedCells > 0 && rawCells.length !== expectedCells) {
    return "";
  }

  const normalizedCells = [];
  for (const cell of rawCells) {
    const compact = `${cell ?? ""}`.replace(/\s+/g, "").replace(dashVariantsRegex, "-");
    if (!/^:?-+:?$/.test(compact)) {
      return "";
    }

    const leadingColon = compact.startsWith(":") ? ":" : "";
    const trailingColon = compact.endsWith(":") ? ":" : "";
    const dashCount = Math.max(3, countMatches(compact, /-/g));
    normalizedCells.push(`${leadingColon}${"-".repeat(dashCount)}${trailingColon}`);
  }

  return `| ${normalizedCells.join(" | ")} |`;
}

function normalizeMarkdownTableBlocks(text) {
  if (!text) {
    return "";
  }

  const lines = `${text ?? ""}`.split("\n");
  let changed = false;

  for (let i = 0; i + 1 < lines.length; i += 1) {
    const headerRow = canonicalizeMarkdownTableRow(lines[i]);
    if (!headerRow) {
      continue;
    }

    const headerCells = headerRow
      .slice(1, -1)
      .split("|")
      .map((cell) => `${cell ?? ""}`.trim());
    const separatorRow = canonicalizeMarkdownTableSeparatorLine(lines[i + 1], headerCells.length);
    if (!separatorRow) {
      continue;
    }

    if (lines[i] !== headerRow) {
      lines[i] = headerRow;
      changed = true;
    }
    if (lines[i + 1] !== separatorRow) {
      lines[i + 1] = separatorRow;
      changed = true;
    }

    for (let j = i + 2; j < lines.length; j += 1) {
      const bodyRow = canonicalizeMarkdownTableRow(lines[j]);
      if (!bodyRow) {
        break;
      }

      if (lines[j] !== bodyRow) {
        lines[j] = bodyRow;
        changed = true;
      }
    }
  }

  return changed ? lines.join("\n") : text;
}

function hasMarkdownTableBlock(text) {
  const lines = `${text ?? ""}`.split("\n");
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const headerRow = canonicalizeMarkdownTableRow(lines[i]);
    if (!headerRow) {
      continue;
    }

    const headerCells = headerRow
      .slice(1, -1)
      .split("|")
      .map((cell) => `${cell ?? ""}`.trim());
    if (canonicalizeMarkdownTableSeparatorLine(lines[i + 1], headerCells.length)) {
      return true;
    }
  }

  return false;
}

function normalizeMarkdownTableSeparators(text) {
  if (!text) {
    return "";
  }

  const dashVariantsRegex = /[\u2014\u2013\u2011\u2212\u2500\u2012]/g;
  const lines = text.split("\n");
  let changed = false;

  const normalizedLines = lines.map((line) => {
    const trimmed = `${line ?? ""}`.trim();
    if (!trimmed.includes("|")) {
      return line;
    }

    let candidate = trimmed;
    if (!candidate.startsWith("|")) {
      candidate = `|${candidate}`;
    }
    if (!candidate.endsWith("|")) {
      candidate = `${candidate}|`;
    }

    if (!/^\|\s*[:\-\u2014\u2013\u2011\u2212\u2500\u2012]+\s*(\|\s*[:\-\u2014\u2013\u2011\u2212\u2500\u2012]+\s*)+\|$/.test(candidate)) {
      return line;
    }

    const rawCells = candidate
      .slice(1, -1)
      .split("|")
      .map((cell) => `${cell ?? ""}`.trim());
    if (rawCells.length < 2) {
      return line;
    }

    const normalizedCells = [];
    for (const cell of rawCells) {
      const compact = `${cell ?? ""}`.replace(/\s+/g, "").replace(dashVariantsRegex, "-");
      if (!/^:?-+:?$/.test(compact)) {
        return line;
      }

      const leadingColon = compact.startsWith(":") ? ":" : "";
      const trailingColon = compact.endsWith(":") ? ":" : "";
      const dashCount = Math.max(3, countMatches(compact, /-/g));
      normalizedCells.push(`${leadingColon}${"-".repeat(dashCount)}${trailingColon}`);
    }

    const leadingMatch = `${line ?? ""}`.match(/^\s*/);
    const leadingWhitespace = leadingMatch ? leadingMatch[0] : "";
    const rebuilt = `${leadingWhitespace}| ${normalizedCells.join(" | ")} |`;
    if (rebuilt !== line) {
      changed = true;
    }

    return rebuilt;
  });

  return changed ? normalizedLines.join("\n") : text;
}

function isMarkdownTableRow(line) {
  return !!canonicalizeMarkdownTableRow(line);
}

function collapseMarkdownTableBlankLines(text) {
  if (!text) {
    return "";
  }

  const lines = text.split("\n");
  if (lines.length < 3) {
    return text;
  }

  const compact = [];
  const findNextNonEmpty = (startIndex) => {
    for (let i = Math.max(0, startIndex); i < lines.length; i += 1) {
      if (`${lines[i] ?? ""}`.trim().length > 0) {
        return lines[i];
      }
    }
    return "";
  };

  lines.forEach((line, index) => {
    if (`${line ?? ""}`.trim().length === 0) {
      const prev = compact.length > 0 ? compact[compact.length - 1] : "";
      const next = findNextNonEmpty(index + 1);
      if (isMarkdownTableRow(prev) && isMarkdownTableRow(next)) {
        return;
      }
    }
    compact.push(line);
  });

  return compact.join("\n");
}

function isMarkdownTableSeparatorLine(line) {
  return !!canonicalizeMarkdownTableSeparatorLine(line);
}

function renderFallbackInlineMarkdown(value) {
  let html = escapeHtml(`${value ?? ""}`);
  html = html.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_\n][\s\S]*?)__/g, "<strong>$1</strong>");
  return html;
}

function splitMarkdownTableCells(line) {
  const normalizedRow = canonicalizeMarkdownTableRow(line);
  if (!normalizedRow) {
    return [];
  }

  return normalizedRow
    .slice(1, -1)
    .split("|")
    .map((cell) => renderFallbackInlineMarkdown(`${cell ?? ""}`.trim()));
}

function renderTableAwareFallbackHtml(text) {
  const lines = `${text ?? ""}`.split("\n");
  const chunks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isMarkdownTableRow(line) && i + 1 < lines.length && isMarkdownTableSeparatorLine(lines[i + 1])) {
      const headerCells = splitMarkdownTableCells(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && isMarkdownTableRow(lines[i])) {
        bodyRows.push(splitMarkdownTableCells(lines[i]));
        i += 1;
      }

      if (headerCells.length >= 2) {
        let tableHtml = "<table><thead><tr>";
        headerCells.forEach((cell) => {
          tableHtml += `<th>${cell}</th>`;
        });
        tableHtml += "</tr></thead><tbody>";
        bodyRows.forEach((cells) => {
          tableHtml += "<tr>";
          for (let ci = 0; ci < headerCells.length; ci += 1) {
            tableHtml += `<td>${cells[ci] ?? ""}</td>`;
          }
          tableHtml += "</tr>";
        });
        tableHtml += "</tbody></table>";
        chunks.push(tableHtml);
        continue;
      }
    }

    if (`${line ?? ""}`.trim().length === 0) {
      chunks.push("<br>");
    } else {
      chunks.push(renderFallbackInlineMarkdown(line));
    }
    i += 1;
  }

  return chunks.join("<br>").replace(/(?:<br>){3,}/g, "<br><br>");
}

function normalizeStructuredMarkdownArtifacts(value) {
  let text = `${value ?? ""}`;
  text = text.replace(/(\d+)\.\s*\n+(?=\d)/g, "$1.");
  text = text.replace(
    /(^|\n)(\d+\.)\s*\n+(?=\s*(?:\*\*[^*\n]+:\*\*|[A-Za-z가-힣0-9('‘’][A-Za-z가-힣0-9()'‘’,.&+_/\-·\s]{0,80}:\s))/g,
    "$1$2 "
  );
  text = text.replace(
    /(^|\n)((?:\*\*[^*\n]+:\*\*)|(?:[A-Za-z가-힣0-9('‘’][A-Za-z가-힣0-9()'‘’,.&+_/\-·\s]{0,80}:))\s+\*\*\s+/g,
    "$1$2 "
  );
  text = text.replace(
    /(^|\n)((?:\*\*[^*\n]+:\*\*)|(?:[A-Za-z가-힣0-9('‘’][A-Za-z가-힣0-9()'‘’,.&+_/\-·\s]{0,80}:))\s+\*\*(?=\n|$)/g,
    "$1$2"
  );
  text = text.replace(
    /(^|\n)(?<lead>[-•▪]\s*)?(?<body>\d+[.)]\s*[^\n:*|]+)(?=\n|$)/g,
    (match, prefix, lead, body) => {
      const normalizedLead = `${lead ?? ""}`;
      const normalizedBody = `${body ?? ""}`.trim();
      if (!normalizedBody || /\*\*/.test(normalizedBody)) {
        return `${prefix}${normalizedLead}${normalizedBody}`;
      }

      const headline = normalizedBody.replace(/^\d+[.)]\s*/, "").trim();
      if (!headline
        || headline.length < 2
        || headline.length > 140
        || /[:：|]/.test(headline)
        || /https?:\/\//i.test(headline)
        || /^(출처|요약|핵심)/i.test(headline)
        || /(니다\.|습니다\.|다\.|요\.|[?!.])$/.test(headline)) {
        return `${prefix}${normalizedLead}${normalizedBody}`;
      }

      return `${prefix}${normalizedLead}**${normalizedBody}**`;
    }
  );
  return text;
}

export function normalizeMarkdownSource(value) {
  let text = `${value ?? ""}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLineBreakCount = countMatches(text, /\n/g);

  if (rawLineBreakCount <= 1 && /\\n/.test(text)) {
    text = text
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "  ");
  }

  text = normalizeStructuredMarkdownArtifacts(text);
  text = normalizeMarkdownTableSeparators(text);
  text = normalizeMarkdownTableBlocks(text);
  text = collapseMarkdownTableBlankLines(text);

  const markdownSignalCount =
    countMatches(text, /(^|\s)#{1,6}\s/gm)
    + countMatches(text, /(^|\s)>\s/gm)
    + countMatches(text, /(^|\s)(?:[-*+])\s/gm)
    + countMatches(text, /(^|\s)\d+\.\s/gm)
    + countMatches(text, /```/g)
    + countMatches(text, /\|\s*[-:]{3,}\s*\|/g)
    + countMatches(text, /\[[^\]]+\]\([^)]+\)/g);

  if (countMatches(text, /\n/g) <= 2 && markdownSignalCount >= 2) {
    text = text
      .replace(/\s+(?=#{1,6}\s)/g, "\n")
      .replace(/\s+(?=>\s)/g, "\n")
      .replace(/\s+(?=\d+\.\s)/g, "\n")
      .replace(/\s+(?=[*+-]\s)/g, "\n");

    if (/\|\s*[-:]{3,}\s*\|/.test(text)) {
      text = text
        .replace(/\|\s+\|/g, "|\n|")
        .replace(/\n{3,}/g, "\n\n");
    }
  }

  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/([^\n])\n(?=(#{1,6}\s|[-*+]\s|\d+\.\s|>\s))/g, "$1\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

function createMarkdownRenderer(windowLike) {
  try {
    if (!windowLike || typeof windowLike.markdownit !== "function") {
      return null;
    }

    const renderer = windowLike.markdownit({
      html: false,
      linkify: true,
      breaks: true,
      typographer: false
    });
    if (renderer.linkify && typeof renderer.linkify.set === "function") {
      renderer.linkify.set({
        fuzzyLink: false,
        fuzzyEmail: false,
        fuzzyIP: false
      });
    }

    if (typeof windowLike.markdownitFootnote === "function") {
      renderer.use(windowLike.markdownitFootnote);
    }

    const originalLinkOpen = renderer.renderer.rules.link_open
      || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    renderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      tokens[idx].attrSet("target", "_blank");
      tokens[idx].attrSet("rel", "noopener noreferrer");
      return originalLinkOpen(tokens, idx, options, env, self);
    };

    return renderer;
  } catch (_err) {
    return null;
  }
}

export function createMarkdownSupport({ React, window: windowLike }) {
  const { useEffect, useMemo, useRef } = React;
  const markdownRenderer = createMarkdownRenderer(windowLike);

  function renderMarkdownToSafeHtml(value) {
    const text = normalizeMarkdownSource(value);
    let html = "";

    if (markdownRenderer) {
      html = markdownRenderer.render(text);
      if (hasMarkdownTableBlock(text) && !/<table[\s>]/i.test(html)) {
        html = renderTableAwareFallbackHtml(text);
      }
    } else {
      html = renderTableAwareFallbackHtml(text);
    }

    if (windowLike && windowLike.DOMPurify && typeof windowLike.DOMPurify.sanitize === "function") {
      html = windowLike.DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        ADD_TAGS: ["table", "thead", "tbody", "tr", "th", "td", "img", "hr", "sup", "sub"],
        ADD_ATTR: ["target", "rel", "class", "id"]
      });
    }

    return html;
  }

  function MarkdownBubbleText(props) {
    const hostRef = useRef(null);
    const html = useMemo(() => renderMarkdownToSafeHtml(props && props.text ? props.text : ""), [props && props.text]);

    useEffect(() => {
      if (!hostRef.current) {
        return;
      }

      if (windowLike && typeof windowLike.renderMathInElement === "function") {
        try {
          windowLike.renderMathInElement(hostRef.current, {
            delimiters: [
              { left: "$$", right: "$$", display: true },
              { left: "$", right: "$", display: false },
              { left: "\\(", right: "\\)", display: false },
              { left: "\\[", right: "\\]", display: true }
            ],
            ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
            throwOnError: false,
            strict: "ignore"
          });
        } catch (_err) {
        }
      }
    }, [html]);

    return React.createElement("div", {
      className: "bubble-text markdown",
      ref: hostRef,
      dangerouslySetInnerHTML: { __html: html }
    });
  }

  return {
    MarkdownBubbleText,
    renderMarkdownToSafeHtml
  };
}
