#!/usr/bin/env node

"use strict";

const { spawnSync } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_STDIO_BUFFER = 16 * 1024 * 1024;
const DEFAULT_PERMISSION_MODE = "approve-all";
const DEFAULT_NON_INTERACTIVE_POLICY = "deny";

function toOptionalTrimmedString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function toBoolean(value) {
  return value === true;
}

function resolveTimeoutMs(payload) {
  const envRaw = toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_ACPX_TIMEOUT_MS);
  if (envRaw) {
    const parsedEnv = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsedEnv) && parsedEnv > 0) {
      return Math.min(Math.max(parsedEnv, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
    }
  }

  const runTimeoutSeconds = Number(payload && payload.runTimeoutSeconds);
  if (Number.isFinite(runTimeoutSeconds) && runTimeoutSeconds > 0) {
    const converted = Math.trunc(runTimeoutSeconds * 1000);
    return Math.min(Math.max(converted, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  }

  return DEFAULT_TIMEOUT_MS;
}

function parseJsonLines(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const parsed = [];
  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsed.push(json);
      }
    } catch {
      // ignore non-JSON output lines
    }
  }
  return parsed;
}

function toOptionalBoolean(value) {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return null;
}

function normalizeSingleLine(value, maxChars) {
  const normalized = String(value || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  const cap = Number.isFinite(maxChars) ? Math.max(16, Math.trunc(maxChars)) : 240;
  if (normalized.length <= cap) {
    return normalized;
  }
  return normalized.slice(0, cap).trimEnd() + "...";
}

function resolveRuntimeOptionString(options, payload, key) {
  const fromOptions = toOptionalTrimmedString(options[key]);
  if (fromOptions) {
    return fromOptions;
  }
  return toOptionalTrimmedString(payload[key]);
}

function resolveRuntimeOptionBoolean(options, payload, key) {
  if (Object.prototype.hasOwnProperty.call(options, key)) {
    return toOptionalBoolean(options[key]);
  }
  return toOptionalBoolean(payload[key]);
}

function toReasoningEffortValue(thinkingValue) {
  const normalized = toOptionalTrimmedString(thinkingValue);
  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();
  if (lowered === "low" || lowered === "medium" || lowered === "high" || lowered === "xhigh") {
    return lowered;
  }

  return null;
}

function resolveRuntimeOptions(payload) {
  const options = (
    payload &&
    payload.options &&
    typeof payload.options === "object" &&
    !Array.isArray(payload.options)
  )
    ? payload.options
    : {};

  return {
    model: resolveRuntimeOptionString(options, payload, "model"),
    thinking: resolveRuntimeOptionString(options, payload, "thinking"),
    lightContext: resolveRuntimeOptionBoolean(options, payload, "lightContext")
  };
}

function resolveMode(payload) {
  const mode = toOptionalTrimmedString(payload && payload.mode);
  if (mode === "session") {
    return "session";
  }
  return "run";
}

function extractBackendSessionId(events) {
  for (const event of events) {
    const backendSessionId = toOptionalTrimmedString(event.backendSessionId);
    if (backendSessionId) {
      return backendSessionId;
    }
    const acpxSessionId = toOptionalTrimmedString(event.acpxSessionId);
    if (acpxSessionId) {
      return acpxSessionId;
    }
  }
  return null;
}

function extractAgentSessionId(events) {
  for (const event of events) {
    const agentSessionId = toOptionalTrimmedString(event.agentSessionId);
    if (agentSessionId) {
      return agentSessionId;
    }
  }
  return null;
}

function extractAcpxRecordId(events) {
  for (const event of events) {
    const acpxRecordId = toOptionalTrimmedString(event.acpxRecordId);
    if (acpxRecordId) {
      return acpxRecordId;
    }
  }
  return null;
}

function extractPromptRequestId(events) {
  for (const event of events) {
    const action = toOptionalTrimmedString(event.action);
    if (action === "prompt_queued") {
      const requestId = toOptionalTrimmedString(event.requestId);
      if (requestId) {
        return requestId;
      }
    }
  }
  return null;
}

function extractPromptStopReason(events) {
  for (const event of events) {
    const stopReason = toOptionalTrimmedString(event.stopReason);
    if (stopReason) {
      return stopReason;
    }
    if (
      event.result &&
      typeof event.result === "object" &&
      !Array.isArray(event.result)
    ) {
      const nestedStopReason = toOptionalTrimmedString(event.result.stopReason);
      if (nestedStopReason) {
        return nestedStopReason;
      }
    }
  }
  return null;
}

function extractPromptError(events) {
  for (const event of events) {
    if (toOptionalTrimmedString(event.type) !== "error") {
      continue;
    }
    const message = toOptionalTrimmedString(event.message) || "acpx prompt event reported error";
    const code = toOptionalTrimmedString(event.code);
    return code ? `${code}: ${message}` : message;
  }
  return null;
}

function extractJsonRpcError(events) {
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const nested = event.error;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      continue;
    }
    const message =
      toOptionalTrimmedString(nested.message) ||
      "acpx command returned json-rpc error";
    const code = toOptionalTrimmedString(nested.code);
    const data = normalizeSingleLine(nested.data, 240);
    const base = code ? `${code}: ${message}` : message;
    return data ? `${base} (${data})` : base;
  }
  return null;
}

function resolveConfigOptionId(rawOption) {
  if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
    return null;
  }
  return (
    toOptionalTrimmedString(rawOption.id) ||
    toOptionalTrimmedString(rawOption.optionId) ||
    toOptionalTrimmedString(rawOption.option_id) ||
    toOptionalTrimmedString(rawOption.key) ||
    null
  );
}

function resolveConfigOptionMetadata(rawOption) {
  if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
    return {
      name: null,
      description: null,
      category: null
    };
  }
  return {
    name:
      toOptionalTrimmedString(rawOption.name) ||
      toOptionalTrimmedString(rawOption.label) ||
      toOptionalTrimmedString(rawOption.title) ||
      null,
    description:
      toOptionalTrimmedString(rawOption.description) ||
      toOptionalTrimmedString(rawOption.help) ||
      toOptionalTrimmedString(rawOption.summary) ||
      null,
    category:
      toOptionalTrimmedString(rawOption.category) ||
      toOptionalTrimmedString(rawOption.group) ||
      toOptionalTrimmedString(rawOption.section) ||
      null
  };
}

