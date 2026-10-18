import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { ExtensionSettings, TextSegment } from "../shared/types";
import type { ProviderRequestOptions } from "./providers/types";
import type { TranslationProvider } from "./providers/types";
import { ProviderHttpError } from "./providers/shared";
import { clearSessionCache, translateSegments } from "./translationEngine";

const mocks = vi.hoisted(() => ({
  translate: vi.fn<TranslationProvider["translate"]>(),
  get: vi.fn<(key: string) => Promise<string | undefined>>(),
  set: vi.fn<(key: string, value: string) => Promise<void>>()
}));
vi.mock("./providers", () => ({ getProvider: () => ({ translate: mocks.translate }) }));
vi.mock("../shared/storage", () => ({
  getCachedTranslation: mocks.get,
  setCachedTranslation: mocks.set
}));
const segments: TextSegment[] = [
  { id: "a", text: "Hello" },
  { id: "b", text: "World" }
];
const settings = (overrides: Partial<ExtensionSettings> = {}): ExtensionSettings => ({
  ...DEFAULT_SETTINGS,
  cacheMode: "disabled",
  ...overrides
});
const run = (
  items = segments,
  config = settings(),
  signal = new AbortController().signal,
  emit?: (r: { id: string; text: string }) => void
) => translateSegments(items, config, signal, emit);
const translate = (items: TextSegment[]) => items.map((s) => ({ id: s.id, text: `T:${s.text}` }));

