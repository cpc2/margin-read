import type {
  ExtensionSettings,
  ProviderModel,
  TextSegment,
  TranslationProviderId,
  TranslationResult
} from "../../shared/types";

export interface TranslationProvider {
  readonly id: TranslationProviderId;
  translate(
    segments: TextSegment[],
    settings: ExtensionSettings,
    options?: ProviderRequestOptions
  ): Promise<TranslationResult[]>;
  listModels(settings: ExtensionSettings): Promise<ProviderModel[]>;
}

export interface ProviderRequestOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  streaming?: boolean;
  onTranslation?: (result: TranslationResult) => void;
}
