import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  getExecutionSettings,
  isLoopbackEndpoint,
  packSegments,
  segmentTokens,
  splitText
} from "./execution";

describe("execution settings", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("detects %s as local", (host) => {
    expect(isLoopbackEndpoint(`http://${host}:1234/v1/chat/completions`)).toBe(true);
    expect(getExecutionSettings({ providerEndpoint: `http://${host}` }).concurrency).toBe(1);
  });
  it("treats remote compatible APIs as cloud services", () => {
    expect(
      getExecutionSettings({ providerEndpoint: "https://openrouter.ai/api/v1/chat/completions" })
    ).toMatchObject({
      mode: "auto",
      scope: "viewport",
      concurrency: 3,
      inputTokenBudget: 1800,
      streaming: true
    });
    expect(isLoopbackEndpoint("not a URL")).toBe(false);
    expect(isLoopbackEndpoint("https://localhost.evil.example")).toBe(false);
  });
  it("supports explicit overrides and bounds malformed numbers", () => {
    expect(
      getExecutionSettings({
        providerEndpoint: "http://localhost",
        execution: {
          mode: "cloud",
          scope: "page",
          concurrency: 100,
          inputTokenBudget: 1,
          maxOutputTokens: Infinity,
          timeoutMs: 999999,
          retries: -1,
          streaming: false
        }
      })
    ).toMatchObject({
      concurrency: 6,
      inputTokenBudget: 256,
      maxOutputTokens: 4096,
      timeoutMs: 120000,
      retries: 0,
      streaming: false,
      scope: "page"
    });
    expect(
      getExecutionSettings({ providerEndpoint: "https://remote", execution: { mode: "local" } })
        .concurrency
    ).toBe(1);
  });
});

describe("token packing", () => {
  it("accounts for context and multibyte text", () => {
    expect(estimateTokens("abc漢🙂")).toBe(3);
    expect(segmentTokens({ id: "a", text: "abc", contextBefore: "abc", contextAfter: "漢" })).toBe(
      35
    );
  });
  it("packs in order with both token and item limits", () => {
    const segments = Array.from({ length: 65 }, (_, i) => ({ id: String(i), text: "abc" }));
    expect(packSegments([], 100)).toEqual([]);
    expect(packSegments(segments, 100000).map((b) => b.length)).toEqual([64, 1]);
    expect(packSegments(segments.slice(0, 5), 66).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(packSegments([{ id: "big", text: "x".repeat(100) }], 1)).toHaveLength(1);
  });
  it.each([
    "First sentence. Second sentence. Third sentence.",
    "a".repeat(10000),
    "漢🙂".repeat(100),
    "  hello.  world.  more text.  "
  ])("splits without exceeding its budget", (text) => {
    const chunks = splitText(text, 12);
    expect(chunks.every((c) => c.trim() && estimateTokens(c) <= 12)).toBe(true);
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    expect(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c))).toBe(true);
  });
  it("leaves small segments intact", () => {
    expect(splitText("Small sentence.", 50)).toEqual(["Small sentence."]);
  });
});