beforeEach(() => {
  clearSessionCache();
  vi.resetAllMocks();
  mocks.translate.mockImplementation(async (items: TextSegment[]) => translate(items));
  mocks.get.mockResolvedValue(undefined);
  mocks.set.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("translation engine", () => {
  it("packs a viewport into one request and publishes streamed objects", async () => {
    const emit = vi.fn();
    mocks.translate.mockImplementation(
      async (items: TextSegment[], _settings, options: ProviderRequestOptions = {}) => {
        const results = translate(items);
        options.onTranslation?.(results[0]);
        return results.reverse();
      }
    );
    const result = await run(segments, settings(), undefined, emit);
    expect(result.results).toEqual(translate(segments));
    expect(result.metrics).toMatchObject({
      requests: 1,
      retries: 0,
      cacheHits: 0,
      inputCharacters: 10
    });
    expect(emit.mock.calls[0][0]).toEqual({ id: "a", text: "T:Hello" });
    expect(mocks.translate.mock.calls[0][2]).toMatchObject({
      streaming: true,
      maxOutputTokens: 4096
    });
  });
  it("deduplicates equal text with equal context and maps aliases back", async () => {
    const items = [
      { id: "a", text: "Same" },
      { id: "b", text: "Same" }
    ];
    expect((await run(items)).results).toEqual(translate(items));
    expect(mocks.translate.mock.calls[0][0]).toHaveLength(1);
  });
  it("includes context, prompt, provider, model and languages in cache identity", async () => {
    const config = settings({ cacheMode: "session" });
    await run(segments, config);
    expect((await run(segments, config)).metrics).toMatchObject({ requests: 0, cacheHits: 2 });
    await run([{ ...segments[0], contextBefore: "New context" }], config);
    await run(segments, { ...config, model: "different" });
    expect(mocks.translate).toHaveBeenCalledTimes(3);
    clearSessionCache();
    await run(segments, config);
    expect(mocks.translate).toHaveBeenCalledTimes(4);
  });
  it("reads persistent cache and survives failed cache reads and writes", async () => {
    mocks.get.mockResolvedValueOnce("Cached").mockRejectedValueOnce(new Error("quota"));
    mocks.set.mockRejectedValue(new Error("quota"));
    const result = await run(segments, settings({ cacheMode: "persistent" }));
    expect(result.results[0]).toEqual({ id: "a", text: "Cached" });
    expect(result.metrics.cacheHits).toBe(1);
    expect(mocks.set).toHaveBeenCalledTimes(1);
  });
  it("retries only omitted IDs and retains completed results", async () => {
    mocks.translate.mockResolvedValueOnce([{ id: "b", text: "Monde" }]);
    const result = await run();
    expect(mocks.translate.mock.calls[1][0]).toEqual([segments[0]]);
    expect(result.results).toEqual([
      { id: "a", text: "T:Hello" },
      { id: "b", text: "Monde" }
    ]);
    expect(result.metrics).toMatchObject({ requests: 2, retries: 1 });
  });
  it("reports partial results after the retry limit", async () => {
    mocks.translate.mockResolvedValue([{ id: "a", text: "Bonjour" }]);
    const result = await run();
    expect(result.error).toMatch(/omitted/);
    expect(result.results).toHaveLength(1);
  });
  it("throws for an empty answer and accepts an empty input", async () => {
    mocks.translate.mockResolvedValue([]);
    await expect(run()).rejects.toThrow(/omitted/);
    expect((await run([])).results).toEqual([]);
  });
  it.each([
    { items: [{ id: "", text: "hello" }] },
    { items: [{ id: "a", text: " " }] },
    { items: [{ id: "a", text: "x".repeat(100001) }] },
    {
      items: [
        { id: "a", text: "x" },
        { id: "a", text: "y" }
      ]
    }
  ])("rejects invalid segments", async ({ items }) => {
    await expect(run(items)).rejects.toThrow(/unique IDs/);
  });
  it.each([
    new TypeError("offline"),
    new ProviderHttpError(429, "busy", "0"),
    new ProviderHttpError(503, "busy")
  ])("retries transient failures", async (error) => {
    mocks.translate.mockRejectedValueOnce(error);
    expect((await run()).metrics).toMatchObject({ requests: 2, retries: 1 });
  });
  it.each([
    new Error("bad JSON"),
    new ProviderHttpError(401, "bad key"),
    new ProviderHttpError(429, "wait", "60")
  ])("does not retry permanent or long rate-limit failures", async (error) => {
    mocks.translate.mockRejectedValue(error);
    await expect(run()).rejects.toThrow();
    expect(mocks.translate).toHaveBeenCalledTimes(1);
  });
  it("stops after the configured retry count", async () => {
    mocks.translate.mockRejectedValue(new TypeError("offline"));
    await expect(run()).rejects.toThrow("offline");
    expect(mocks.translate).toHaveBeenCalledTimes(2);
  });
  it("splits large paragraphs and joins translated chunks under original IDs", async () => {
    const result = await run(
      [{ id: "chunk-0", text: "Large sentence. ".repeat(100) }],
      settings({
        execution: { inputTokenBudget: 256, maxOutputTokens: 512 },
        targetLanguage: "Japanese"
      })
    );
    expect(result.results[0].id).toBe("chunk-0");
    expect(result.results[0].text.split("T:").length).toBeGreaterThan(2);
    expect(mocks.translate.mock.calls.length).toBeGreaterThan(2);
    expect(
      mocks.translate.mock.calls
        .flatMap(([items]) => items)
        .every((s: TextSegment) => s.text.length < 300)
    ).toBe(true);
  });
  it("limits boundary context", async () => {
    await run([
      { id: "a", text: "Hi", contextBefore: "b".repeat(1000), contextAfter: "a".repeat(1000) }
    ]);
    expect(mocks.translate.mock.calls[0][0][0].contextBefore).toHaveLength(80);
  });
  it("propagates cancellation to an active provider fetch", async () => {
    const controller = new AbortController();
    mocks.translate.mockImplementation(
      (_items, _config, options: ProviderRequestOptions = {}) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason));
          controller.abort(new Error("Cancelled"));
        })
    );
    await expect(run(segments, settings(), controller.signal)).rejects.toThrow("Cancelled");
  });
  it("honors the request deadline without retrying a timed out fetch", async () => {
    vi.useFakeTimers();
    mocks.translate.mockImplementation(
      (_items, _config, options: ProviderRequestOptions = {}) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason));
        })
    );
    const promise = run(segments, settings({ execution: { timeoutMs: 1000 } }));
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(mocks.translate).toHaveBeenCalled(), { interval: 1 });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(mocks.translate).toHaveBeenCalledTimes(1);
  });
  it("cancels retry backoff", async () => {
    const controller = new AbortController();
    mocks.translate.mockRejectedValue(new TypeError("offline"));
    const promise = run(segments, settings(), controller.signal);
    setTimeout(() => controller.abort(new Error("Stopped")), 30);
    await expect(promise).rejects.toThrow("Stopped");
  });
});
