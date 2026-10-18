import { getExecutionSettings, packSegments, splitText } from "../shared/execution";
import { hashText } from "../shared/hash";
import { getCachedTranslation, setCachedTranslation } from "../shared/storage";
import type {
  ExtensionSettings,
  TextSegment,
  TranslationMetrics,
  TranslationResult
} from "../shared/types";
import { getProvider } from "./providers";
import { ProviderHttpError } from "./providers/shared";

const PROMPT_VERSION = 3;
const MAX_SESSION_ENTRIES = 2000;
const sessionCache = new Map<string, string>();

export function clearSessionCache(): void {
  sessionCache.clear();
}

interface Group {
  segment: TextSegment;
  aliases: string[];
  key: string;
  parts: TextSegment[];
}

export async function translateSegments(
  segments: TextSegment[],
  settings: ExtensionSettings,
  signal: AbortSignal,
  emit?: (result: TranslationResult) => void
): Promise<{ results: TranslationResult[]; metrics: TranslationMetrics; error?: string }> {
  const started = Date.now();
  const execution = getExecutionSettings(settings);
  const metrics: TranslationMetrics = {
    requests: 0,
    cacheHits: 0,
    retries: 0,
    inputCharacters: 0,
    totalMs: 0
  };
  const results = new Map<string, TranslationResult>();
  const publish = (result: TranslationResult, final = false): void => {
    signal.throwIfAborted();
    if (metrics.firstResultMs === undefined) metrics.firstResultMs = Date.now() - started;
    if (final) results.set(result.id, result);
    emit?.(result);
  };
  const groups = new Map<string, Group>();
  const ids = new Set<string>();
  for (const segment of segments) {
    if (
      !segment.id ||
      ids.has(segment.id) ||
      !segment.text?.trim() ||
      segment.text.length > 100000
    ) {
      throw new Error(
        "Translation requires unique IDs and nonempty text below 100,000 characters."
      );
    }
    ids.add(segment.id);
  }
  await Promise.all(
    segments.map(async (segment) => {
      const key = await hashText(
        JSON.stringify({
          version: PROMPT_VERSION,
          endpoint: settings.providerEndpoint,
          provider: settings.provider,
          model: settings.model,
          source: settings.sourceLanguage,
          target: settings.targetLanguage,
          text: segment.text,
          before: segment.contextBefore,
          after: segment.contextAfter
        })
      );
      signal.throwIfAborted();
      const cached =
        settings.cacheMode === "disabled"
          ? undefined
          : (sessionCache.get(key) ??
            (settings.cacheMode === "persistent"
              ? await getCachedTranslation(key).catch(() => undefined)
              : undefined));
      if (cached) {
        metrics.cacheHits += 1;
        publish({ id: segment.id, text: cached }, true);
        return;
      }
      const existing = groups.get(key);
      if (existing) existing.aliases.push(segment.id);
      else groups.set(key, { segment, key, aliases: [segment.id], parts: [] });
    })
  );
  // Preserve source reading order even if cache/hash promises settled out of order.
  const ordered = [...groups.values()].sort(
    (a, b) => segments.indexOf(a.segment) - segments.indexOf(b.segment)
  );
  const budget = Math.min(
    execution.inputTokenBudget,
    Math.floor(execution.maxOutputTokens / 2) - 96
  );
  const contextLimit = Math.min(80, Math.floor(budget / 8));
  let chunkId = 0;
  for (const group of ordered) {
    const texts = splitText(group.segment.text, budget - contextLimit * 2 - 48);
    group.parts = texts.map((text, index) => {
      let id = group.segment.id;
      if (texts.length > 1) {
        do {
          id = `chunk-${chunkId++}`;
        } while (ids.has(id));
        ids.add(id);
      }
      return {
        id,
        text,
        ...(index === 0 && group.segment.contextBefore
          ? { contextBefore: group.segment.contextBefore.slice(0, contextLimit) }
          : {}),
        ...(index === texts.length - 1 && group.segment.contextAfter
          ? { contextAfter: group.segment.contextAfter.slice(0, contextLimit) }
          : {})
      };
    });
  }
  const completed = new Map<string, TranslationResult>();
  const streaming = new Map<string, TranslationResult>();
  const published = new Set<string>();
  const joiner = /chinese|japanese|korean|中文|日本|繁體|简体/i.test(settings.targetLanguage)
    ? ""
    : " ";
  const publishGroups = (available: Map<string, TranslationResult>, final: boolean): void => {
    for (const group of ordered) {
      if (!group.parts.every((part) => available.has(part.id))) continue;
      const text = group.parts.map((part) => available.get(part.id)!.text).join(joiner);
      for (const id of group.aliases) {
        if (final || !published.has(id)) {
          publish({ id, text }, final);
          published.add(id);
        }
      }
    }
  };
  let lastError: string | undefined;
  for (const batch of packSegments(
    ordered.flatMap((group) => group.parts),
    budget
  )) {
    let pending = batch;
    for (let attempt = 0; pending.length && attempt <= execution.retries; attempt += 1) {
      signal.throwIfAborted();
      if (attempt) metrics.retries += 1;
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("Translation request timed out."));
      }, execution.timeoutMs);
      try {
        metrics.requests += 1;
        metrics.inputCharacters += pending.reduce((sum, segment) => sum + segment.text.length, 0);
        const translated = await getProvider(settings.provider).translate(pending, settings, {
          signal: controller.signal,
          maxOutputTokens: execution.maxOutputTokens,
          streaming: execution.streaming,
          onTranslation: (result) => {
            streaming.set(result.id, result);
            publishGroups(new Map([...completed, ...streaming]), false);
          }
        });
        signal.throwIfAborted();
        for (const result of translated) completed.set(result.id, result);
        publishGroups(completed, true);
        pending = pending.filter((segment) => !completed.has(segment.id));
        if (pending.length)
          lastError = `The provider omitted or duplicated ${pending.length} translation ID(s).`;
      } catch (error: unknown) {
        signal.throwIfAborted();
        lastError = timedOut
          ? "Translation request timed out."
          : error instanceof Error
            ? error.message
            : "Translation failed.";
        const transient =
          error instanceof TypeError ||
          (error instanceof ProviderHttpError && (error.status === 429 || error.status >= 500));
        if (timedOut || !transient || attempt === execution.retries) break;
        const retryAfter = error instanceof ProviderHttpError ? Number(error.retryAfter) * 1000 : 0;
        if (retryAfter > 5000) break;
        await abortableDelay(Math.max(150 * (attempt + 1), retryAfter || 0), signal);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
    }
  }
  signal.throwIfAborted();
  if (settings.cacheMode !== "disabled") {
    await Promise.all(
      ordered.map(async (group) => {
        const result = results.get(group.aliases[0]);
        if (!result) return;
        sessionCache.delete(group.key);
        sessionCache.set(group.key, result.text);
        if (settings.cacheMode === "persistent") {
          // Cache quotas must never turn an already successful translation into an error.
          await setCachedTranslation(group.key, result.text).catch(() => undefined);
        }
      })
    );
    while (sessionCache.size > MAX_SESSION_ENTRIES)
      sessionCache.delete(sessionCache.keys().next().value!);
  }
  metrics.totalMs = Date.now() - started;
  const orderedResults = segments.flatMap((segment) =>
    results.has(segment.id) ? [results.get(segment.id)!] : []
  );
  if (!orderedResults.length && segments.length)
    throw new Error(lastError ?? "The provider returned no valid translations.");
  return {
    results: orderedResults,
    metrics,
    ...(orderedResults.length < segments.length ? { error: lastError } : {})
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
