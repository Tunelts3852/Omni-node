#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SERVER_NAME = "desktop-control-mcp";
const SERVER_VERSION = "1.0.0";
const DEFAULT_WAIT_MS = 1000;
const MAX_WAIT_MS = 60_000;
const PYTHON_MOUSE_SCRIPT = `
import ctypes
import ctypes.util
import json
import math
import sys
import time

framework = ctypes.util.find_library("ApplicationServices")
if not framework:
    raise RuntimeError("ApplicationServices framework not found")

quartz = ctypes.CDLL(framework)

class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

quartz.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
quartz.CGEventCreateMouseEvent.restype = ctypes.c_void_p
quartz.CGEventCreateScrollWheelEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_int32, ctypes.c_int32]
quartz.CGEventCreateScrollWheelEvent.restype = ctypes.c_void_p
quartz.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
quartz.CGEventPost.restype = None
quartz.CFRelease.argtypes = [ctypes.c_void_p]
quartz.CFRelease.restype = None

KCG_HID_EVENT_TAP = 0
EVENT_LEFT_DOWN = 1
EVENT_LEFT_UP = 2
EVENT_RIGHT_DOWN = 3
EVENT_RIGHT_UP = 4
EVENT_MOUSE_MOVED = 5
EVENT_LEFT_DRAGGED = 6
EVENT_RIGHT_DRAGGED = 7
BUTTON_LEFT = 0
BUTTON_RIGHT = 1
WHEEL_UNIT_PIXEL = 0

def event(mouse_event_type, x, y, button):
    ref = quartz.CGEventCreateMouseEvent(None, mouse_event_type, CGPoint(float(x), float(y)), button)
    if not ref:
        raise RuntimeError("failed to create mouse event")
    quartz.CGEventPost(KCG_HID_EVENT_TAP, ref)
    quartz.CFRelease(ref)

def move(x, y):
    event(EVENT_MOUSE_MOVED, x, y, BUTTON_LEFT)

def click(x, y, button_name, repeat_count):
    button = BUTTON_RIGHT if button_name == "right" else BUTTON_LEFT
    down = EVENT_RIGHT_DOWN if button == BUTTON_RIGHT else EVENT_LEFT_DOWN
    up = EVENT_RIGHT_UP if button == BUTTON_RIGHT else EVENT_LEFT_UP
    move(x, y)
    time.sleep(0.02)
    for _ in range(max(1, repeat_count)):
        event(down, x, y, button)
        time.sleep(0.02)
        event(up, x, y, button)
        time.sleep(0.08)

def drag(start_x, start_y, end_x, end_y, steps):
    step_count = max(2, int(steps))
    move(start_x, start_y)
    time.sleep(0.02)
    event(EVENT_LEFT_DOWN, start_x, start_y, BUTTON_LEFT)
    time.sleep(0.03)
    for index in range(1, step_count + 1):
        progress = index / float(step_count)
        point_x = start_x + ((end_x - start_x) * progress)
        point_y = start_y + ((end_y - start_y) * progress)
        event(EVENT_LEFT_DRAGGED, point_x, point_y, BUTTON_LEFT)
        time.sleep(0.01)
    event(EVENT_LEFT_UP, end_x, end_y, BUTTON_LEFT)

def scroll(delta_x, delta_y, x, y):
    if x is not None and y is not None:
        move(x, y)
        time.sleep(0.02)
    ref = quartz.CGEventCreateScrollWheelEvent(None, WHEEL_UNIT_PIXEL, 2, int(delta_y), int(delta_x))
    if not ref:
        raise RuntimeError("failed to create scroll event")
    quartz.CGEventPost(KCG_HID_EVENT_TAP, ref)
    quartz.CFRelease(ref)

action = sys.argv[1]
payload = json.loads(sys.argv[2])
if action == "click":
    click(payload["x"], payload["y"], payload.get("button", "left"), payload.get("repeatCount", 1))
elif action == "drag":
    drag(payload["startX"], payload["startY"], payload["endX"], payload["endY"], payload.get("steps", 24))
elif action == "scroll":
    scroll(payload.get("deltaX", 0), payload.get("deltaY", -400), payload.get("x"), payload.get("y"))
else:
    raise RuntimeError(f"unsupported mouse action: {action}")
`;

