import type { ExtensionSettings, TextSegment, TranslationExecutionSettings } from "./types";

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

export function getExecutionSettings(
  settings: Pick<ExtensionSettings, "providerEndpoint" | "execution">
): TranslationExecutionSettings {
  const input = settings.execution ?? {};
  const mode = input.mode === "local" || input.mode === "cloud" ? input.mode : "auto";
  const local =
    mode === "local" || (mode === "auto" && isLoopbackEndpoint(settings.providerEndpoint));
  return {
    mode,
    scope: input.scope === "page" ? "page" : "viewport",
    concurrency: bounded(input.concurrency, 1, 6, local ? 1 : 3),
    inputTokenBudget: bounded(input.inputTokenBudget, 256, 6000, local ? 1200 : 1800),
    maxOutputTokens: bounded(input.maxOutputTokens, 512, 16384, 4096),
    timeoutMs: bounded(input.timeoutMs, 1000, 120000, 30000),
    retries: bounded(input.retries, 0, 2, 1),
    streaming: input.streaming !== false
  };
}

function bounded(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

// Conservative estimate: non-ASCII text receives a larger allowance. This is
// deliberately independent of vendor tokenizers and reserves output room too.
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if (character.codePointAt(0)! < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3 + other);
}

export function segmentTokens(segment: TextSegment): number {
  return (
    32 +
    estimateTokens(segment.text) +
    estimateTokens(segment.contextBefore ?? "") +
    estimateTokens(segment.contextAfter ?? "")
  );
}

export function splitText(text: string, budget: number): string[] {
  if (estimateTokens(text) <= budget) return [text];
  const chunks: string[] = [];
  let chunk = "";
  let cost = 0;
  const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text);
  for (const { segment } of sentences) {
    if (estimateTokens(chunk + segment) <= budget) {
      chunk += segment;
      cost = estimateTokens(chunk);
      continue;
    }
    if (chunk.trim()) chunks.push(chunk.trim());
    chunk = "";
    cost = 0;
    if (estimateTokens(segment) <= budget) {
      chunk = segment;
      cost = estimateTokens(segment);
      continue;
    }
    // A long sentence, URL, or CJK run still needs a hard bound. Iterate Unicode
    // code points so surrogate pairs cannot be cut in half.
    for (const character of segment) {
      const characterCost = character.codePointAt(0)! < 128 ? 1 / 3 : 1;
      if (Math.ceil(cost + characterCost - 1e-8) > budget && chunk) {
        chunks.push(chunk.trim());
        chunk = "";
        cost = 0;
      }
      chunk += character;
      cost += characterCost;
    }
  }
  if (chunk.trim()) chunks.push(chunk.trim());
  return chunks;
}

export function packSegments(segments: TextSegment[], budget: number): TextSegment[][] {
  const batches: TextSegment[][] = [];
  let current: TextSegment[] = [];
  let size = 0;
  for (const segment of segments) {
    const cost = segmentTokens(segment);
    if (current.length && (size + cost > budget || current.length >= 64)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}
