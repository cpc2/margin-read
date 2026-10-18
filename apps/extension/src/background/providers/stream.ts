import type { TextSegment, TranslationResult } from "../../shared/types";
import { parseTranslations, validateTranslations } from "./shared";

// Emit complete objects from the translations array while the enclosing JSON
// document is still arriving. Quotes, escapes, and nested braces are respected.
export class TranslationStreamParser {
  #text = "";
  #position = 0;
  #arrayStarted = false;
  #arrayFinished = false;
  #start = -1;
  #depth = 0;
  #quoted = false;
  #escaped = false;
  readonly results: TranslationResult[] = [];

  constructor(
    readonly segments: TextSegment[],
    readonly emit?: (result: TranslationResult) => void
  ) {}

  push(text: string): void {
    this.#text += text;
    if (this.#text.length > 2_000_000) throw new Error("Translation response is too large.");
    if (this.#arrayFinished) return;
    if (!this.#arrayStarted) {
      const match = /"translations"\s*:\s*\[/.exec(this.#text);
      if (!match) return;
      this.#arrayStarted = true;
      this.#position = match.index + match[0].length;
    }
    for (; this.#position < this.#text.length; this.#position += 1) {
      const character = this.#text[this.#position];
      if (this.#quoted) {
        if (this.#escaped) this.#escaped = false;
        else if (character === "\\") this.#escaped = true;
        else if (character === '"') this.#quoted = false;
        continue;
      }
      if (character === '"') this.#quoted = true;
      else if (character === "{") {
        if (this.#depth === 0) this.#start = this.#position;
        this.#depth += 1;
      } else if (character === "}") {
        this.#depth -= 1;
        if (this.#depth === 0 && this.#start >= 0) {
          const item: unknown = JSON.parse(this.#text.slice(this.#start, this.#position + 1));
          const [result] = validateTranslations({ translations: [item] }, this.segments);
          if (result) {
            this.results.push(result);
            if (this.results.filter((entry) => entry.id === result.id).length === 1)
              this.emit?.(result);
          }
          this.#start = -1;
        }
      } else if (character === "]" && this.#depth === 0) {
        this.#arrayFinished = true;
        this.#position = this.#text.length;
        break;
      }
    }
  }

  finish(): TranslationResult[] {
    try {
      return parseTranslations(this.#text, this.segments);
    } catch {
      // A length-limited reply can contain several complete results. Keep those
      // and let the engine retry only the remaining IDs.
      if (this.results.length)
        return validateTranslations({ translations: this.results }, this.segments);
      throw new Error("The provider returned invalid translation JSON.");
    }
  }
}

export async function readOpenAIStream(
  response: Response,
  segments: TextSegment[],
  emit?: (result: TranslationResult) => void
): Promise<TranslationResult[]> {
  if (!response.body) throw new Error("The provider returned an empty response stream.");
  const parser = new TranslationStreamParser(segments, emit);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventLines: string[] = [];
  const processEvent = (): void => {
    const data = eventLines.join("\n").trim();
    eventLines = [];
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as {
      error?: { message?: string };
      choices?: Array<{ delta?: { content?: string } }>;
    };
    if (event.error) throw new Error(event.error.message ?? "The provider stream failed.");
    const text = event.choices?.[0]?.delta?.content;
    if (text) parser.push(text);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2_000_000) throw new Error("Translation stream event is too large.");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) processEvent();
        else if (line.startsWith("data:")) eventLines.push(line.slice(5).trimStart());
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) eventLines.push(buffer.slice(5).trimStart());
    processEvent();
    return parser.finish();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
