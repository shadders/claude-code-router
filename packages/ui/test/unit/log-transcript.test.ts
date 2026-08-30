import assert from "node:assert/strict";
import test from "node:test";
import type { RequestLogBody } from "@ccr/core/contracts/app";
import {
  extractTranscriptMessages,
  transcriptSegmentsForContent
} from "@ccr/ui/pages/home/shared/logs.ts";

function bodyOf(text: string): RequestLogBody {
  return { encoding: "utf8", sizeBytes: Buffer.byteLength(text), text, truncated: false };
}

test("extractTranscriptMessages reads the request messages array", () => {
  const body = bodyOf(JSON.stringify({
    messages: [
      { content: "hi", role: "user" },
      { content: [{ text: "hello", type: "text" }], role: "assistant" }
    ],
    system: "unrelated top-level system field"
  }));
  const messages = extractTranscriptMessages(body, "request");
  assert.ok(messages);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].role, "assistant");
});

// Real shape confirmed against a live-logged row: Claude Code injects its own agent-list/tool
// reminder mid-conversation as a role:"system" message with plain string content, distinct from
// the top-level Anthropic `system` field -- extraction must not assume role is only user/assistant.
test("extractTranscriptMessages preserves a role:system message inside the array", () => {
  const body = bodyOf(JSON.stringify({
    messages: [{ content: "Available agent types...", role: "system" }]
  }));
  const messages = extractTranscriptMessages(body, "request");
  assert.ok(messages);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, "Available agent types...");
});

test("extractTranscriptMessages returns undefined for a request body with no messages array", () => {
  assert.equal(extractTranscriptMessages(bodyOf(JSON.stringify({ error: "boom" })), "request"), undefined);
  assert.equal(extractTranscriptMessages(bodyOf("not json"), "request"), undefined);
  assert.equal(extractTranscriptMessages(undefined, "request"), undefined);
});

test("extractTranscriptMessages treats a non-streaming response body as one assistant message", () => {
  const body = bodyOf(JSON.stringify({
    content: [{ text: "done", type: "text" }],
    role: "assistant",
    type: "message"
  }));
  const messages = extractTranscriptMessages(body, "response");
  assert.ok(messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
});

// Real shape confirmed against a live-logged streaming row: the stored response body is raw
// Anthropic SSE (event:/data: lines), not pre-aggregated JSON -- extraction must reuse the same
// stream-aggregation path Tier 2's JSON view already uses, not assume a plain JSON object.
test("extractTranscriptMessages aggregates a streaming SSE response body into one message", () => {
  const sse = [
    "event: message_start",
    'data: {"type":"message_start","message":{"content":[],"role":"assistant","type":"message"}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"text":"","type":"text"}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"text":"Created ","type":"text_delta"}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"text":"the file.","type":"text_delta"}}',
    ""
  ].join("\n");
  const messages = extractTranscriptMessages(bodyOf(sse), "response");
  assert.ok(messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  const segments = transcriptSegmentsForContent(messages[0].content);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0], { kind: "text", text: "Created the file." });
});

test("transcriptSegmentsForContent renders plain string content as one text segment", () => {
  assert.deepEqual(transcriptSegmentsForContent("hello"), [{ kind: "text", text: "hello" }]);
  assert.deepEqual(transcriptSegmentsForContent("   "), []);
  assert.deepEqual(transcriptSegmentsForContent(undefined), []);
});

test("transcriptSegmentsForContent renders a text block", () => {
  const segments = transcriptSegmentsForContent([{ text: "hello", type: "text" }]);
  assert.deepEqual(segments, [{ kind: "text", text: "hello" }]);
});

// Real shape confirmed against a live-logged row (an Anthropic Write tool call).
test("transcriptSegmentsForContent renders a tool_use block as a tool_call segment", () => {
  const segments = transcriptSegmentsForContent([{
    id: "toolu_01",
    input: { content: "print('hi')", file_path: "/tmp/x.py" },
    name: "Write",
    type: "tool_use"
  }]);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0], {
    input: { content: "print('hi')", file_path: "/tmp/x.py" },
    kind: "tool_call",
    name: "Write"
  });
});

// Real shape confirmed against a live-logged row: tool_result.content was a plain string, not
// nested content blocks -- the spec requires showing that content directly, not the wrapper keys.
test("transcriptSegmentsForContent renders a tool_result block's content directly", () => {
  const segments = transcriptSegmentsForContent([{
    content: "File created successfully.",
    tool_use_id: "toolu_01",
    type: "tool_result"
  }]);
  assert.deepEqual(segments, [{
    isError: false,
    kind: "tool_result",
    segments: [{ kind: "text", text: "File created successfully." }]
  }]);
});

test("transcriptSegmentsForContent recurses into an array-shaped tool_result content", () => {
  const segments = transcriptSegmentsForContent([{
    content: [{ text: "part one", type: "text" }, { type: "image" }],
    is_error: true,
    type: "tool_result"
  }]);
  assert.equal(segments.length, 1);
  const toolResult = segments[0];
  assert.equal(toolResult.kind, "tool_result");
  if (toolResult.kind === "tool_result") {
    assert.equal(toolResult.isError, true);
    assert.deepEqual(toolResult.segments, [{ kind: "text", text: "part one" }, { kind: "image" }]);
  }
});

// Real shape confirmed against a live-logged row: a genuine Anthropic thinking block.
test("transcriptSegmentsForContent renders a thinking block", () => {
  const segments = transcriptSegmentsForContent([{ signature: "", thinking: "considering options", type: "thinking" }]);
  assert.deepEqual(segments, [{ kind: "thinking", text: "considering options" }]);
});

test("transcriptSegmentsForContent renders an image block as a placeholder, not inlined", () => {
  const segments = transcriptSegmentsForContent([{ source: { data: "base64...", type: "base64" }, type: "image" }]);
  assert.deepEqual(segments, [{ kind: "image" }]);
});

test("transcriptSegmentsForContent falls back to raw for an unrecognized block shape without failing the rest", () => {
  const segments = transcriptSegmentsForContent([
    { text: "before", type: "text" },
    { type: "some_future_block_type", weird: true },
    { text: "after", type: "text" }
  ]);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], { kind: "text", text: "before" });
  assert.deepEqual(segments[1], { kind: "raw", value: { type: "some_future_block_type", weird: true } });
  assert.deepEqual(segments[2], { kind: "text", text: "after" });
});