const TOOL_DEFINITIONS = [
  {
    name: "capture_screen",
    description: "현재 화면을 캡처해 output directory 안의 PNG 파일로 저장합니다.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "output directory 기준 상대 경로 파일명. 비우면 자동 생성합니다."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "activate_app",
    description: "지정한 macOS 앱을 전면으로 활성화합니다.",
    inputSchema: {
      type: "object",
      properties: {
        appName: {
          type: "string",
          description: "Finder, Google Chrome 같은 앱 이름"
        }
      },
      required: ["appName"],
      additionalProperties: false
    }
  },
  {
    name: "click",
    description: "화면 좌표를 한 번 클릭합니다.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"] }
      },
      required: ["x", "y"],
      additionalProperties: false
    }
  },
  {
    name: "double_click",
    description: "화면 좌표를 두 번 클릭합니다.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"] }
      },
      required: ["x", "y"],
      additionalProperties: false
    }
  },
  {
    name: "drag",
    description: "시작 좌표에서 종료 좌표까지 드래그합니다.",
    inputSchema: {
      type: "object",
      properties: {
        startX: { type: "number" },
        startY: { type: "number" },
        endX: { type: "number" },
        endY: { type: "number" },
        steps: { type: "integer", minimum: 2, maximum: 240 }
      },
      required: ["startX", "startY", "endX", "endY"],
      additionalProperties: false
    }
  },
  {
    name: "scroll",
    description: "현재 위치 또는 지정 좌표에서 스크롤합니다.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        deltaX: { type: "number" },
        deltaY: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "type_text",
    description: "현재 포커스된 입력 대상에 텍스트를 입력합니다.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" }
      },
      required: ["text"],
      additionalProperties: false
    }
  },
  {
    name: "press_keys",
    description: "키 조합을 누릅니다. 예: keys=[\"command\",\"l\"], keys=[\"enter\"].",
    inputSchema: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          minItems: 1
        }
      },
      required: ["keys"],
      additionalProperties: false
    }
  },
  {
    name: "wait",
    description: "지정한 시간만큼 대기합니다.",
    inputSchema: {
      type: "object",
      properties: {
        milliseconds: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS },
        seconds: { type: "number", minimum: 0, maximum: MAX_WAIT_MS / 1000 }
      },
      additionalProperties: false
    }
  }
];

function parseArgs(argv) {
  let outputDir = "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--output-dir" && index + 1 < argv.length) {
      outputDir = argv[index + 1];
      index += 1;
    }
  }

  const resolvedOutputDir = outputDir ? path.resolve(process.cwd(), outputDir) : "";
  if (resolvedOutputDir) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
  }

  return {
    outputDir: resolvedOutputDir
  };
}

const runtime = parseArgs(process.argv.slice(2));

function sendMessage(message) {
  const json = JSON.stringify(message);
  const payload = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  process.stdout.write(payload);
}

function sendResult(id, result) {
  if (id === undefined || id === null) {
    return;
  }

  sendMessage({
    jsonrpc: "2.0",
    id,
    result
  });
}

function sendError(id, code, message, data) {
  if (id === undefined || id === null) {
    return;
  }

  sendMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  });
}

function buildTextResult(text, structuredContent, isError = false) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(isError ? { isError: true } : {})
  };
}

function isMacOS() {
  return process.platform === "darwin";
}

function ensureMacOSTool(name) {
  if (!isMacOS()) {
    throw new Error(`${name} 도구는 macOS에서만 지원합니다.`);
  }
}

function requireOutputDirectory(name) {
  if (!runtime.outputDir) {
    throw new Error(`${name} 도구는 output directory가 필요합니다.`);
  }
  return runtime.outputDir;
}

function resolveOutputPath(filename, defaultExtension) {
  const outputDir = requireOutputDirectory("capture_screen");
  const rawName = `${filename || ""}`.trim() || `screen-${Date.now()}.${defaultExtension}`;
  const normalizedName = rawName.startsWith("/") ? rawName.slice(1) : rawName;
  const withExtension = path.extname(normalizedName) ? normalizedName : `${normalizedName}.${defaultExtension}`;
  const resolved = path.resolve(outputDir, withExtension);
  const rootWithSeparator = outputDir.endsWith(path.sep) ? outputDir : `${outputDir}${path.sep}`;
  if (resolved !== outputDir && !resolved.startsWith(rootWithSeparator)) {
    throw new Error("output directory 밖으로 저장할 수 없습니다.");
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = `${result.stderr || ""}`.trim();
    const stdout = `${result.stdout || ""}`.trim();
    throw new Error(stderr || stdout || `${command} exited with status ${result.status}`);
  }
  return result;
}