function listRawConfigOptionCandidates(rawObject) {
  const candidates = [];
  if (!rawObject || typeof rawObject !== "object" || Array.isArray(rawObject)) {
    return candidates;
  }

  if (Array.isArray(rawObject.configOptions)) {
    candidates.push(...rawObject.configOptions);
  }
  if (Array.isArray(rawObject.config_options)) {
    candidates.push(...rawObject.config_options);
  }

  const optionId = resolveConfigOptionId(rawObject);
  const hasOptionShape =
    Array.isArray(rawObject.options) ||
    Array.isArray(rawObject.values) ||
    Array.isArray(rawObject.choices) ||
    Object.prototype.hasOwnProperty.call(rawObject, "currentValue") ||
    Object.prototype.hasOwnProperty.call(rawObject, "current_value");
  if (optionId && hasOptionShape) {
    candidates.push(rawObject);
  }

  return candidates;
}

function collectRawConfigOptionsFromObject(rawObject, sink, visited) {
  if (!rawObject || typeof rawObject !== "object") {
    return;
  }
  if (visited.has(rawObject)) {
    return;
  }
  visited.add(rawObject);

  if (Array.isArray(rawObject)) {
    for (const entry of rawObject) {
      collectRawConfigOptionsFromObject(entry, sink, visited);
    }
    return;
  }

  for (const option of listRawConfigOptionCandidates(rawObject)) {
    if (option && typeof option === "object") {
      sink.push(option);
    }
  }

  for (const value of Object.values(rawObject)) {
    collectRawConfigOptionsFromObject(value, sink, visited);
  }
}

function resolveConfigOptionKeyHint(rawKey) {
  if (typeof rawKey === "string") {
    return toOptionalTrimmedString(rawKey);
  }
  return resolveConfigOptionId(rawKey);
}

function collectConfigOptionKeysFromObject(rawObject, sink, visited) {
  if (!rawObject || typeof rawObject !== "object") {
    return;
  }
  if (visited.has(rawObject)) {
    return;
  }
  visited.add(rawObject);

  if (Array.isArray(rawObject)) {
    for (const entry of rawObject) {
      collectConfigOptionKeysFromObject(entry, sink, visited);
    }
    return;
  }

  const keyCollections = [
    rawObject.configOptionKeys,
    rawObject.config_option_keys,
    rawObject.configOptionIds,
    rawObject.config_option_ids
  ];
  for (const keyCollection of keyCollections) {
    if (!Array.isArray(keyCollection)) {
      continue;
    }
    for (const rawKey of keyCollection) {
      const normalizedKey = resolveConfigOptionKeyHint(rawKey);
      if (normalizedKey) {
        sink.add(normalizedKey);
      }
    }
  }

  for (const value of Object.values(rawObject)) {
    collectConfigOptionKeysFromObject(value, sink, visited);
  }
}

function upsertExtractedConfigOption(optionMap, rawOption) {
  if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
    return;
  }
  const id = resolveConfigOptionId(rawOption);
  if (!id) {
    return;
  }
  const normalizedId = id.toLowerCase();
  const existing = optionMap.get(normalizedId);
  const type = toOptionalTrimmedString(rawOption.type) || toOptionalTrimmedString(rawOption.kind);
  const metadata = resolveConfigOptionMetadata(rawOption);
  const values = new Set();
  const valueOptions = Array.isArray(rawOption.options)
    ? rawOption.options
    : Array.isArray(rawOption.choices)
      ? rawOption.choices
      : [];
  for (const rawValueOption of valueOptions) {
    if (!rawValueOption || typeof rawValueOption !== "object" || Array.isArray(rawValueOption)) {
      continue;
    }
    const optionValue =
      toOptionalTrimmedString(rawValueOption.value) ||
      toOptionalTrimmedString(rawValueOption.id);
    if (optionValue) {
      values.add(optionValue);
    }
  }
  const directValues = Array.isArray(rawOption.values)
    ? rawOption.values
    : Array.isArray(rawOption.allowedValues)
      ? rawOption.allowedValues
      : [];
  for (const rawDirectValue of directValues) {
    if (typeof rawDirectValue === "string") {
      const normalizedValue = toOptionalTrimmedString(rawDirectValue);
      if (normalizedValue) {
        values.add(normalizedValue);
      }
      continue;
    }
    if (!rawDirectValue || typeof rawDirectValue !== "object" || Array.isArray(rawDirectValue)) {
      continue;
    }
    const nestedValue = toOptionalTrimmedString(rawDirectValue.value);
    if (nestedValue) {
      values.add(nestedValue);
    }
  }
  const currentValue =
    toOptionalTrimmedString(rawOption.currentValue) ||
    toOptionalTrimmedString(rawOption.current_value);
  if (currentValue) {
    values.add(currentValue);
  }

  if (!existing) {
    optionMap.set(normalizedId, {
      id,
      type: type || null,
      name: metadata.name,
      description: metadata.description,
      category: metadata.category,
      values: [...values]
    });
    return;
  }

  const mergedValues = new Set(existing.values || []);
  for (const value of values) {
    mergedValues.add(value);
  }
  optionMap.set(normalizedId, {
    id: existing.id || id,
    type: existing.type || type || null,
    name: existing.name || metadata.name || null,
    description: existing.description || metadata.description || null,
    category: existing.category || metadata.category || null,
    values: [...mergedValues]
  });
}

function extractConfigOptions(events) {
  const optionMap = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const rawOptions = [];
    collectRawConfigOptionsFromObject(event, rawOptions, new Set());
    for (const option of rawOptions) {
      upsertExtractedConfigOption(optionMap, option);
    }

    const configOptionKeys = new Set();
    collectConfigOptionKeysFromObject(event, configOptionKeys, new Set());
    for (const configOptionKey of configOptionKeys) {
      upsertExtractedConfigOption(optionMap, {
        id: configOptionKey,
        type: null,
        values: []
      });
    }
  }
  return [...optionMap.values()];
}

