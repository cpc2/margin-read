import { estimateTokens, getExecutionSettings } from "../shared/execution";
import { normalizeText } from "../shared/text";
import type {
  ExtensionSettings,
  PageDebugState,
  TranslationProviderId,
  TranslationResult,
  TranslationExecutionSettings,
  TranslateBatchResponse
} from "../shared/types";
import type { BlockCandidate } from "./blockCandidates";
import { type TranslationDisplayStyle } from "./displayStyle";
import { createIncludedBlockCandidates } from "./extraction/shared";
import { collectSiteAdapterBlocks } from "./siteAdapters";
import { collectBlockCandidates } from "./textBlocks";
import { isNonReadingElement, isVisibleForReading } from "./readingVisibility";
import { getTranslationLabel } from "../shared/translationLabel";
import {
  BLOCK_ID_ATTR,
  RENDER_STRATEGY_ATTR,
  TRANSLATED_ATTR,
  TRANSLATION_CLASS,
  createTranslationRenderer,
  type TranslationRenderer
} from "./translationRenderer";
import {
  compareQueueItems,
  TranslationQueue,
  type QueuePriority,
  type TranslationQueueItem
} from "./translationQueue";

const MIN_TEXT_LENGTH = 24;
const NEAR_VIEWPORT_MULTIPLIER = 1.5;
const FLOATING_HOST_ATTR = "data-margin-floating-controls";
const PROVIDER_DISPLAY_NAMES: Record<TranslationProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  google: "Google Gemini",
  "openai-compatible": "OpenAI Compatible",
  "anthropic-compatible": "Anthropic Compatible"
};

interface SettingsResponse {
  ok: boolean;
  settings?: Partial<ExtensionSettings>;
}

export interface ContentOrchestrator {
  setEnabled(nextEnabled: boolean): Promise<void>;
  isEnabled(): boolean;
  getDebugState(): PageDebugState;
  acceptProgress(sessionId: string, requestId: string, results: TranslationResult[]): void;
}

export interface ContentOrchestratorOptions {
  onEnabledChange: (enabled: boolean) => void;
}

