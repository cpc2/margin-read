import "./content.css";
import type { ExtensionSettings, RuntimeMessage } from "../shared/types";
import { installFloatingButton, type FloatingButtonHandle } from "./floatingButton";
import { createOrchestrator } from "./orchestrator";
import { initializeYouTubeControls, syncYouTubeSettings } from "./siteAdapters/youtube";

interface SettingsResponse {
  ok: boolean;
  settings?: Partial<ExtensionSettings>;
}

let floatingButton: FloatingButtonHandle | undefined;

const orchestrator = createOrchestrator({
  onEnabledChange: (enabled) => {
    floatingButton?.setEnabledState(enabled);
  }
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "TRANSLATION_PROGRESS") {
    orchestrator.acceptProgress(message.sessionId, message.requestId, message.results);
    return;
  }
  if (message.type === "SETTINGS_UPDATED") {
    floatingButton?.syncFromSettings(message.settings);
    syncYouTubeSettings(message.settings);
    return;
  }
  if (message.type === "TOGGLE_TRANSLATION") {
    const next = typeof message.enabled === "boolean" ? message.enabled : !orchestrator.isEnabled();
    void orchestrator.setEnabled(next).finally(() => {
      sendResponse({
        ok: true,
        enabled: orchestrator.isEnabled(),
        debug: orchestrator.getDebugState()
      });
    });
    return true;
  }

  if (message.type === "GET_PAGE_STATE") {
    sendResponse({
      ok: true,
      enabled: orchestrator.isEnabled(),
      debug: orchestrator.getDebugState()
    });
    return;
  }
});

void initializeFloatingButton();
initializeYouTubeControls();
window.addEventListener("pagehide", () => {
  if (orchestrator.isEnabled()) void orchestrator.setEnabled(false);
});

async function initializeFloatingButton(): Promise<void> {
  if (!document.body) {
    window.addEventListener("DOMContentLoaded", () => void initializeFloatingButton(), {
      once: true
    });
    return;
  }

  floatingButton = installFloatingButton({
    document,
    initialEnabled: orchestrator.isEnabled(),
    initialPositionRatio: await readFloatingPositionRatio(),
    onToggle: () => orchestrator.setEnabled(!orchestrator.isEnabled()),
    onPositionChange: (ratio) => {
      void chrome.runtime.sendMessage({ type: "SET_FLOATING_POSITION", position: ratio });
    },
    onClose: () => void disableFloatingButton()
  });

  try {
    const response: SettingsResponse = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (response.settings) {
      floatingButton.syncFromSettings(response.settings);
    }
  } catch {
    floatingButton.dispose();
    floatingButton = undefined;
  }
}

// Close (×) turns the feature off globally and persists it, so the options page reflects it.
async function disableFloatingButton(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "SET_FLOATING_BUTTON", enabled: false });
  } catch {
    // Storage unavailable (e.g. during teardown); the host is already removed.
  }
}

async function readFloatingPositionRatio(): Promise<number | null> {
  try {
    const response: { position?: unknown } = await chrome.runtime.sendMessage({
      type: "GET_FLOATING_POSITION"
    });
    const value: unknown = response.position;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}