function mergeDiscoveredConfigOptions(targetMap, options) {
  for (const option of options || []) {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      continue;
    }
    const id = toOptionalTrimmedString(option.id);
    if (!id) {
      continue;
    }
    const normalizedId = id.toLowerCase();
    const existing = targetMap.get(normalizedId);
    const nextValues = new Set(Array.isArray(option.values) ? option.values : []);
    if (!existing) {
      targetMap.set(normalizedId, {
        id,
        type: toOptionalTrimmedString(option.type),
        name: toOptionalTrimmedString(option.name),
        description: toOptionalTrimmedString(option.description),
        category: toOptionalTrimmedString(option.category),
        values: [...nextValues]
      });
      continue;
    }
    const mergedValues = new Set(existing.values || []);
    for (const value of nextValues) {
      mergedValues.add(value);
    }
    targetMap.set(normalizedId, {
      id: existing.id || id,
      type: existing.type || toOptionalTrimmedString(option.type),
      name: existing.name || toOptionalTrimmedString(option.name),
      description: existing.description || toOptionalTrimmedString(option.description),
      category: existing.category || toOptionalTrimmedString(option.category),
      values: [...mergedValues]
    });
  }
}

function mergeDiscoveredConfigOptionMap(targetMap, sourceMap) {
  if (!(sourceMap instanceof Map)) {
    return;
  }
  mergeDiscoveredConfigOptions(targetMap, [...sourceMap.values()]);
}

