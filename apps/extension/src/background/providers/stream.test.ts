import { describe, expect, it, vi } from "vitest";
import { readOpenAIStream, TranslationStreamParser } from "./stream";
import type { TranslationResult } from "../../shared/types";

const segments = [
  { id: "a", text: "Hello" },
  { id: "b", text: "World" }
];
function sse(text: string, width = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.slice(i, i + width));
        controller.close();
      }
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}
const event = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`;

describe("streamed translation JSON", () => {
  it("emits complete objects before the document ends and handles escapes and Unicode", () => {
    const emit = vi.fn<(result: TranslationResult) => void>();
    const parser = new TranslationStreamParser(segments, emit);
    const a = { id: "a", text: 'Bonjour 漢🙂 { \\"quote" }' };
    const document = JSON.stringify({ translations: [a, { id: "b", text: "Monde" }] });
    for (const character of document) parser.push(character);
    expect(emit.mock.calls.map(([r]) => r)).toEqual([a, { id: "b", text: "Monde" }]);
    expect(parser.finish()).toEqual([a, { id: "b", text: "Monde" }]);
  });
  it("retains complete objects from a truncated document", () => {
    const parser = new TranslationStreamParser(segments);
    parser.push('```json\n{"translations":[{"id":"a","text":"Bonjour"}, {');
    expect(parser.finish()).toEqual([{ id: "a", text: "Bonjour" }]);
  });
  it("discards duplicate IDs and unknown IDs", () => {
    const emit = vi.fn();
    const parser = new TranslationStreamParser(segments, emit);
    parser.push(
      '{"translations":[{"id":"a","text":"First"},{"id":"a","text":"Second"},{"id":"evil","text":"Unknown"}]}'
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(parser.finish()).toEqual([]);
  });
  it("bounds response size and rejects empty or invalid JSON", () => {
    const parser = new TranslationStreamParser(segments);
    expect(() => parser.finish()).toThrow(/invalid/);
    expect(() => parser.push("x".repeat(2000001))).toThrow(/too large/);
  });
  it("reads arbitrarily split SSE lines, comments, heartbeat and final event without newline", async () => {
    const emit = vi.fn();
    const text =
      ': heartbeat\r\n\r\ndata: {"choices":[]}\n\n' +
      event('{"translations":[') +
      event('{"id":"a","text":"Bonjour 🙂"}') +
      event("]}") +
      "data: [DONE]";
    expect(await readOpenAIStream(sse(text, 1), segments, emit)).toEqual([
      { id: "a", text: "Bonjour 🙂" }
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it("accepts multiline SSE data", async () => {
    const text = 'data: {"choices":\ndata: [{"delta":{"content":"{\\"translations\\":[]}"}}]}\n\n';
    expect(await readOpenAIStream(sse(text), segments)).toEqual([]);
  });
  it("rejects missing streams and provider stream errors", async () => {
    await expect(readOpenAIStream(new Response(null), segments)).rejects.toThrow(/empty/);
    await expect(
      readOpenAIStream(sse('data: {"error":{"message":"Unavailable"}}\n\n'), segments)
    ).rejects.toThrow("Unavailable");
    await expect(readOpenAIStream(sse('data: {"error":{}}\n\n'), segments)).rejects.toThrow(
      /failed/
    );
    await expect(readOpenAIStream(sse("data: invalid\n\n"), segments)).rejects.toThrow();
  });
  it("bounds unterminated SSE events", async () => {
    await expect(
      readOpenAIStream(sse("data: " + "x".repeat(2000001), 2000010), segments)
    ).rejects.toThrow(/too large/);
  });
});
