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