function listDiscoveredConfigOptionIds(discoveredOptions) {
  return [...discoveredOptions.values()]
    .map((option) => option.id)
    .filter((id) => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

function listDiscoveredConfigOptions(discoveredOptions) {
  return [...discoveredOptions.values()]
    .map((option) => {
      const id = toOptionalTrimmedString(option && option.id);
      if (!id) {
        return null;
      }
      const values = [...new Set(Array.isArray(option.values) ? option.values : [])]
        .map((value) => toOptionalTrimmedString(value))
        .filter((value) => typeof value === "string" && value.length > 0)
        .sort((a, b) => a.localeCompare(b));
      return {
        id,
        type: toOptionalTrimmedString(option.type),
        name: toOptionalTrimmedString(option.name),
        description: toOptionalTrimmedString(option.description),
        category: toOptionalTrimmedString(option.category),
        values
      };
    })
    .filter((option) => option !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function parseSetConfigCandidates(rawText) {
  const tokens = String(rawText || "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const candidates = [];
  for (const token of tokens) {
    const index = token.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = toOptionalTrimmedString(token.slice(0, index));
    const value = toOptionalTrimmedString(token.slice(index + 1));
    if (!key || !value) {
      continue;
    }
    candidates.push({ key, value });
  }
  return candidates;
}

function normalizeSupportedOptionKey(rawKey) {
  const trimmed = toOptionalTrimmedString(rawKey);
  if (!trimmed) {
    return null;
  }
  const withoutLeading = trimmed.replace(/^[\["'`({\s]+/, "");
  const withoutTrailing = withoutLeading.replace(/[\]"'`)}\s.;:]+$/g, "");
  return toOptionalTrimmedString(withoutTrailing);
}

function parseSupportedOptionKeys(rawText) {
  const normalized = toOptionalTrimmedString(rawText);
  if (!normalized) {
    return [];
  }
  const matched = normalized.match(/supported\s*=\s*([^\n\r]+)/i);
  if (!matched) {
    return [];
  }
  const rawSegment = toOptionalTrimmedString(matched[1]);
  if (!rawSegment) {
    return [];
  }
  const sanitizedSegment = rawSegment.replace(/^[\[(\s]+/, "");
  if (!sanitizedSegment) {
    return [];
  }
  const deduped = new Map();
  const keys = [];
  for (const token of sanitizedSegment.split(",")) {
    const key = normalizeSupportedOptionKey(token);
    if (!key) {
      continue;
    }
    const keyLower = key.toLowerCase();
    if (deduped.has(keyLower)) {
      continue;
    }
    deduped.set(keyLower, key);
    keys.push(key);
  }
  return keys;
}

function resolveLightContextEnvCandidates(lightContextValue) {
  const envName = lightContextValue
    ? "OMNINODE_ACP_ADAPTER_ACPX_LIGHT_CONTEXT_TRUE_CANDIDATES"
    : "OMNINODE_ACP_ADAPTER_ACPX_LIGHT_CONTEXT_FALSE_CANDIDATES";
  return parseSetConfigCandidates(process.env[envName]);
}

function toOptionKeyTokenized(rawId) {
  return String(rawId || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toOptionKeyFlat(rawId) {
  return toOptionKeyTokenized(rawId).replace(/_/g, "");
}

function isCandidateKeySupported(candidateKey, supportedKeyHints) {
  const normalizedCandidate = toOptionalTrimmedString(candidateKey);
  if (!normalizedCandidate || supportedKeyHints.size === 0) {
    return false;
  }
  const candidateLower = normalizedCandidate.toLowerCase();
  const candidateTokenized = toOptionKeyTokenized(normalizedCandidate);
  const candidateFlat = toOptionKeyFlat(normalizedCandidate);
  for (const rawHint of supportedKeyHints) {
    const normalizedHint = normalizeSupportedOptionKey(rawHint);
    if (!normalizedHint) {
      continue;
    }
    const hintLower = normalizedHint.toLowerCase();
    if (candidateLower === hintLower) {
      return true;
    }
    if (candidateTokenized && candidateTokenized === toOptionKeyTokenized(normalizedHint)) {
      return true;
    }
    if (candidateFlat && candidateFlat === toOptionKeyFlat(normalizedHint)) {
      return true;
    }
  }
  return false;
}

function looksLikeLightContextOptionId(rawId) {
  const normalized = toOptionKeyTokenized(rawId);
  if (!normalized) {
    return false;
  }
  const flattened = toOptionKeyFlat(rawId);
  return (
    normalized.includes("light_context") ||
    normalized.includes("bootstrap_context") ||
    normalized.includes("bootstrap_mode") ||
    normalized.includes("context_mode") ||
    normalized.includes("context_profile") ||
    normalized.includes("context_window") ||
    flattened.includes("lightcontext") ||
    flattened.includes("bootstrapcontextmode") ||
    flattened.includes("contextmode") ||
    (normalized.includes("context") && normalized.includes("light")) ||
    (normalized.includes("context") && normalized.includes("profile"))
  );
}

function looksLikeLightContextHintText(rawText) {
  const normalized = toOptionKeyTokenized(rawText);
  if (!normalized) {
    return false;
  }
  const flattened = toOptionKeyFlat(rawText);
  return (
    normalized.includes("light_context") ||
    normalized.includes("bootstrap_context") ||
    normalized.includes("bootstrap_mode") ||
    normalized.includes("context_mode") ||
    normalized.includes("context_profile") ||
    normalized.includes("context_window") ||
    flattened.includes("lightcontext") ||
    flattened.includes("bootstrapcontextmode") ||
    flattened.includes("contextmode") ||
    (normalized.includes("context") && normalized.includes("light")) ||
    (normalized.includes("context") && normalized.includes("profile"))
  );
}

function listOptionHintTexts(option) {
  return [
    toOptionalTrimmedString(option && option.id),
    toOptionalTrimmedString(option && option.name),
    toOptionalTrimmedString(option && option.description),
    toOptionalTrimmedString(option && option.category)
  ].filter((value) => typeof value === "string" && value.length > 0);
}

const LIGHT_CONTEXT_TRUE_VALUE_PREFERENCES = [
  "lightweight",
  "light",
  "lite",
  "minimal",
  "compact",
  "lean",
  "brief",
  "short",
  "reduced",
  "true",
  "on",
  "enabled"
];

const LIGHT_CONTEXT_FALSE_VALUE_PREFERENCES = [
  "default",
  "full",
  "standard",
  "normal",
  "balanced",
  "complete",
  "rich",
  "false",
  "off",
  "disabled"
];

const LIGHT_CONTEXT_APPROVAL_MODE_TRUE_VALUE_PREFERENCES = [
  "read-only",
  "readonly",
  "auto",
  "full-access",
  "fullaccess"
];

const LIGHT_CONTEXT_APPROVAL_MODE_FALSE_VALUE_PREFERENCES = [
  "auto",
  "full-access",
  "fullaccess",
  "read-only",
  "readonly"
];

function listNormalizedOptionValues(values) {
  const normalizedValues = [];
  const seenValues = new Set();
  for (const value of values || []) {
    const normalizedValue = toOptionalTrimmedString(value);
    if (!normalizedValue) {
      continue;
    }
    const lowered = normalizedValue.toLowerCase();
    if (seenValues.has(lowered)) {
      continue;
    }
    seenValues.add(lowered);
    normalizedValues.push({
      raw: normalizedValue,
      lowered,
      tokenized: toOptionKeyTokenized(normalizedValue),
      flat: toOptionKeyFlat(normalizedValue)
    });
  }
  return normalizedValues;
}

function matchPreferredOptionValue(normalizedValues, token, allowPrefixMatch) {
  const normalizedToken = toOptionalTrimmedString(token);
  if (!normalizedToken) {
    return null;
  }
  const loweredToken = normalizedToken.toLowerCase();
  const tokenizedToken = toOptionKeyTokenized(normalizedToken);
  const flatToken = toOptionKeyFlat(normalizedToken);
  for (const entry of normalizedValues) {
    if (entry.lowered === loweredToken) {
      return entry.raw;
    }
    if (tokenizedToken && entry.tokenized === tokenizedToken) {
      return entry.raw;
    }
    if (flatToken && entry.flat === flatToken) {
      return entry.raw;
    }
    if (
      allowPrefixMatch &&
      tokenizedToken &&
      tokenizedToken.length >= 4 &&
      entry.tokenized &&
      entry.tokenized.startsWith(`${tokenizedToken}_`)
    ) {
      return entry.raw;
    }
    if (
      allowPrefixMatch &&
      flatToken &&
      flatToken.length >= 4 &&
      entry.flat &&
      entry.flat.startsWith(flatToken)
    ) {
      return entry.raw;
    }
  }
  return null;
}

function listPreferredValuesFromOptionValues(values, lightContextValue) {
  const normalizedValues = listNormalizedOptionValues(values);
  const targetList = lightContextValue
    ? LIGHT_CONTEXT_TRUE_VALUE_PREFERENCES
    : LIGHT_CONTEXT_FALSE_VALUE_PREFERENCES;
  const preferred = [];
  const seen = new Set();
  for (const token of targetList) {
    const matched = matchPreferredOptionValue(normalizedValues, token, true);
    if (matched) {
      const lowered = matched.toLowerCase();
      if (!seen.has(lowered)) {
        seen.add(lowered);
        preferred.push(matched);
      }
    }
  }

  for (const entry of normalizedValues) {
    if (!seen.has(entry.lowered)) {
      seen.add(entry.lowered);
      preferred.push(entry.raw);
    }
  }

  return preferred;
}

function listFallbackExplicitLightContextValues(lightContextValue) {
  const preferred = lightContextValue
    ? LIGHT_CONTEXT_TRUE_VALUE_PREFERENCES
    : LIGHT_CONTEXT_FALSE_VALUE_PREFERENCES;
  return preferred.slice(0, 4);
}

function isApprovalPresetModeOption(option) {
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    return false;
  }
  if (toOptionKeyTokenized(option.id) !== "mode") {
    return false;
  }

  const normalizedValues = listNormalizedOptionValues(option.values || []);
  if (normalizedValues.length === 0) {
    return false;
  }

  let hasAuto = false;
  let hasReadOnly = false;
  let hasFullAccess = false;
  for (const entry of normalizedValues) {
    if (entry.tokenized === "auto" || entry.flat === "auto") {
      hasAuto = true;
    }
    if (entry.tokenized === "read_only" || entry.flat === "readonly") {
      hasReadOnly = true;
    }
    if (entry.tokenized === "full_access" || entry.flat === "fullaccess") {
      hasFullAccess = true;
    }
  }
  if ((hasAuto && hasReadOnly) || (hasAuto && hasFullAccess) || (hasReadOnly && hasFullAccess)) {
    return true;
  }

  const hasApprovalHint = listOptionHintTexts(option).some((hintText) => {
    const normalized = toOptionKeyTokenized(hintText);
    return (
      normalized.includes("approval") ||
      normalized.includes("sandbox") ||
      normalized.includes("permission")
    );
  });
  return hasApprovalHint && (hasAuto || hasReadOnly || hasFullAccess);
}

function listPreferredValuesFromApprovalPresetModeOption(values, lightContextValue) {
  const normalizedValues = listNormalizedOptionValues(values);
  const targetList = lightContextValue
    ? LIGHT_CONTEXT_APPROVAL_MODE_TRUE_VALUE_PREFERENCES
    : LIGHT_CONTEXT_APPROVAL_MODE_FALSE_VALUE_PREFERENCES;
  const preferred = [];
  const seen = new Set();

  for (const token of targetList) {
    const matched = matchPreferredOptionValue(normalizedValues, token, true);
    if (!matched) {
      continue;
    }
    const lowered = matched.toLowerCase();
    if (seen.has(lowered)) {
      continue;
    }
    seen.add(lowered);
    preferred.push(matched);
  }

  for (const entry of normalizedValues) {
    if (seen.has(entry.lowered)) {
      continue;
    }
    seen.add(entry.lowered);
    preferred.push(entry.raw);
  }

  return preferred;
}

function inferLightContextCandidatesFromApprovalPresetMode(discoveredOptions, lightContextValue) {
  const modeOption = discoveredOptions.get("mode");
  if (!isApprovalPresetModeOption(modeOption)) {
    return [];
  }
  const modeKey = toOptionalTrimmedString(modeOption.id) || "mode";
  const modeValues = listPreferredValuesFromApprovalPresetModeOption(
    modeOption.values,
    lightContextValue
  );
  return modeValues.map((modeValue) => ({
    key: modeKey,
    value: modeValue
  }));
}

function upsertLightContextCompatibilityOption(discoveredOptions) {
  const modeOption = discoveredOptions.get("mode");
  if (!isApprovalPresetModeOption(modeOption)) {
    return false;
  }
  mergeDiscoveredConfigOptions(discoveredOptions, [
    {
      id: "lightContext",
      type: "boolean",
      name: "Light Context",
      description: "Compatibility projection mapped to mode approval preset",
      category: "runtime",
      values: ["true", "false"]
    }
  ]);
  return true;
}

function inferLightContextCandidatesFromDiscoveredOptions(discoveredOptions, lightContextValue) {
  const candidates = [];
  for (const option of discoveredOptions.values()) {
    const normalizedOptionId = toOptionKeyTokenized(option.id);
    const explicitContextKey = looksLikeLightContextOptionId(option.id);
    const contextHintFromMetadata = listOptionHintTexts(option).some((entry) =>
      looksLikeLightContextHintText(entry)
    );
    const genericModeKey =
      normalizedOptionId === "mode" ||
      normalizedOptionId === "profile" ||
      normalizedOptionId.endsWith("_mode");
    const contextLikeOption = explicitContextKey || (genericModeKey && contextHintFromMetadata);
    if (!contextLikeOption) {
      continue;
    }
    const inferredValues = listPreferredValuesFromOptionValues(option.values, lightContextValue);
    if (
      inferredValues.length === 0 &&
      contextLikeOption &&
      toOptionalTrimmedString(option.type) === "boolean"
    ) {
      inferredValues.push(lightContextValue ? "true" : "false");
    }
    if (
      inferredValues.length === 0 &&
      contextLikeOption &&
      toOptionalTrimmedString(option.type) !== "boolean"
    ) {
      inferredValues.push(...listFallbackExplicitLightContextValues(lightContextValue));
    }
    if (inferredValues.length === 0) {
      continue;
    }
    for (const inferredValue of inferredValues) {
      candidates.push({
        key: option.id,
        value: inferredValue
      });
    }
  }
  return candidates;
}

function dedupeSetConfigCandidates(candidates) {
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const key = toOptionalTrimmedString(candidate.key);
    const value = toOptionalTrimmedString(candidate.value);
    if (!key || !value) {
      continue;
    }
    const signature = `${key}\u0000${value}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push({ key, value });
  }
  return deduped;
}

function prioritizeSetConfigCandidates(candidates, discoveredOptions) {
  const supportedKeys = new Set();
  for (const option of discoveredOptions.values()) {
    const optionId = toOptionalTrimmedString(option.id);
    if (optionId) {
      supportedKeys.add(optionId.toLowerCase());
    }
  }
  if (supportedKeys.size === 0) {
    return candidates;
  }

  const prioritized = [];
  const deferred = [];
  for (const candidate of candidates) {
    const normalizedKey = toOptionalTrimmedString(candidate.key);
    if (normalizedKey && supportedKeys.has(normalizedKey.toLowerCase())) {
      prioritized.push(candidate);
    } else {
      deferred.push(candidate);
    }
  }
  return [...prioritized, ...deferred];
}

function buildLightContextCandidates(discoveredOptions, lightContextValue) {
  const envCandidates = resolveLightContextEnvCandidates(lightContextValue);
  const inferredCandidates = inferLightContextCandidatesFromDiscoveredOptions(
    discoveredOptions,
    lightContextValue
  );
  const approvalModeCompatibilityCandidates = inferLightContextCandidatesFromApprovalPresetMode(
    discoveredOptions,
    lightContextValue
  );
  const fallbackCandidates = lightContextValue
    ? [
        { key: "bootstrapContextMode", value: "lightweight" },
        { key: "bootstrapMode", value: "lightweight" },
        { key: "bootstrap_context_mode", value: "lightweight" },
        { key: "bootstrap-context-mode", value: "lightweight" },
        { key: "lightContext", value: "true" },
        { key: "light-context", value: "true" },
        { key: "contextMode", value: "lightweight" },
        { key: "contextProfile", value: "lightweight" },
        { key: "bootstrap_mode", value: "lightweight" },
        { key: "context_mode", value: "lightweight" },
        { key: "context-mode", value: "lightweight" },
        { key: "light_context", value: "true" }
      ]
    : [
        { key: "bootstrapContextMode", value: "default" },
        { key: "bootstrapMode", value: "default" },
        { key: "bootstrap_context_mode", value: "default" },
        { key: "bootstrap-context-mode", value: "default" },
        { key: "lightContext", value: "false" },
        { key: "light-context", value: "false" },
        { key: "contextMode", value: "default" },
        { key: "contextProfile", value: "default" },
        { key: "bootstrap_mode", value: "default" },
        { key: "context_mode", value: "default" },
        { key: "context-mode", value: "default" },
        { key: "light_context", value: "false" }
      ];
  const deduped = dedupeSetConfigCandidates([
    ...envCandidates,
    ...inferredCandidates,
    ...approvalModeCompatibilityCandidates,
    ...fallbackCandidates
  ]);
  return prioritizeSetConfigCandidates(deduped, discoveredOptions);
}

function resolvePermissionFlag() {
  const mode = toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_ACPX_PERMISSION_MODE) || DEFAULT_PERMISSION_MODE;
  switch (mode) {
    case "approve-all":
    case "--approve-all":
      return "--approve-all";
    case "approve-reads":
    case "--approve-reads":
      return "--approve-reads";
    case "deny-all":
    case "--deny-all":
      return "--deny-all";
    default:
      return "--approve-all";
  }
}

function resolveNonInteractivePolicy() {
  const policy = toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_ACPX_NON_INTERACTIVE_PERMISSIONS) || DEFAULT_NON_INTERACTIVE_POLICY;
  return policy === "fail" ? "fail" : "deny";
}

function resolvePromptTimeoutSeconds(timeoutMs) {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function resolveTtlSeconds() {
  const raw = toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_ACPX_TTL_SECONDS);
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return String(parsed);
}

function buildPromptArgs(params) {
  const args = [
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    params.acpxCwd,
    resolvePermissionFlag(),
    "--non-interactive-permissions",
    resolveNonInteractivePolicy(),
    "--timeout",
    String(resolvePromptTimeoutSeconds(params.timeoutMs))
  ];
  const ttlSeconds = resolveTtlSeconds();
  if (ttlSeconds) {
    args.push("--ttl", ttlSeconds);
  }
  args.push(params.agent, "prompt", "--session", params.childSessionKey);
  if (params.noWait) {
    args.push("--no-wait");
  }
  args.push("--file", "-");
  return args;
}

function runAcpxCommand(command, args, options) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: MAX_STDIO_BUFFER,
    input: options.inputText || undefined
  });
}

function buildSetConfigArgs(params) {
  return [
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    params.acpxCwd,
    params.agent,
    "set",
    params.key,
    params.value,
    "--session",
    params.childSessionKey
  ];
}

function resolveProcessFailureError(runResult, stdout, stderr) {
  if (runResult.error) {
    const err = runResult.error;
    return err && err.message ? err.message : String(err);
  }
  return (
    toOptionalTrimmedString(stderr) ||
    toOptionalTrimmedString(stdout) ||
    `acpx exited with code ${String(runResult.status)}`
  );
}

function applySetConfigOption(params) {
  const setArgs = buildSetConfigArgs(params);
  const setRun = runAcpxCommand(params.acpxCommand, setArgs, {
    timeoutMs: params.timeoutMs
  });
  const stdout = String(setRun.stdout || "");
  const stderr = String(setRun.stderr || "");
  const events = parseJsonLines(stdout);
  const configOptions = extractConfigOptions(events);
  const eventError = extractPromptError(events) || extractJsonRpcError(events);
  if (setRun.error || (setRun.status || 0) !== 0 || eventError) {
    return {
      ok: false,
      error: eventError || resolveProcessFailureError(setRun, stdout, stderr),
      configOptions
    };
  }

  return { ok: true, configOptions };
}

function listSupportedKeyHints(supportedKeyHints) {
  const deduped = new Map();
  for (const rawHint of supportedKeyHints) {
    const hint = normalizeSupportedOptionKey(rawHint);
    if (!hint) {
      continue;
    }
    const key = hint.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, hint);
    }
  }
  return [...deduped.values()].sort((a, b) => a.localeCompare(b));
}

function applyCandidateSetConfigOption(params) {
  const attempts = [];
  const discoveredConfigOptions = new Map();
  const supportedKeyHints = new Set();
  let enforceSupportedKeys = false;
  for (const option of params.initialDiscoveredConfigOptions || []) {
    const optionId = toOptionalTrimmedString(option && option.id);
    if (optionId) {
      supportedKeyHints.add(optionId);
    }
  }
  if (toBoolean(params.enforceInitialSupportedKeys) && supportedKeyHints.size > 0) {
    enforceSupportedKeys = true;
  }

  let candidates = params.candidates;
  if (enforceSupportedKeys && supportedKeyHints.size > 0) {
    const supportedCandidates = [];
    let skippedCount = 0;
    for (const candidate of params.candidates) {
      const normalizedCandidateKey = toOptionalTrimmedString(candidate && candidate.key);
      if (isCandidateKeySupported(normalizedCandidateKey, supportedKeyHints)) {
        supportedCandidates.push(candidate);
      } else {
        skippedCount += 1;
      }
    }
    const supportedList = listSupportedKeyHints(supportedKeyHints);
    if (skippedCount > 0) {
      attempts.push(
        `prefilter skipped ${String(skippedCount)} unsupported candidate(s); supported=${supportedList.join(", ")}`
      );
    }
    if (supportedCandidates.length === 0) {
      const error = "no compatible advertised config key for requested runtime option";
      attempts.push(`${error}; supported=${supportedList.join(", ")}`);
      return {
        ok: false,
        error,
        attempts,
        discoveredConfigOptionIds: listDiscoveredConfigOptionIds(discoveredConfigOptions),
        discoveredConfigOptions
      };
    }
    candidates = supportedCandidates;
  }

  for (const candidate of candidates) {
    const normalizedCandidateKey = toOptionalTrimmedString(candidate.key);
    if (
      enforceSupportedKeys &&
      normalizedCandidateKey &&
      supportedKeyHints.size > 0 &&
      !isCandidateKeySupported(normalizedCandidateKey, supportedKeyHints)
    ) {
      const supportedList = listSupportedKeyHints(supportedKeyHints);
      attempts.push(
        `${candidate.key}=${candidate.value}: skipped (unsupported key; supported=${supportedList.join(", ")})`
      );
      continue;
    }

    const applied = applySetConfigOption({
      acpxCommand: params.acpxCommand,
      acpxCwd: params.acpxCwd,
      agent: params.agent,
      childSessionKey: params.childSessionKey,
      timeoutMs: params.timeoutMs,
      key: candidate.key,
      value: candidate.value
    });
    mergeDiscoveredConfigOptions(discoveredConfigOptions, applied.configOptions);
    for (const discoveredOptionId of listDiscoveredConfigOptionIds(discoveredConfigOptions)) {
      supportedKeyHints.add(discoveredOptionId);
    }

    if (applied.ok) {
      return {
        ok: true,
        key: candidate.key,
        value: candidate.value,
        attempts,
        discoveredConfigOptionIds: listDiscoveredConfigOptionIds(discoveredConfigOptions),
        discoveredConfigOptions
      };
    }

    for (const supportedOptionKey of parseSupportedOptionKeys(applied.error)) {
      supportedKeyHints.add(supportedOptionKey);
    }
    if (supportedKeyHints.size > 0) {
      enforceSupportedKeys = true;
    }

    attempts.push(`${candidate.key}=${candidate.value}: ${normalizeSingleLine(applied.error, 160)}`);
  }

  return {
    ok: false,
    error: attempts[attempts.length - 1] || "unknown set option failure",
    attempts,
    discoveredConfigOptionIds: listDiscoveredConfigOptionIds(discoveredConfigOptions),
    discoveredConfigOptions
  };
}

function applyRuntimeOptions(params) {
  const applied = [];
  const warnings = [];
  const discoveredConfigOptions = new Map();
  mergeDiscoveredConfigOptions(discoveredConfigOptions, params.initialDiscoveredConfigOptions);
  upsertLightContextCompatibilityOption(discoveredConfigOptions);
  const lightContextCandidatesTried = [];
  const lightContextAttemptLog = [];

  if (params.options.model) {
    const modelResult = applySetConfigOption({
      acpxCommand: params.acpxCommand,
      acpxCwd: params.acpxCwd,
      agent: params.agent,
      childSessionKey: params.childSessionKey,
      timeoutMs: params.timeoutMs,
      key: "model",
      value: params.options.model
    });
    mergeDiscoveredConfigOptions(discoveredConfigOptions, modelResult.configOptions);
    upsertLightContextCompatibilityOption(discoveredConfigOptions);
    if (!modelResult.ok) {
      return {
        fatalError: `model=${params.options.model}: ${normalizeSingleLine(modelResult.error, 220)}`,
        applied,
        warnings,
        lightContextCandidatesTried,
        lightContextAttemptLog,
        discoveredConfigOptionIds: listDiscoveredConfigOptionIds(discoveredConfigOptions),
        discoveredConfigOptions: listDiscoveredConfigOptions(discoveredConfigOptions)
      };
    }
    applied.push(`model=${params.options.model} (set:model)`);
  }

  if (params.options.thinking) {
    const thinkingCandidates = [];
    const reasoningEffortValue = toReasoningEffortValue(params.options.thinking);
    if (reasoningEffortValue) {
      thinkingCandidates.push({ key: "reasoning_effort", value: reasoningEffortValue });
    }
    thinkingCandidates.push(
      { key: "thinking", value: params.options.thinking },
      { key: "thinking_level", value: params.options.thinking },
      { key: "think", value: params.options.thinking }
    );

    const thinkingResult = applyCandidateSetConfigOption({
      acpxCommand: params.acpxCommand,
      acpxCwd: params.acpxCwd,
      agent: params.agent,
      childSessionKey: params.childSessionKey,
      timeoutMs: params.timeoutMs,
      candidates: thinkingCandidates
    });
    mergeDiscoveredConfigOptionMap(discoveredConfigOptions, thinkingResult.discoveredConfigOptions);
    upsertLightContextCompatibilityOption(discoveredConfigOptions);
    if (thinkingResult.ok) {
      applied.push(`thinking=${params.options.thinking} (set:${thinkingResult.key})`);
    } else {
      warnings.push(
        `thinking=${params.options.thinking} skipped (${normalizeSingleLine(thinkingResult.error, 180)})`
      );
    }
  }

  if (params.options.lightContext !== null) {
    const lightContextValue = params.options.lightContext;
    upsertLightContextCompatibilityOption(discoveredConfigOptions);
    const lightContextCandidates = buildLightContextCandidates(discoveredConfigOptions, lightContextValue);
    for (const candidate of lightContextCandidates) {
      lightContextCandidatesTried.push(`${candidate.key}=${candidate.value}`);
    }
    const lightContextResult = applyCandidateSetConfigOption({
      acpxCommand: params.acpxCommand,
      acpxCwd: params.acpxCwd,
      agent: params.agent,
      childSessionKey: params.childSessionKey,
      timeoutMs: params.timeoutMs,
      candidates: lightContextCandidates,
      initialDiscoveredConfigOptions: [...discoveredConfigOptions.values()],
      enforceInitialSupportedKeys: true
    });
    for (const attempt of lightContextResult.attempts || []) {
      lightContextAttemptLog.push(attempt);
    }
    mergeDiscoveredConfigOptionMap(discoveredConfigOptions, lightContextResult.discoveredConfigOptions);
    upsertLightContextCompatibilityOption(discoveredConfigOptions);
    if (lightContextResult.ok) {
      applied.push(
        `lightContext=${lightContextValue ? "true" : "false"} (set:${lightContextResult.key}=${lightContextResult.value})`
      );
    } else {
      const availableOptions =
        (lightContextResult.discoveredConfigOptionIds || []).length > 0
          ? lightContextResult.discoveredConfigOptionIds
          : listDiscoveredConfigOptionIds(discoveredConfigOptions);
      const supportHint = availableOptions.length > 0
        ? `; supported=${availableOptions.join(", ")}`
        : "";
      warnings.push(
        `lightContext=${lightContextValue ? "true" : "false"} skipped (${normalizeSingleLine(lightContextResult.error, 180)}${supportHint})`
      );
    }
  }

  return {
    fatalError: null,
    applied,
    warnings,
    lightContextCandidatesTried: dedupeStringArray(lightContextCandidatesTried),
    lightContextAttemptLog,
    discoveredConfigOptionIds: listDiscoveredConfigOptionIds(discoveredConfigOptions),
    discoveredConfigOptions: listDiscoveredConfigOptions(discoveredConfigOptions)
  };
}

function dedupeStringArray(values) {
  const deduped = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = toOptionalTrimmedString(value);
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function buildRuntimeOptionSummary(report) {
  const tokens = [];
  if (report.applied.length > 0) {
    tokens.push(`applied=${report.applied.join(", ")}`);
  }
  if (report.warnings.length > 0) {
    tokens.push(`warnings=${report.warnings.join(", ")}`);
  }
  if (tokens.length === 0) {
    return null;
  }
  return `runtimeOptions(${tokens.join("; ")})`;
}

function emitResult(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function emitError(message, error, extras) {
  emitResult({
    status: "error",
    backend: "acpx",
    message,
    error,
    ...(extras || {})
  });
}

function main() {
  let rawInput = "";
  try {
    rawInput = require("node:fs").readFileSync(0, "utf8");
  } catch (readError) {
    emitError(
      "failed to read adapter payload from stdin",
      readError instanceof Error ? readError.message : String(readError),
      {}
    );
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(rawInput || "{}");
  } catch (parseError) {
    emitError(
      "invalid adapter payload json",
      parseError instanceof Error ? parseError.message : String(parseError),
      {}
    );
    return;
  }

  const childSessionKey = toOptionalTrimmedString(payload.childSessionKey);
  if (!childSessionKey) {
    emitError("adapter payload requires childSessionKey", "childSessionKey is missing", {});
    return;
  }

  const agent = toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_ACPX_AGENT) || "codex";
  const acpxCommand =
    toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_ACPX_COMMAND) ||
    toOptionalTrimmedString(process.env.OMNINODE_ACP_BRIDGE_ACPX_BIN) ||
    "acpx";
  const acpxCwd = toOptionalTrimmedString(process.env.OMNINODE_ACP_ADAPTER_ACPX_CWD) || process.cwd();
  const timeoutMs = resolveTimeoutMs(payload);
  const resolvedMode = resolveMode(payload);
  const runtimeOptions = resolveRuntimeOptions(payload);

  const ensureArgs = [
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    acpxCwd,
    agent,
    "sessions",
    "ensure",
    "--name",
    childSessionKey
  ];

  const ensureRun = runAcpxCommand(acpxCommand, ensureArgs, {
    timeoutMs
  });

  if (ensureRun.error) {
    const err = ensureRun.error;
    const errorText = err && err.message ? err.message : String(err);
    emitError(
      "acpx ensure command failed",
      errorText,
      {
        command: acpxCommand
      }
    );
    return;
  }

  const stdout = String(ensureRun.stdout || "");
  const stderr = String(ensureRun.stderr || "");
  const events = parseJsonLines(stdout);
  const ensureDiscoveredConfigOptions = extractConfigOptions(events);
  const backendSessionId = extractBackendSessionId(events);
  const agentSessionId = extractAgentSessionId(events);
  const acpxRecordId = extractAcpxRecordId(events);

  if ((ensureRun.status || 0) !== 0) {
    const fallbackError = resolveProcessFailureError(ensureRun, stdout, stderr);
    emitError(
      "acpx ensure command returned non-zero exit status",
      fallbackError,
      {
        backendSessionId,
        agentSessionId,
        acpxRecordId
      }
    );
    return;
  }

  const runtimeOptionReport = applyRuntimeOptions({
    acpxCommand,
    acpxCwd,
    agent,
    childSessionKey,
    timeoutMs,
    options: runtimeOptions,
    initialDiscoveredConfigOptions: ensureDiscoveredConfigOptions
  });
  if (runtimeOptionReport.fatalError) {
    emitError(
      "acpx runtime option apply failed",
      runtimeOptionReport.fatalError,
      {
        backendSessionId,
        agentSessionId,
        acpxRecordId,
        runtimeOptionWarnings: runtimeOptionReport.warnings,
        runtimeOptionLightContextCandidatesTried: runtimeOptionReport.lightContextCandidatesTried,
        runtimeOptionLightContextAttemptLog: runtimeOptionReport.lightContextAttemptLog,
        runtimeOptionDiscoveredConfigOptionIds: runtimeOptionReport.discoveredConfigOptionIds,
        runtimeOptionDiscoveredConfigOptions: runtimeOptionReport.discoveredConfigOptions
      }
    );
    return;
  }

  const promptTask = toOptionalTrimmedString(payload.task);
  const promptNoWait = resolvedMode === "session";
  let promptEvents = [];
  let promptStopReason = null;
  let promptRequestId = null;
  if (promptTask) {
    const promptArgs = buildPromptArgs({
      acpxCwd,
      agent,
      childSessionKey,
      timeoutMs,
      noWait: promptNoWait
    });
    const promptRun = runAcpxCommand(acpxCommand, promptArgs, {
      timeoutMs,
      inputText: promptTask
    });
    const promptStdout = String(promptRun.stdout || "");
    const promptStderr = String(promptRun.stderr || "");
    promptEvents = parseJsonLines(promptStdout);
    promptStopReason = extractPromptStopReason(promptEvents);
    promptRequestId = extractPromptRequestId(promptEvents);
    const promptEventError = extractPromptError(promptEvents);
    if (promptRun.error || (promptRun.status || 0) !== 0 || promptEventError) {
      emitError(
        "acpx prompt command returned an error",
        promptEventError || resolveProcessFailureError(promptRun, promptStdout, promptStderr),
        {
          backendSessionId,
          agentSessionId,
          acpxRecordId,
          runtimeOptionWarnings: runtimeOptionReport.warnings,
          runtimeOptionLightContextCandidatesTried: runtimeOptionReport.lightContextCandidatesTried,
          runtimeOptionLightContextAttemptLog: runtimeOptionReport.lightContextAttemptLog,
          runtimeOptionDiscoveredConfigOptionIds: runtimeOptionReport.discoveredConfigOptionIds,
          runtimeOptionDiscoveredConfigOptions: runtimeOptionReport.discoveredConfigOptions
        }
      );
      return;
    }
  }

  const promptMessage =
    promptNoWait
      ? "acpx ensure+prompt queued for persistent session handoff"
      : `acpx ensure+prompt completed${promptStopReason ? ` (stopReason=${promptStopReason})` : ""}`;
  const runtimeOptionSummary = buildRuntimeOptionSummary(runtimeOptionReport);
  const finalMessage = runtimeOptionSummary ? `${promptMessage}; ${runtimeOptionSummary}` : promptMessage;

  emitResult({
    status: "accepted",
    backend: "acpx",
    message: finalMessage,
    backendSessionId,
    threadBindingKey: toBoolean(payload.thread) ? `thread:${childSessionKey}` : null,
    agentSessionId,
    acpxRecordId,
    mode: resolvedMode,
    promptQueued: promptNoWait,
    promptRequestId,
    promptStopReason,
    promptEventCount: promptEvents.length,
    runtimeOptionApplied: runtimeOptionReport.applied,
    runtimeOptionWarnings: runtimeOptionReport.warnings,
    runtimeOptionLightContextCandidatesTried: runtimeOptionReport.lightContextCandidatesTried,
    runtimeOptionLightContextAttemptLog: runtimeOptionReport.lightContextAttemptLog,
    runtimeOptionDiscoveredConfigOptionIds: runtimeOptionReport.discoveredConfigOptionIds,
    runtimeOptionDiscoveredConfigOptions: runtimeOptionReport.discoveredConfigOptions
  });
}

main();
