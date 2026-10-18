import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming
} from "openai/resources/chat/completions";
import type { Model } from "openai/resources/models";
import type {
  ExtensionSettings,
  ProviderModel,
  TextSegment,
  TranslationResult
} from "../../shared/types";
import {
  assertProviderResponse,
  buildTranslationPayload,
  buildV1ModelsEndpoint,
  getTranslationSchema,
  parseTranslations,
  buildSystemPrompt
} from "./shared";
import type { ProviderRequestOptions, TranslationProvider } from "./types";
import { readOpenAIStream } from "./stream";

const STRUCTURED_OUTPUT_NAME = "translations";

type OpenAIRequestBody = ChatCompletionCreateParamsNonStreaming;
type OpenAIResponse = ChatCompletion;
type OpenAIModelListResponse = { data?: Array<Partial<Model>> };

export const openaiProvider: TranslationProvider = {
  id: "openai",
  translate: translateWithOpenAI,
  listModels: listOpenAIModels
};

export const openaiCompatibleProvider: TranslationProvider = {
  id: "openai-compatible",
  translate: translateWithOpenAI,
  listModels: listOpenAIModels
};

async function translateWithOpenAI(
  segments: TextSegment[],
  settings: ExtensionSettings,
  options: ProviderRequestOptions = {}
): Promise<TranslationResult[]> {
  const body = {
    model: settings.model,
    temperature: 0,
    ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
    ...(options.streaming ? { stream: true } : {}),
    ...(new URL(settings.providerEndpoint).hostname === "openrouter.ai"
      ? { provider: { sort: "latency" } }
      : {}),
    ...buildResponseFormat(settings, segments),
    messages: [
      { role: "system", content: buildSystemPrompt(settings) },
      { role: "user", content: buildTranslationPayload(segments, settings) }
    ]
  };

  const response = await fetch(settings.providerEndpoint, {
    method: "POST",
    headers: buildOpenAIHeaders(settings),
    body: JSON.stringify(body),
    signal: options.signal
  });

  await assertProviderResponse(response);

  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return readOpenAIStream(response, segments, options.onTranslation);
  }

  const payload = (await response.json()) as Partial<OpenAIResponse>;
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Provider response did not include translated content.");
  }

  return parseTranslations(content, segments);
}

async function listOpenAIModels(settings: ExtensionSettings): Promise<ProviderModel[]> {
  const response = await fetch(buildV1ModelsEndpoint(settings.providerEndpoint), {
    headers: buildOpenAIHeaders(settings)
  });
  await assertProviderResponse(response);

  const payload = (await response.json()) as OpenAIModelListResponse;
  return (payload.data ?? [])
    .filter((model): model is { id: string } => typeof model.id === "string" && model.id.length > 0)
    .map((model) => ({ id: model.id }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function buildOpenAIHeaders(settings: ExtensionSettings): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {})
  };
}

function buildResponseFormat(
  settings: ExtensionSettings,
  segments: TextSegment[]
): {
  response_format?: OpenAIRequestBody["response_format"];
} {
  if (
    settings.provider === "openai" ||
    (new URL(settings.providerEndpoint).hostname === "openrouter.ai" &&
      settings.openAICompatibleJsonMode)
  ) {
    return {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: STRUCTURED_OUTPUT_NAME,
          strict: true,
          schema: getTranslationSchema(segments) as Record<string, unknown>
        }
      }
    };
  }

  if (settings.openAICompatibleJsonMode) {
    return { response_format: { type: "json_object" } };
  }

  return {};
}
