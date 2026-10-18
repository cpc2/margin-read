import { clearPersistentCache, getSettings, saveSettings } from "../shared/storage";
import type {
  ExtensionSettings,
  RuntimeMessage,
  ProviderModel,
  TranslateBatchResponse,
  TranslateBatchRequest
} from "../shared/types";
import { SETTINGS_KEY } from "../shared/defaults";
import { isLocalTranslationProvider } from "../shared/localProviders";
import { getProvider } from "./providers";
import { installUpgradeLifecycle } from "./upgradeLifecycle";
import { clearSessionCache, translateSegments } from "./translationEngine";

const activeRequests = new Map<
  string,
  { sessionId?: string; tabId?: number; controller: AbortController }
>();
const cancelledSessions = new Set<string>();
const FLOATING_POSITION_KEY = "margin.floatingButton.positionRatio";
// Options and the worker can access credentials; content scripts receive only
// public settings and send translation jobs back to the worker.
void chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });

installUpgradeLifecycle();

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected extension error."
      });
    });
  return true;
});

chrome.storage.onChanged?.addListener((changes, area) => {
  const settings = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
  if (area !== "local" || !settings) return;
  const { apiKey: _secret, ...publicSettings } = settings;
  void chrome.tabs
    .query({})
    .then((tabs) =>
      Promise.all(
        tabs.map((tab) =>
          tab.id === undefined
            ? Promise.resolve(undefined)
            : chrome.tabs
                .sendMessage(tab.id, {
                  type: "SETTINGS_UPDATED",
                  settings: publicSettings
                })
                .catch(() => undefined)
        )
      )
    )
    .catch(() => undefined);
});

export async function handleMessage(
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender = {}
): Promise<unknown> {
  if (message.type === "GET_SETTINGS") {
    const { apiKey: _secret, ...settings } = await getSettings();
    return { ok: true, settings };
  }

  if (message.type === "CLEAR_CACHE") {
    clearSessionCache();
    await clearPersistentCache();
    return { ok: true };
  }

  if (message.type === "TRANSLATE_BATCH") {
    return translateBatch(message, sender.tab?.id);
  }

  if (message.type === "CANCEL_TRANSLATION") {
    cancelledSessions.add(`${sender.tab?.id}:${message.sessionId}`);
    while (cancelledSessions.size > 200)
      cancelledSessions.delete(cancelledSessions.values().next().value!);
    for (const active of activeRequests.values()) {
      if (active.sessionId === message.sessionId && active.tabId === sender.tab?.id)
        active.controller.abort();
    }
    return { ok: true };
  }
  if (message.type === "GET_FLOATING_POSITION") {
    const stored = await chrome.storage.local.get(FLOATING_POSITION_KEY);
    const position: unknown = stored[FLOATING_POSITION_KEY];
    return { ok: true, position: typeof position === "number" ? position : null };
  }
  if (message.type === "SET_FLOATING_POSITION") {
    if (Number.isFinite(message.position))
      await chrome.storage.local.set({
        [FLOATING_POSITION_KEY]: Math.max(0, Math.min(1, message.position))
      });
    return { ok: true };
  }
  if (message.type === "SET_FLOATING_BUTTON") {
    await saveSettings({ ...(await getSettings()), showFloatingButton: message.enabled });
    return { ok: true };
  }

  if (message.type === "LIST_MODELS") {
    return listProviderModels({
      ...message.settings,
      apiKey: normalizeApiKey(message.settings.apiKey)
    });
  }

  return { ok: false, error: `Unsupported runtime message: ${getRuntimeMessageType(message)}.` };
}

async function translateBatch(
  message: TranslateBatchRequest,
  tabId?: number
): Promise<TranslateBatchResponse> {
  const settings = await getSettings();
  const apiKey = normalizeApiKey(settings.apiKey);
  if (message.sessionId && cancelledSessions.has(`${tabId}:${message.sessionId}`))
    throw new Error("Translation cancelled.");

  if (!apiKey && !isLocalTranslationProvider(settings.provider)) {
    return { ok: false, error: "Configure an API key in Margin options before translating." };
  }

  const key = `${tabId}:${message.sessionId}:${message.requestId ?? crypto.randomUUID()}`;
  const controller = new AbortController();
  activeRequests.set(key, { sessionId: message.sessionId, tabId, controller });
  try {
    const translated = await translateSegments(
      message.segments,
      { ...settings, apiKey },
      controller.signal,
      message.sessionId && message.requestId && tabId !== undefined
        ? (result) => {
            void chrome.tabs
              .sendMessage(tabId, {
                type: "TRANSLATION_PROGRESS",
                sessionId: message.sessionId,
                requestId: message.requestId,
                results: [result]
              })
              .catch(() => undefined);
          }
        : undefined
    );
    return { ok: true, ...translated };
  } finally {
    activeRequests.delete(key);
  }
}

function normalizeApiKey(apiKey: string): string {
  return apiKey
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function getRuntimeMessageType(message: unknown): string {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    typeof message.type === "string"
  ) {
    return message.type;
  }

  return "unknown";
}

async function listProviderModels(
  settings: ExtensionSettings
): Promise<{ ok: boolean; models?: ProviderModel[]; error?: string }> {
  if (!settings.apiKey && !isLocalTranslationProvider(settings.provider)) {
    return { ok: false, error: "Configure an API key before fetching models." };
  }

  try {
    const provider = getProvider(settings.provider);
    return { ok: true, models: await provider.listModels(settings) };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unsupported translation provider."
    };
  }
}
