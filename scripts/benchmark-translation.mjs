// Isolated Chromium extension benchmark. Only --live sends public page text to
// OpenRouter, and only a model with an explicit :free ID may be selected.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const live = process.argv.includes("--live");
const baseline = process.argv.includes("--baseline");
const checkCache = live || process.argv.includes("--cache");
const model = process.env.BENCHMARK_MODEL ?? "liquid/lfm-2.5-2.6b:free";
if (live) assert(model.endsWith(":free") || model === "openrouter/free", "Select a free model.");
const output = resolve(root, "../analysis");
await mkdir(output, { recursive: true });
const extension = baseline
  ? resolve(process.env.BASELINE_EXTENSION ?? join(output, "baseline-extension"))
  : join(root, "apps/extension/dist");
const profile = await mkdtemp(join(tmpdir(), "margin-benchmark-"));
const records = [];
const fixture = `<!doctype html><html><head><title>Translation performance fixture</title><style>body{font:16px/1.3 system-ui;margin:24px;max-width:1200px}p{margin:10px 0}#hidden{display:none}</style></head><body><main><h1>How a browser translates a web page</h1>${Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i + 1}: A browser extension can translate this useful sentence while preserving the <strong>original text</strong> and a <a href="https://example.com/">working link</a>.</p>`).join("")}<p id="hidden">This hidden secret should never be sent for translation.</p><pre>const code = "do not translate";</pre></main></body></html>`;
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Content-Type", "text/html");
    res.end(fixture);
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const payload = JSON.parse(body.messages[1].content);
  records.push({
    count: payload.segments.length,
    characters: payload.segments.reduce((n, s) => n + s.text.length, 0),
    stream: body.stream === true,
    texts: payload.segments.flatMap((s) => [s.text, s.contextBefore ?? "", s.contextAfter ?? ""])
  });
  const translations = payload.segments.map((s) => ({ id: s.id, text: `FR : ${s.text}` }));
  if (!body.stream) {
    await new Promise((r) => setTimeout(r, 250 + translations.length * 40));
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] })
    );
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.flushHeaders();
  const send = (content) =>
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  await new Promise((r) => setTimeout(r, 250));
  send('{"translations":[');
  for (let i = 0; i < translations.length && !res.destroyed; i++) {
    await new Promise((r) => setTimeout(r, 40));
    send(`${i ? "," : ""}${JSON.stringify(translations[i])}`);
  }
  if (!res.destroyed) {
    send("]}");
    res.end("data: [DONE]\n\n");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const address = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      if ((await chrome.storage.local.get("margin.settings"))["margin.settings"]) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  let apiKey = "";
  if (live) {
    const env = await readFile(join(root, "../.env"), "utf8");
    apiKey = /^OPENROUTER_API_KEY\s*=\s*["']?([^\r\n"']+)/m.exec(env)?.[1]?.trim() ?? "";
    assert(apiKey.startsWith("sk-or-"), "OpenRouter key is missing from ../.env");
  }
  await worker.evaluate(
    async ({ endpoint, apiKey, model, cacheEnabled, maxOutputTokens }) => {
      await chrome.storage.local.set({
        "margin.settings": {
          version: 1,
          provider: "openai-compatible",
          providerEndpoint: endpoint,
          apiKey,
          model,
          sourceLanguage: "auto",
          targetLanguage: "French",
          displayStyle: "balanced",
          cacheMode: cacheEnabled ? "session" : "disabled",
          debugMode: true,
          showTranslationLabel: false,
          showFloatingButton: false,
          openAICompatibleJsonMode: true,
          execution: { mode: "cloud", scope: "viewport", timeoutMs: 45000, maxOutputTokens },
          siteAdapters: {
            x: {
              enabled: true,
              translateArticles: true,
              quotedPosts: false,
              skipNativeTranslated: true
            }
          }
        }
      });
      globalThis.benchmarkRequests = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body);
          const payload = JSON.parse(body.messages[1].content);
          globalThis.benchmarkRequests.push({
            count: payload.segments.length,
            characters: payload.segments.reduce((n, s) => n + s.text.length, 0),
            stream: body.stream === true
          });
        }
        return originalFetch(url, init);
      };
    },
    {
      endpoint: live
        ? "https://openrouter.ai/api/v1/chat/completions"
        : `${address}/v1/chat/completions`,
      apiKey,
      model,
      cacheEnabled: checkCache && !baseline,
      maxOutputTokens: Number(process.env.BENCHMARK_OUTPUT ?? 4096)
    }
  );
  const page = await context.newPage();
  const url =
    process.env.BENCHMARK_URL ?? (live ? "https://en.wikipedia.org/wiki/Web_browser" : address);
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    for (const element of document.body.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom >= 0 && rect.top <= innerHeight)
        element.setAttribute("data-benchmark-visible", "true");
    }
  });
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
    page.url()
  );
  assert(tabId !== undefined, "The benchmark tab was not found.");
  const start = Date.now();
  await worker.evaluate(
    (tabId) => chrome.tabs.sendMessage(tabId, { type: "TOGGLE_TRANSLATION", enabled: true }),
    tabId
  );
  const visibleSources = await page
    .locator("[data-benchmark-visible][data-margin-block-id]")
    .count();
  let firstMs;
  let debug;
  let completeMs;
  for (let i = 0; i < 650; i++) {
    const state = await worker.evaluate(
      (tabId) => chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_STATE" }),
      tabId
    );
    debug = state.debug;
    if (debug.translatedBlocks && firstMs === undefined) firstMs = Date.now() - start;
    const visibleDone = await page
      .locator('[data-benchmark-visible][data-margin-translated="done"]')
      .count();
    if (
      (baseline && visibleSources > 0 && visibleDone === visibleSources) ||
      (debug.queueSize === 0 &&
        debug.runningRequests === 0 &&
        (debug.translatedBlocks || debug.errorBlocks || debug.lastError))
    ) {
      completeMs = Date.now() - start;
      break;
    }
    await page.waitForTimeout(100);
  }
  const requestSummary = await worker.evaluate(() => globalThis.benchmarkRequests);
  const translated = await page.locator(".margin-translation[data-state=done]").allTextContents();
  const label = `${live ? "live" : "fixture"}-${baseline ? "baseline" : "fork"}${live ? `-${model.replace(/[^a-z0-9-]/gi, "_")}` : ""}`;
  const screenshot = join(output, `${label}.png`);
  await page.screenshot({ path: screenshot });
  let warmMs;
  let warmRequests;
  let warmDebug;
  if (checkCache && !baseline && translated.length && debug.errorBlocks === 0) {
    await worker.evaluate(
      (tabId) => chrome.tabs.sendMessage(tabId, { type: "TOGGLE_TRANSLATION", enabled: false }),
      tabId
    );
    const before = requestSummary.length;
    const warmStart = Date.now();
    await worker.evaluate(
      (tabId) => chrome.tabs.sendMessage(tabId, { type: "TOGGLE_TRANSLATION", enabled: true }),
      tabId
    );
    await page.locator('[data-margin-translated="done"]').first().waitFor({ timeout: 5000 });
    for (let i = 0; i < 50; i++) {
      const state = await worker.evaluate(
        (tabId) => chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_STATE" }),
        tabId
      );
      warmDebug = state.debug;
      if (!state.debug.queueSize && !state.debug.runningRequests) break;
      await page.waitForTimeout(20);
    }
    warmMs = Date.now() - warmStart;
    warmRequests = (await worker.evaluate(() => globalThis.benchmarkRequests.length)) - before;
    assert.equal(warmRequests, 0, "A warm viewport should use the cache.");
  }
  const result = {
    mode: live ? "live" : "fixture",
    baseline,
    url,
    model: live ? model : "deterministic mock",
    visibleSources,
    warmMs,
    warmRequests,
    warmDebug,
    firstMs,
    completeMs,
    debug,
    requests: requestSummary,
    excludedTextSent: live
      ? undefined
      : records.some(
          (r) =>
            r.texts.join(" ").includes("hidden secret") || r.texts.join(" ").includes("const code")
        ),
    translatedSamples: translated.slice(0, 3),
    screenshot
  };
  await writeFile(join(output, `${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (warmDebug)
    assert(
      warmDebug.translatedBlocks === warmDebug.enqueuedBlocks &&
        !warmDebug.runningRequests &&
        !warmDebug.queueSize,
      "The warm viewport must finish all requested blocks."
    );
  assert(translated.length > 0, `No translations: ${debug?.lastError ?? "deadline"}`);
  if (!baseline)
    assert(
      completeMs !== undefined && debug.pendingBlocks === 0 && debug.errorBlocks === 0,
      "Every requested block must finish successfully."
    );
  if (live && url.includes("en.wikipedia.org"))
    assert(
      translated.some((text) =>
        /navigateur|logiciel|encyclopédie|requête|utilisés|accéder/i.test(text)
      ),
      "The model returned source text instead of French translations."
    );
  if (!live && url === address) {
    assert.equal(await page.locator("main p a").count(), 12, "Original links must survive");
    if (!baseline)
      assert(
        records.every(
          (r) =>
            !r.texts.join(" ").includes("hidden secret") &&
            !r.texts.join(" ").includes("const code")
        ),
        "Hidden and code text must stay out of the prompt"
      );
    assert(!requestSummary.some((r) => r.characters > 10000));
    if (!baseline) {
      assert.equal(requestSummary.length, 1, "The visible fixture should fit one request");
      assert.equal(debug.errorBlocks, 0);
    }
  }
  if (!live && url === address && !baseline && process.argv.includes("--checks")) {
    await page.evaluate(() => {
      document.querySelector("main p").textContent =
        "This revised paragraph must get its own translation after the page updates.";
    });
    await page.waitForTimeout(180);
    await page.evaluate(() => {
      document.querySelector("main p").firstChild.textContent =
        "This newer source must win even when an older translation is still in flight.";
    });
    await page.waitForFunction(
      () =>
        document.querySelector("main p")?.nextElementSibling?.textContent ===
        "FR : This newer source must win even when an older translation is still in flight."
    );
    const beforeScroll = records.length;
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.id = "scroll-target";
      p.style.marginTop = "2000px";
      p.textContent =
        "Translate this newly visible paragraph only after the reader scrolls down to it.";
      document.querySelector("main").append(p);
    });
    await page.waitForTimeout(250);
    assert.equal(records.length, beforeScroll, "Offscreen additions must not start requests");
    await page.locator("#scroll-target").scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () =>
        document.querySelector("#scroll-target")?.getAttribute("data-margin-translated") === "done"
    );
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.id = "large-target";
      p.textContent = "A lengthy paragraph should be split into bounded requests. ".repeat(100);
      document.querySelector("main").append(p);
    });
    await page.locator("#large-target").scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () =>
        document.querySelector("#large-target")?.getAttribute("data-margin-translated") === "done"
    );
    assert(
      (await page
        .locator("#large-target")
        .evaluate((e) => e.nextElementSibling.textContent.length)) > 5500,
      "Large paragraphs must not disappear"
    );
    await page.evaluate(() => {
      document.querySelector("#large-target").textContent =
        "Cancel this pending translation when the user turns the extension off.";
    });
    await page.waitForTimeout(180);
    await worker.evaluate(
      (tabId) => chrome.tabs.sendMessage(tabId, { type: "TOGGLE_TRANSLATION", enabled: false }),
      tabId
    );
    await page.waitForTimeout(500);
    assert.equal(
      await page.locator(".margin-translation").count(),
      0,
      "Late results must not render after cancellation"
    );
    console.log(
      "Browser checks passed: hidden text, links, source revisions, scrolling, long paragraphs, cancellation."
    );
  }
} finally {
  if (context) {
    await Promise.all(
      context
        .serviceWorkers()
        .map((w) => w.evaluate(() => chrome.storage.local.clear()).catch(() => undefined))
    );
    await context.close();
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  // Guard the absolute resolved path before deleting the disposable profile.
  assert(
    resolve(profile).startsWith(resolve(tmpdir()) + sep) &&
      profile.split(sep).at(-1).startsWith("margin-benchmark-")
  );
  await rm(profile, { recursive: true, force: true });
}