function runAppleScript(script, argv = []) {
  const args = ["-e", script, ...argv];
  return runProcess("osascript", args);
}

function escapeAppleScriptString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function normalizeNumber(value, name) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${name} 값이 필요합니다.`);
  }
  return numeric;
}

function normalizeInteger(value, fallback, min, max) {
  const numeric = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function runMouseAction(action, payload) {
  ensureMacOSTool(action);
  runProcess("python3", ["-c", PYTHON_MOUSE_SCRIPT, action, JSON.stringify(payload)]);
}

const SPECIAL_KEY_CODES = new Map([
  ["enter", 36],
  ["return", 36],
  ["tab", 48],
  ["space", 49],
  ["delete", 51],
  ["backspace", 51],
  ["escape", 53],
  ["esc", 53],
  ["left", 123],
  ["arrowleft", 123],
  ["right", 124],
  ["arrowright", 124],
  ["down", 125],
  ["arrowdown", 125],
  ["up", 126],
  ["arrowup", 126],
  ["home", 115],
  ["end", 119],
  ["pageup", 116],
  ["pagedown", 121]
]);

const MODIFIER_KEYS = new Map([
  ["command", "command down"],
  ["cmd", "command down"],
  ["meta", "command down"],
  ["shift", "shift down"],
  ["option", "option down"],
  ["alt", "option down"],
  ["control", "control down"],
  ["ctrl", "control down"]
]);

function buildModifierClause(modifiers) {
  if (!Array.isArray(modifiers) || modifiers.length === 0) {
    return "";
  }
  return ` using {${modifiers.join(", ")}}`;
}

function buildKeyPressCommand(key, modifierClause) {
  const normalized = `${key || ""}`.trim().toLowerCase();
  const specialCode = SPECIAL_KEY_CODES.get(normalized);
  if (specialCode !== undefined) {
    return `key code ${specialCode}${modifierClause}`;
  }

  const printable = `${key || ""}`;
  if (!printable) {
    throw new Error("press_keys는 최소 한 개의 일반 키가 필요합니다.");
  }
  return `keystroke "${escapeAppleScriptString(printable)}"${modifierClause}`;
}

async function handleToolCall(name, args) {
  ensureMacOSTool(name);
  switch (name) {
    case "capture_screen": {
      const targetPath = resolveOutputPath(args?.filename, "png");
      runProcess("screencapture", ["-x", targetPath]);
      return buildTextResult(
        `스크린샷 저장 완료: ${targetPath}`,
        { path: targetPath }
      );
    }
    case "activate_app": {
      const appName = `${args?.appName || ""}`.trim();
      if (!appName) {
        throw new Error("appName 값이 필요합니다.");
      }
      runAppleScript(
        [
          "on run argv",
          "set appName to item 1 of argv",
          "tell application appName to activate",
          "end run"
        ].join("\n"),
        [appName]
      );
      return buildTextResult(`앱 활성화 완료: ${appName}`, { appName });
    }
    case "click": {
      runMouseAction("click", {
        x: normalizeNumber(args?.x, "x"),
        y: normalizeNumber(args?.y, "y"),
        button: `${args?.button || "left"}`.trim().toLowerCase() === "right" ? "right" : "left",
        repeatCount: 1
      });
      return buildTextResult("클릭 완료", {
        x: Number(args.x),
        y: Number(args.y),
        button: `${args?.button || "left"}`.trim().toLowerCase() === "right" ? "right" : "left"
      });
    }
    case "double_click": {
      runMouseAction("click", {
        x: normalizeNumber(args?.x, "x"),
        y: normalizeNumber(args?.y, "y"),
        button: `${args?.button || "left"}`.trim().toLowerCase() === "right" ? "right" : "left",
        repeatCount: 2
      });
      return buildTextResult("더블 클릭 완료", {
        x: Number(args.x),
        y: Number(args.y),
        button: `${args?.button || "left"}`.trim().toLowerCase() === "right" ? "right" : "left"
      });
    }
    case "drag": {
      runMouseAction("drag", {
        startX: normalizeNumber(args?.startX, "startX"),
        startY: normalizeNumber(args?.startY, "startY"),
        endX: normalizeNumber(args?.endX, "endX"),
        endY: normalizeNumber(args?.endY, "endY"),
        steps: normalizeInteger(args?.steps, 24, 2, 240)
      });
      return buildTextResult("드래그 완료", {
        startX: Number(args.startX),
        startY: Number(args.startY),
        endX: Number(args.endX),
        endY: Number(args.endY),
        steps: normalizeInteger(args?.steps, 24, 2, 240)
      });
    }
    case "scroll": {
      const hasPointerTarget = Number.isFinite(Number(args?.x)) && Number.isFinite(Number(args?.y));
      runMouseAction("scroll", {
        x: hasPointerTarget ? Number(args.x) : null,
        y: hasPointerTarget ? Number(args.y) : null,
        deltaX: Number.isFinite(Number(args?.deltaX)) ? Math.trunc(Number(args.deltaX)) : 0,
        deltaY: Number.isFinite(Number(args?.deltaY)) ? Math.trunc(Number(args.deltaY)) : -400
      });
      return buildTextResult("스크롤 완료", {
        x: hasPointerTarget ? Number(args.x) : null,
        y: hasPointerTarget ? Number(args.y) : null,
        deltaX: Number.isFinite(Number(args?.deltaX)) ? Math.trunc(Number(args.deltaX)) : 0,
        deltaY: Number.isFinite(Number(args?.deltaY)) ? Math.trunc(Number(args.deltaY)) : -400
      });
    }
    case "type_text": {
      const text = `${args?.text || ""}`;
      if (!text) {
        throw new Error("text 값이 필요합니다.");
      }
      runAppleScript(
        [
          "on run argv",
          "set inputText to item 1 of argv",
          "tell application \"System Events\"",
          "keystroke inputText",
          "end tell",
          "end run"
        ].join("\n"),
        [text]
      );
      return buildTextResult("텍스트 입력 완료", { length: text.length });
    }
    case "press_keys": {
      const keys = Array.isArray(args?.keys) ? args.keys.map((value) => `${value || ""}`.trim()).filter(Boolean) : [];
      if (keys.length === 0) {
        throw new Error("keys 배열이 필요합니다.");
      }
      const modifiers = [];
      const regularKeys = [];
      for (const key of keys) {
        const normalized = key.toLowerCase();
        const modifier = MODIFIER_KEYS.get(normalized);
        if (modifier) {
          modifiers.push(modifier);
        } else {
          regularKeys.push(key);
        }
      }
      if (regularKeys.length === 0) {
        throw new Error("modifier 외에 일반 키가 하나 이상 필요합니다.");
      }
      const modifierClause = buildModifierClause(modifiers);
      const commands = regularKeys.map((key) => buildKeyPressCommand(key, modifierClause));
      runAppleScript(
        [
          "tell application \"System Events\"",
          ...commands,
          "end tell"
        ].join("\n")
      );
      return buildTextResult("키 입력 완료", { keys });
    }
    case "wait": {
      const waitMs = (() => {
        if (Number.isFinite(Number(args?.milliseconds))) {
          return normalizeInteger(args.milliseconds, DEFAULT_WAIT_MS, 0, MAX_WAIT_MS);
        }
        if (Number.isFinite(Number(args?.seconds))) {
          return normalizeInteger(Number(args.seconds) * 1000, DEFAULT_WAIT_MS, 0, MAX_WAIT_MS);
        }
        return DEFAULT_WAIT_MS;
      })();
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return buildTextResult(`대기 완료: ${waitMs}ms`, { milliseconds: waitMs });
    }
    default:
      throw new Error(`지원하지 않는 도구입니다: ${name}`);
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  const method = `${message.method || ""}`.trim();
  const id = message.id;
  if (!method) {
    sendError(id, -32600, "Invalid Request");
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "initialize") {
    const requestedProtocol = `${message.params?.protocolVersion || ""}`.trim() || "2024-11-05";
    sendResult(id, {
      protocolVersion: requestedProtocol,
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION
      }
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, {
      tools: TOOL_DEFINITIONS
    });
    return;
  }

  if (method === "tools/call") {
    const name = `${message.params?.name || ""}`.trim();
    try {
      const result = await handleToolCall(name, message.params?.arguments || {});
      sendResult(id, result);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      sendResult(id, buildTextResult(messageText, { error: messageText }, true));
    }
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number.parseInt(match[1], 10);
    const frameLength = headerEnd + 4 + contentLength;
    if (buffer.length < frameLength) {
      return;
    }

    const body = buffer.slice(headerEnd + 4, frameLength).toString("utf8");
    buffer = buffer.slice(frameLength);

    let message;
    try {
      message = JSON.parse(body);
    } catch (error) {
      sendError(null, -32700, "Parse error", error instanceof Error ? error.message : String(error));
      continue;
    }

    void handleMessage(message);
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
