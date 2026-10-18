export type ModernDisplayStyle = "balanced" | "quiet" | "focus" | "card";
export type LegacyDisplayStyle = "integrated" | "highlighted";
export type DisplayStyle = ModernDisplayStyle | LegacyDisplayStyle;

export type CacheMode = "session" | "persistent" | "disabled";

export type TranslationProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "openai-compatible"
  | "anthropic-compatible";

export const SETTINGS_VERSION = 1;

export interface XSiteAdapterSettings {
  enabled: boolean;
  translateArticles: boolean;
  quotedPosts: boolean;
  skipNativeTranslated: boolean;
}

export interface SiteAdapterSettings {
  x: XSiteAdapterSettings;
}

export interface ExtensionSettings {
  version: typeof SETTINGS_VERSION;
  provider: TranslationProviderId;
  providerEndpoint: string;
  apiKey: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  displayStyle: DisplayStyle;
  showTranslationLabel: boolean;
  cacheMode: CacheMode;
  debugMode: boolean;
  siteAdapters: SiteAdapterSettings;
  openAICompatibleJsonMode: boolean;
  showFloatingButton: boolean;
  execution?: Partial<TranslationExecutionSettings>;
}

export interface TranslationExecutionSettings {
  mode: "auto" | "local" | "cloud";
  scope: "viewport" | "page";
  concurrency: number;
  inputTokenBudget: number;
  maxOutputTokens: number;
  timeoutMs: number;
  retries: number;
  streaming: boolean;
}

export interface TranslationMetrics {
  requests: number;
  cacheHits: number;
  retries: number;
  inputCharacters: number;
  firstResultMs?: number;
  totalMs: number;
}

export interface TextSegment {
  id: string;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
}

export interface TranslationResult {
  id: string;
  text: string;
}

export interface ProviderModel {
  id: string;
  displayName?: string;
}

export interface TranslateBatchRequest {
  type: "TRANSLATE_BATCH";
  segments: TextSegment[];
  sessionId?: string;
  requestId?: string;
}

export interface TranslateBatchResponse {
  ok: boolean;
  results?: TranslationResult[];
  error?: string;
  metrics?: TranslationMetrics;
}

export interface PageDebugState {
  debugMode: boolean;
  enabled: boolean;
  providerConfig?: {
    provider: TranslationProviderId;
    providerName: string;
    model: string;
    endpoint: string;
    structuredOutput: string;
    extensionVersion?: string;
  };
  lastScanAt?: number;
  detectedBlocks: number;
  enqueuedBlocks: number;
  queueSize: number;
  runningRequests: number;
  lastProviderRequestStartedAt?: number;
  lastProviderRequestFinishedAt?: number;
  lastProviderDurationMs?: number;
  pendingBlocks: number;
  translatedBlocks: number;
  errorBlocks: number;
  lastError?: string;
  sampleText?: string;
  requestCount?: number;
  cacheHits?: number;
  startedAt?: number;
  firstTranslationDurationMs?: number;
  viewportCompleteDurationMs?: number;
}

export type RuntimeMessage =
  | TranslateBatchRequest
  | { type: "CANCEL_TRANSLATION"; sessionId: string }
  | {
      type: "TRANSLATION_PROGRESS";
      sessionId: string;
      requestId: string;
      results: TranslationResult[];
    }
  | { type: "SET_FLOATING_BUTTON"; enabled: boolean }
  | { type: "GET_FLOATING_POSITION" }
  | { type: "SET_FLOATING_POSITION"; position: number }
  | { type: "SETTINGS_UPDATED"; settings: Partial<ExtensionSettings> }
  | { type: "GET_SETTINGS" }
  | { type: "LIST_MODELS"; settings: ExtensionSettings }
  | { type: "TOGGLE_TRANSLATION"; enabled?: boolean }
  | { type: "GET_PAGE_STATE" }
  | { type: "CLEAR_CACHE" };
