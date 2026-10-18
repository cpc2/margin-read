import type { Content, GenerateContentResponse, GenerationConfig, Model } from "@google/genai";
import type {
  ExtensionSettings,
  ProviderModel,
  TextSegment,
  TranslationResult
} from "../../shared/types";
import {
  assertProviderResponse,
  buildTranslationPayload,
  getTranslationSchema,
  parseTranslations,
  buildSystemPrompt
} from "./shared";
import type { ProviderRequestOptions, TranslationProvider } from "./types";

interface GeminiRequestBody {
  generationConfig: GenerationConfig;
  systemInstruction: Content;
  contents: Content[];
}

type GeminiResponse = GenerateContentResponse;

interface GeminiModelListResponse {
  models?: Array<Partial<Model> & { supportedGenerationMethods?: string[] }>;
}

export const googleProvider: TranslationProvider = {
  id: "google",
  translate: translateWithGoogle,
  listModels: listGoogleModels
};

async function translateWithGoogle(
  segments: TextSegment[],
  settings: ExtensionSettings,
  options: ProviderRequestOptions = {}
): Promise<TranslationResult[]> {
  const endpoint = buildGenerateContentEndpoint(settings);

  const body = {
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseJsonSchema: getTranslationSchema(segments),
      ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {})
    },
    systemInstruction: {
      parts: [{ text: buildSystemPrompt(settings) }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: buildTranslationPayload(segments, settings) }]
      }
    ]
  } satisfies GeminiRequestBody;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal
  });

  await assertProviderResponse(response);

  const payload = (await response.json()) as Partial<GeminiResponse>;
  const content = payload.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;

  if (!content) {
    throw new Error("Provider response did not include translated content.");
  }

  return parseTranslations(content, segments);
}

async function listGoogleModels(settings: ExtensionSettings): Promise<ProviderModel[]> {
  const endpoint = `${stripTrailingSlash(settings.providerEndpoint)}?key=${encodeURIComponent(settings.apiKey)}`;
  const response = await fetch(endpoint);
  await assertProviderResponse(response);

  const payload = (await response.json()) as GeminiModelListResponse;
  return (payload.models ?? [])
    .filter(
      (
        model
      ): model is { name: string; displayName?: string; supportedGenerationMethods?: string[] } =>
        typeof model.name === "string" &&
        model.name.length > 0 &&
        (model.supportedGenerationMethods?.includes("generateContent") ?? true)
    )
    .map((model) => ({ id: model.name.replace(/^models\//, ""), displayName: model.displayName }));
}

function buildGenerateContentEndpoint(settings: ExtensionSettings): string {
  return `${stripTrailingSlash(settings.providerEndpoint)}/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}
