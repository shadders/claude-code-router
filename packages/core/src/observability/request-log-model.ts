import { isClaudeCodeAutoCompactPromptText } from "@ccr/core/gateway/context-archive/protocol";
import { routeModelFromPath } from "@ccr/core/routing/protocol-adapter";

type JsonRecord = Record<string, unknown>;

export function requestLogCallType(body: Buffer | string): string | undefined {
  const payload = parseJsonBody(typeof body === "string" ? body : body.toString("utf8"));
  return isCompactionRequestPayload(payload) ? "compaction" : undefined;
}

function isCompactionRequestPayload(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages.some((message) =>
    isRecord(message) &&
    String(message.role ?? "") === "user" &&
    collectMessageText(message.content).some(isClaudeCodeAutoCompactPromptText)
  );
}

function collectMessageText(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (Array.isArray(content)) {
    return content.flatMap(collectMessageText);
  }
  if (isRecord(content) && typeof content.text === "string") {
    return [content.text];
  }
  return [];
}

const requestLogPreviewCharLimit = 300;

// Collapsed-row preview text, computed once at write time (like requestLogCallType/
// requestLogResponseModel) rather than at read time -- list-page queries never select the full
// body text (see requestLogBodyMetadataSelect in request-log-store.ts), so this is the only point
// where the complete, untruncated body is actually available. Scoped to the Anthropic Messages
// shape this router's own traffic actually uses, same as the frontend's Tier 1 transcript view.
export function requestLogRequestPreview(body: Buffer | string): string | undefined {
  const payload = parseJsonBody(typeof body === "string" ? body : body.toString("utf8"));
  if (!isRecord(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return undefined;
  }
  const lastMessage = payload.messages[payload.messages.length - 1];
  return isRecord(lastMessage) ? previewTextForContent(lastMessage.content) : undefined;
}

export function requestLogResponsePreview(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const direct = parseJsonBody(trimmed);
  const nonStreamPreview = isRecord(direct) ? previewFromNonStreamResponse(direct) : undefined;
  return nonStreamPreview ?? previewFromStreamedResponse(trimmed);
}

function previewFromNonStreamResponse(payload: JsonRecord): string | undefined {
  if (payload.content !== undefined) {
    return previewTextForContent(payload.content);
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (isRecord(choice)) {
    const message = isRecord(choice.message) ? choice.message : undefined;
    if (typeof message?.content === "string" && message.content.trim()) {
      return truncatePreviewText(message.content);
    }
    if (typeof choice.text === "string" && choice.text.trim()) {
      return truncatePreviewText(choice.text);
    }
  }
  return undefined;
}

// SSE streaming response: accumulate incremental text across frames until there's enough for a
// preview, rather than fully reconstructing the aggregated payload (that machinery already exists
// client-side for the expanded detail view -- this only needs the first few words). Covers
// Anthropic and OpenAI chat-completions delta shapes, the two this router's traffic actually uses
// most; an unrecognized streamed shape (e.g. Gemini) just leaves the preview empty rather than
// guessing.
function previewFromStreamedResponse(text: string): string | undefined {
  const parts: string[] = [];
  let length = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const data = line.startsWith("data:") ? line.slice(5).trim() : line.startsWith("{") ? line : "";
    if (!data || data === "[DONE]") {
      continue;
    }
    const payload = parseJsonBody(data);
    if (!isRecord(payload)) {
      continue;
    }
    const delta = streamedDeltaText(payload);
    if (delta) {
      parts.push(delta);
      length += delta.length;
      if (length >= requestLogPreviewCharLimit) {
        break;
      }
    }
  }
  const joined = parts.join("").trim();
  return joined ? truncatePreviewText(joined) : undefined;
}

function streamedDeltaText(payload: JsonRecord): string | undefined {
  const anthropicDelta = isRecord(payload.delta) ? payload.delta : undefined;
  if (typeof anthropicDelta?.text === "string") {
    return anthropicDelta.text;
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (isRecord(choice)) {
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    if (typeof delta?.content === "string") {
      return delta.content;
    }
    if (typeof choice.text === "string") {
      return choice.text;
    }
  }
  return undefined;
}

// A message's content can be entirely non-text blocks (a bare tool_use/tool_result, an image) --
// fall back to a short bracketed label rather than an empty preview, mirroring the frontend Tier 1
// transcript view's own fallback for the same shapes.
function previewTextForContent(content: unknown): string | undefined {
  const text = collectPreviewSegments(content)
    .filter((part) => part.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? truncatePreviewText(text) : undefined;
}

function collectPreviewSegments(content: unknown): string[] {
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map(previewTextForBlock);
}

function previewTextForBlock(block: unknown): string {
  if (typeof block === "string") {
    return block;
  }
  if (!isRecord(block)) {
    return "";
  }
  const type = typeof block.type === "string" ? block.type : "";
  if (type === "text" && typeof block.text === "string") {
    return block.text;
  }
  if (type === "thinking") {
    // Extended-thinking blocks are often much longer than the actual answer and would dominate
    // the char budget below, hiding the real text entirely -- same reason the streamed-response
    // scanner never reads delta.thinking. Preview the answer, not the reasoning.
    return "";
  }
  if (type === "tool_use") {
    return `[tool_use: ${typeof block.name === "string" ? block.name : "unknown_tool"}]`;
  }
  if (type === "tool_result") {
    const inner = collectPreviewSegments(block.content).filter((part) => part.trim().length > 0).join(" ");
    return inner || (block.is_error === true ? "[tool_result: error]" : "[tool_result]");
  }
  if (type === "image") {
    return "[image]";
  }
  return "";
}

function truncatePreviewText(text: string): string {
  return text.length > requestLogPreviewCharLimit ? text.slice(0, requestLogPreviewCharLimit) : text;
}

export function requestLogRequestedModel(body: Buffer | string, path = ""): string | undefined {
  const pathModel = normalizeModel(routeModelFromPath(path));
  if (pathModel) {
    return pathModel;
  }
  return modelFromPayload(parseJsonBody(typeof body === "string" ? body : body.toString("utf8")));
}

export function requestLogResponseModel(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const direct = modelFromPayload(parseJsonBody(trimmed));
  if (direct) {
    return direct;
  }

  let model: string | undefined;
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    const data = line.startsWith("data:") ? line.slice(5).trim() : line.startsWith("{") ? line : "";
    if (!data || data === "[DONE]") {
      continue;
    }
    model = modelFromPayload(parseJsonBody(data)) ?? model;
  }
  return model;
}

function modelFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const response = isRecord(payload.response) ? payload.response : undefined;
  const message = isRecord(payload.message) ? payload.message : undefined;
  return normalizeModel(response?.model) ??
    normalizeModel(payload.model) ??
    normalizeModel(message?.model) ??
    normalizeModel(response?.modelVersion) ??
    normalizeModel(payload.modelVersion) ??
    normalizeModel(message?.modelVersion);
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}
