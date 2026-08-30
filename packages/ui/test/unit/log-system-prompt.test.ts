import assert from "node:assert/strict";
import test from "node:test";
import type { RequestLogBody } from "@ccr/core/contracts/app";
import {
  extractRequestSystemPromptText,
  stripSystemPromptForPreview,
  systemPromptPreviewPlaceholder
} from "@ccr/ui/pages/home/shared/logs.ts";

function bodyOf(text: string): RequestLogBody {
  return { encoding: "utf8", sizeBytes: Buffer.byteLength(text), text, truncated: false };
}

test("extractRequestSystemPromptText reads a string system field", () => {
  const body = bodyOf(JSON.stringify({ messages: [], system: "You are a helpful assistant." }));
  assert.equal(extractRequestSystemPromptText(body), "You are a helpful assistant.");
});

test("extractRequestSystemPromptText joins block-array system content", () => {
  const body = bodyOf(JSON.stringify({
    messages: [],
    system: [{ text: "Part one.", type: "text" }, { text: "Part two.", type: "text" }]
  }));
  assert.equal(extractRequestSystemPromptText(body), "Part one.\n\nPart two.");
});

test("extractRequestSystemPromptText returns undefined without a system field", () => {
  assert.equal(extractRequestSystemPromptText(bodyOf(JSON.stringify({ messages: [] }))), undefined);
  assert.equal(extractRequestSystemPromptText(undefined), undefined);
  assert.equal(extractRequestSystemPromptText(bodyOf("not json")), undefined);
});

test("stripSystemPromptForPreview replaces the system field but keeps the rest of the body", () => {
  const body = bodyOf(JSON.stringify({ messages: [{ content: "hi", role: "user" }], system: "secret preamble" }));
  const stripped = stripSystemPromptForPreview(body);
  assert.ok(stripped);
  const parsed = JSON.parse(stripped.text);
  assert.equal(parsed.system, systemPromptPreviewPlaceholder);
  assert.deepEqual(parsed.messages, [{ content: "hi", role: "user" }]);
});

test("stripSystemPromptForPreview leaves bodies without a system field untouched", () => {
  const body = bodyOf(JSON.stringify({ messages: [] }));
  assert.equal(stripSystemPromptForPreview(body), body);
  assert.equal(stripSystemPromptForPreview(undefined), undefined);
});