export function createOrchestrator(options: ContentOrchestratorOptions): ContentOrchestrator {
  const { onEnabledChange } = options;

  let enabled = false;
  let observer: MutationObserver | undefined;
  let viewportObserver: IntersectionObserver | undefined;
  let pending = false;
  let nextId = 1;
  let runId = 0;
  let sessionId = "";
  let nextRequest = 0;
  let execution: TranslationExecutionSettings = getExecutionSettings({ providerEndpoint: "" });
  const sourceText = new Map<string, string>();
  const requests = new Map<string, Set<string>>();
  const initialViewport = new Set<string>();
  let displayStyle: TranslationDisplayStyle = "balanced";
  let showTranslationLabel = false;
  let targetLanguage = "English";
  let translationLabel = getTranslationLabel(targetLanguage);
  let debugMode = false;
  let xOptimizedTranslation = true;
  let xTranslateArticles = true;
  let xTranslateQuotedPosts = false;
  let xSkipNativeTranslatedPosts = true;
  let providerConfig: PageDebugState["providerConfig"];
  let debugState: PageDebugState = createDebugState();

  const blockMap = new Map<string, HTMLElement>();
  const candidateByElement = new WeakMap<HTMLElement, BlockCandidate>();
  const queue = new TranslationQueue<HTMLElement>({
    batchSize: 64,
    concurrency: 3,
    tokenBudget: execution.inputTokenBudget,
    itemTokens: (element) => 32 + estimateTokens(readSourceText(element)),
    worker: translateBlocks
  });
  const renderer: TranslationRenderer = createTranslationRenderer({
    displayStyle,
    showTranslationLabel,
    translationLabel,
    targetLanguage,
    blockMap,
    onRetry: (block) => {
      block.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
      if (block.nextElementSibling?.classList.contains(TRANSLATION_CLASS))
        block.nextElementSibling.remove();
      const candidate = candidateByElement.get(block);
      if (candidate) queue.enqueue([createQueueItem(candidate)]);
    }
  });

  async function setEnabled(nextEnabled: boolean): Promise<void> {
    if (nextEnabled === enabled) {
      onEnabledChange(enabled);
      return;
    }

    enabled = nextEnabled;
    if (enabled) {
      await startTranslation();
    } else {
      stopTranslation();
    }
    onEnabledChange(enabled);
  }

  async function startTranslation(): Promise<void> {
    runId += 1;
    const startingRunId = runId;
    sessionId = crypto.randomUUID();
    observer?.disconnect();
    observer = undefined;
    try {
      const response: SettingsResponse = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
      if (!enabled || runId !== startingRunId) return;
      displayStyle = response.settings?.displayStyle ?? "balanced";
      showTranslationLabel = response.settings?.showTranslationLabel ?? false;
      targetLanguage = response.settings?.targetLanguage ?? targetLanguage;
      translationLabel = getTranslationLabel(targetLanguage);
      renderer.setDisplayStyle(displayStyle);
      renderer.setTranslationLabel(showTranslationLabel, translationLabel);
      renderer.setTargetLanguage(targetLanguage);
      debugMode = response.settings?.debugMode ?? false;
      const selectedProvider = response.settings?.provider ?? "openai";
      providerConfig = createProviderDebugConfig(response.settings, selectedProvider);
      const xConfig = response.settings?.siteAdapters?.x;
      xOptimizedTranslation = xConfig?.enabled ?? true;
      xTranslateArticles = xConfig?.translateArticles ?? true;
      xTranslateQuotedPosts = xConfig?.quotedPosts ?? false;
      xSkipNativeTranslatedPosts = xConfig?.skipNativeTranslated ?? true;
      debugState = {
        ...createDebugState(),
        startedAt: Date.now(),
        debugMode,
        enabled
      };
      execution = getExecutionSettings({
        providerEndpoint: response.settings?.providerEndpoint ?? "",
        execution: response.settings?.execution
      });
      queue.configure({
        batchSize: 64,
        concurrency: execution.concurrency,
        tokenBudget: Math.min(
          execution.inputTokenBudget,
          Math.floor(execution.maxOutputTokens / 2) - 96
        )
      });
      startViewportObserver();
      scanAndQueue();
    } catch (error: unknown) {
      if (!enabled || runId !== startingRunId) return;
      recordError(error instanceof Error ? error.message : "Could not load extension settings.");
    }
    observer = new MutationObserver((mutations) => {
      if (!enabled || pending) {
        return;
      }
      if (mutations.every(isMarginMutation)) {
        return;
      }
      pending = true;
      window.setTimeout(() => {
        pending = false;
        scanAndQueue();
      }, 120);
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  function stopTranslation(): void {
    runId += 1;
    void chrome.runtime
      .sendMessage({ type: "CANCEL_TRANSLATION", sessionId })
      .catch(() => undefined);
    queue.clear();
    observer?.disconnect();
    observer = undefined;
    viewportObserver?.disconnect();
    viewportObserver = undefined;
    document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
    document.querySelectorAll(`[${TRANSLATED_ATTR}]`).forEach((node) => {
      node.removeAttribute(TRANSLATED_ATTR);
      node.removeAttribute(BLOCK_ID_ATTR);
      node.removeAttribute(RENDER_STRATEGY_ATTR);
    });
    blockMap.clear();
    sourceText.clear();
    requests.clear();
    initialViewport.clear();
    debugState = createDebugState();
    debugState.debugMode = debugMode;
    debugState.enabled = false;
  }

  function scanAndQueue(): void {
    if (!enabled) {
      return;
    }

    // A SPA can reuse the same element for a different paragraph. Invalidate its
    // old ID so neither a streamed nor a late final reply can overwrite new text.
    for (const [id, element] of blockMap) {
      if (element.isConnected && sourceText.get(id) === sourceFingerprint(element)) continue;
      blockMap.delete(id);
      sourceText.delete(id);
      initialViewport.delete(id);
      if (element.nextElementSibling?.classList.contains(TRANSLATION_CLASS))
        element.nextElementSibling.remove();
      element.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
      element.removeAttribute(TRANSLATED_ATTR);
      element.removeAttribute(BLOCK_ID_ATTR);
    }

    const textBlockOptions = {
      minTextLength: MIN_TEXT_LENGTH,
      translatedAttr: TRANSLATED_ATTR,
      translationClass: TRANSLATION_CLASS,
      xOptimizedTranslation,
      xTranslateArticles,
      xTranslateQuotedPosts,
      xSkipNativeTranslatedPosts
    };
    const adapterResult = collectSiteAdapterBlocks(document, textBlockOptions);
    const candidates = adapterResult.matched
      ? createIncludedBlockCandidates(adapterResult.blocks, "adapter", textBlockOptions)
      : collectBlockCandidates(document, textBlockOptions);
    rememberCandidates(candidates);
    const initialQueueItems = candidates
      .map(createQueueItem)
      .sort(compareQueueItems)
      .filter((item) => execution.scope === "page" || item.priority === 0);
    if (debugState.viewportCompleteDurationMs === undefined) {
      for (const item of initialQueueItems) if (item.priority === 0) initialViewport.add(item.id);
    }
    debugState.lastScanAt = Date.now();
    debugState.detectedBlocks = candidates.length;
    debugState.enqueuedBlocks += initialQueueItems.length;
    debugState.sampleText = getSampleText(candidates);
    if (candidates.length === 0) {
      debugState.lastError = "No readable text blocks were detected on this page.";
    }
    queue.enqueue(initialQueueItems);
    for (const candidate of candidates) {
      viewportObserver?.observe(candidate.element);
    }
    updateDebugCounts();
  }

  async function translateBlocks(blocks: HTMLElement[]): Promise<void> {
    const activeRunId = runId;
    blocks = blocks.filter((block) => block.isConnected && !block.hasAttribute(TRANSLATED_ATTR));
    if (!blocks.length || !enabled) return;
    blocks.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    const requestId = String(++nextRequest);
    const segments = blocks.map((element, index) => {
      const id = element.getAttribute(BLOCK_ID_ATTR) ?? `block-${nextId++}`;
      element.setAttribute(BLOCK_ID_ATTR, id);
      element.setAttribute(TRANSLATED_ATTR, "pending");
      blockMap.set(id, element);
      const text = readSourceText(element);
      sourceText.set(id, sourceFingerprint(element));
      return {
        id,
        text,
        ...(index === 0
          ? { contextBefore: getSiblingText(element, "previousElementSibling") }
          : {}),
        ...(index === blocks.length - 1
          ? { contextAfter: getSiblingText(element, "nextElementSibling") }
          : {})
      };
    });
    requests.set(requestId, new Set(segments.map((segment) => segment.id)));

    renderer.insertPendingState(blocks);
    updateDebugCounts();

    let response: TranslateBatchResponse;
    const requestStartedAt = Date.now();
    recordProviderRequestStarted(requestStartedAt);
    try {
      response = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        sessionId,
        requestId,
        segments
      });
      recordProviderRequestFinished(requestStartedAt);
    } catch (error) {
      requests.delete(requestId);
      if (!enabled || activeRunId !== runId) return;
      recordProviderRequestFinished(requestStartedAt);
      const message = error instanceof Error ? error.message : "Provider request failed.";
      recordError(message);
      renderer.insertErrorState(blocks.filter(isCurrentSource), message);
      updateDebugCounts();
      return;
    }

    if (!enabled || activeRunId !== runId) {
      return;
    }
    requests.delete(requestId);
    debugState.requestCount = (debugState.requestCount ?? 0) + (response.metrics?.requests ?? 1);
    debugState.cacheHits = (debugState.cacheHits ?? 0) + (response.metrics?.cacheHits ?? 0);

    if (!response.ok || !response.results) {
      const message = response.error ?? "Translation failed.";
      recordError(message);
      renderer.insertErrorState(blocks.filter(isCurrentSource), message);
      updateDebugCounts();
      return;
    }

    applyCurrentTranslations(response.results);
    const translatedIds = new Set(response.results.map((result) => result.id));
    const missingBlocks = segments
      .filter((segment) => !translatedIds.has(segment.id))
      .map((segment) => blockMap.get(segment.id))
      .filter((element): element is HTMLElement => Boolean(element) && isCurrentSource(element!));

    if (missingBlocks.length > 0) {
      const message = "The provider did not return a translation for this block.";
      recordError(message);
      renderer.insertErrorState(missingBlocks, message);
    }
    updateDebugCounts();
  }

  function startViewportObserver(): void {
    viewportObserver?.disconnect();
    viewportObserver = new IntersectionObserver(
      (entries) => {
        const candidates = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => entry.target)
          .filter(
            (target): target is HTMLElement =>
              target instanceof HTMLElement && !target.hasAttribute(TRANSLATED_ATTR)
          )
          .map((element) => candidateByElement.get(element))
          .filter((candidate): candidate is BlockCandidate => Boolean(candidate));

        if (candidates.length > 0) {
          debugState.enqueuedBlocks += candidates.length;
          queue.enqueue(candidates.map(createQueueItem));
          updateDebugCounts();
        }
      },
      {
        root: null,
        rootMargin: "0px"
      }
    );
  }

  function createQueueItem(candidate: BlockCandidate): TranslationQueueItem<HTMLElement> {
    const { element } = candidate;
    const id = element.getAttribute(BLOCK_ID_ATTR) ?? `block-${nextId++}`;
    element.setAttribute(BLOCK_ID_ATTR, id);
    return {
      id,
      priority: getQueuePriority(element),
      contentPriority: candidate.priority,
      distance: getViewportDistance(element),
      value: element
    };
  }

  function isCurrentSource(element: HTMLElement): boolean {
    const id = element.getAttribute(BLOCK_ID_ATTR);
    return Boolean(id && element.isConnected && sourceText.get(id) === sourceFingerprint(element));
  }

  function applyCurrentTranslations(results: TranslationResult[]): void {
    const valid = results.filter((result) => {
      const element = blockMap.get(result.id);
      return element && isCurrentSource(element);
    });
    if (valid.length && debugState.firstTranslationDurationMs === undefined) {
      debugState.firstTranslationDurationMs = Date.now() - (debugState.startedAt ?? Date.now());
    }
    renderer.applyTranslations(valid);
    for (const result of valid) initialViewport.delete(result.id);
    if (
      valid.length &&
      !initialViewport.size &&
      debugState.viewportCompleteDurationMs === undefined
    ) {
      debugState.viewportCompleteDurationMs = Date.now() - (debugState.startedAt ?? Date.now());
    }
    updateDebugCounts();
  }

  function acceptProgress(
    progressSession: string,
    requestId: string,
    results: TranslationResult[]
  ): void {
    if (!enabled || progressSession !== sessionId) return;
    const expected = requests.get(requestId);
    if (expected) applyCurrentTranslations(results.filter((result) => expected.has(result.id)));
  }

  function createDebugState(): PageDebugState {
    const state: PageDebugState = {
      debugMode,
      enabled,
      detectedBlocks: 0,
      enqueuedBlocks: 0,
      queueSize: 0,
      runningRequests: 0,
      pendingBlocks: 0,
      translatedBlocks: 0,
      errorBlocks: 0
    };
    if (providerConfig) {
      state.providerConfig = providerConfig;
    }
    return state;
  }

  function createProviderDebugConfig(
    settings: Partial<ExtensionSettings> | undefined,
    provider: TranslationProviderId
  ): PageDebugState["providerConfig"] {
    return {
      provider,
      providerName: PROVIDER_DISPLAY_NAMES[provider],
      model: settings?.model?.trim() || "unknown",
      endpoint: sanitizeEndpoint(settings?.providerEndpoint),
      structuredOutput: getStructuredOutputMode(settings, provider),
      extensionVersion: getExtensionVersion()
    };
  }

  function getStructuredOutputMode(
    settings: Partial<ExtensionSettings> | undefined,
    provider: TranslationProviderId
  ): string {
    if (provider === "google") return "responseJsonSchema";
    if (provider === "openai") return "json_schema";
    if (provider === "anthropic" || provider === "anthropic-compatible") return "tool input_schema";
    return settings?.openAICompatibleJsonMode
      ? sanitizeEndpoint(settings.providerEndpoint).startsWith("https://openrouter.ai/")
        ? "json_schema"
        : "json_object"
      : "prompt only";
  }

  function getDebugStateSnapshot(): PageDebugState {
    updateDebugCounts();
    return {
      ...debugState,
      debugMode,
      enabled
    };
  }

  function updateDebugCounts(): void {
    debugState.queueSize = queue.size;
    debugState.runningRequests = queue.running;
    if (!debugMode) return;
    debugState.pendingBlocks = document.querySelectorAll(`[${TRANSLATED_ATTR}="pending"]`).length;
    debugState.translatedBlocks = document.querySelectorAll(`[${TRANSLATED_ATTR}="done"]`).length;
    debugState.errorBlocks = document.querySelectorAll(`[${TRANSLATED_ATTR}="error"]`).length;
  }

  function recordError(message: string): void {
    debugState.lastError = message;
    updateDebugCounts();
  }

  function recordProviderRequestStarted(startedAt: number): void {
    debugState.lastProviderRequestStartedAt = startedAt;
    updateDebugCounts();
  }

  function recordProviderRequestFinished(startedAt: number): void {
    const finishedAt = Date.now();
    debugState.lastProviderRequestFinishedAt = finishedAt;
    debugState.lastProviderDurationMs = Math.max(0, finishedAt - startedAt);
    updateDebugCounts();
  }

  function rememberCandidates(candidates: BlockCandidate[]): void {
    for (const candidate of candidates) {
      candidate.element.setAttribute(RENDER_STRATEGY_ATTR, candidate.renderStrategy);
      candidateByElement.set(candidate.element, candidate);
    }
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    getDebugState: getDebugStateSnapshot,
    acceptProgress
  };
}

