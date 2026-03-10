const MAX_ATTACHMENT_COUNT = 6;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export function hasDraggedFiles(dataTransfer) {
  if (!dataTransfer) {
    return false;
  }

  const types = Array.from(dataTransfer.types || []);
  return (dataTransfer.files && dataTransfer.files.length > 0)
    || types.includes("Files")
    || types.includes("application/x-moz-file");
}

export function parseWebUrls(value) {
  if (!value) {
    return [];
  }

  const seen = new Set();
  return value
    .split(/[\n,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => item.startsWith("http://") || item.startsWith("https://"))
    .filter((item) => {
      if (seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    })
    .slice(0, 3);
}

export function buildRichInputPayload({ inputText = "", attachments = [] } = {}) {
  return {
    attachments,
    webUrls: parseWebUrls(inputText),
    webSearchEnabled: true
  };
}

export function clearAttachmentDraft(prev, key) {
  return { ...prev, [key]: [] };
}

export function formatBytes(size) {
  const numeric = Number(size || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0B";
  }
  if (numeric < 1024) {
    return `${numeric}B`;
  }
  if (numeric < 1024 * 1024) {
    return `${(numeric / 1024).toFixed(1)}KB`;
  }
  return `${(numeric / (1024 * 1024)).toFixed(1)}MB`;
}

export function readFileAsBase64(file, FileReaderCtor = typeof FileReader === "function" ? FileReader : null) {
  return new Promise((resolve, reject) => {
    if (!FileReaderCtor) {
      reject(new Error("FileReader를 사용할 수 없습니다."));
      return;
    }

    const reader = new FileReaderCtor();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const marker = "base64,";
      const idx = result.indexOf(marker);
      const base64 = idx >= 0 ? result.slice(idx + marker.length) : "";
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("파일 읽기 실패"));
    reader.readAsDataURL(file);
  });
}

export async function buildNextAttachments({
  existing = [],
  fileList = [],
  readFileAsBase64Fn = readFileAsBase64,
  onError = () => {}
} = {}) {
  const safeFileList = Array.isArray(fileList) ? fileList : [];
  if (safeFileList.length === 0) {
    return Array.isArray(existing) ? [...existing] : [];
  }

  const next = Array.isArray(existing) ? [...existing] : [];
  for (const file of safeFileList) {
    if (next.length >= MAX_ATTACHMENT_COUNT) {
      onError(`첨부는 최대 ${MAX_ATTACHMENT_COUNT}개까지 가능합니다.`);
      break;
    }

    if ((file.size || 0) > MAX_ATTACHMENT_BYTES) {
      onError(`첨부 파일 크기 제한 초과: ${file.name} (최대 ${formatBytes(MAX_ATTACHMENT_BYTES)})`);
      continue;
    }

    try {
      const base64 = await readFileAsBase64Fn(file);
      if (!base64) {
        onError(`첨부 인코딩 실패: ${file.name}`);
        continue;
      }

      next.push({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: base64,
        sizeBytes: file.size || 0,
        isImage: (file.type || "").startsWith("image/")
      });
    } catch (_err) {
      onError(`첨부 읽기 실패: ${file.name}`);
    }
  }

  return next;
}