function sanitizeEndpoint(endpoint: string | undefined): string {
  const value = endpoint?.trim();
  if (!value) return "unknown";

  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return stripTrailingSlash(url.toString());
  } catch {
    return stripTrailingSlash(value.split(/[?#]/)[0] || "unknown");
  }
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/$/, "") : value;
}

function getExtensionVersion(): string | undefined {
  try {
    return chrome.runtime.getManifest?.().version;
  } catch {
    return undefined;
  }
}

function getQueuePriority(element: HTMLElement): QueuePriority {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  if (rect.bottom >= 0 && rect.top <= viewportHeight) {
    return 0;
  }
  if (
    rect.top <= viewportHeight * (1 + NEAR_VIEWPORT_MULTIPLIER) &&
    rect.bottom >= -viewportHeight * NEAR_VIEWPORT_MULTIPLIER
  ) {
    return 1;
  }
  return 2;
}

function getViewportDistance(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  if (rect.bottom >= 0 && rect.top <= viewportHeight) {
    return 0;
  }
  return Math.min(Math.abs(rect.top - viewportHeight), Math.abs(rect.bottom));
}

function isMarginMutation(mutation: MutationRecord): boolean {
  const target =
    mutation.target instanceof HTMLElement ? mutation.target : mutation.target.parentElement;
  if (target?.closest(`.${TRANSLATION_CLASS}, [${FLOATING_HOST_ATTR}]`)) {
    return true;
  }

  const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
  return nodes.length > 0 && nodes.every(isMarginManagedNode);
}

function isMarginManagedNode(node: Node): boolean {
  if (!(node instanceof HTMLElement)) {
    return false;
  }

  return (
    node.classList.contains(TRANSLATION_CLASS) ||
    node.hasAttribute(FLOATING_HOST_ATTR) ||
    node.dataset.marginLegacyBlock === "true" ||
    node.dataset.marginBrSeparatedBlock === "true" ||
    node.dataset.marginInlineRunBlock === "true" ||
    node.dataset.marginLayout === "table-cell"
  );
}

function getSiblingText(
  element: HTMLElement,
  key: "previousElementSibling" | "nextElementSibling"
): string | undefined {
  let sibling = element[key];
  while (sibling?.classList.contains(TRANSLATION_CLASS)) sibling = sibling[key];
  if (!(sibling instanceof HTMLElement)) {
    return undefined;
  }
  if (isNonReadingElement(sibling, TRANSLATION_CLASS) || !isVisibleForReading(sibling))
    return undefined;
  const text = readSourceText(sibling);
  return text.length > 0 ? text.slice(0, 80) : undefined;
}

function readSourceText(element: HTMLElement): string {
  if (!element.querySelector(`.${TRANSLATION_CLASS}`))
    return normalizeText(element.innerText ?? element.textContent ?? "");
  return sourceFingerprint(element);
}

function sourceFingerprint(element: HTMLElement): string {
  if (!element.querySelector(`.${TRANSLATION_CLASS}`))
    return normalizeText(element.textContent ?? "");
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
  return normalizeText(copy.textContent ?? "");
}

function getSampleText(candidates: BlockCandidate[]): string | undefined {
  const sample = candidates.map((candidate) => candidate.text).find((text) => text.length > 0);
  return sample?.slice(0, 160);
}
