import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { fillForm, readForm } from "./settingsForm";

describe("settings form", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <select name="displayStyle">
        <option value="balanced">Balanced</option>
        <option value="quiet">Quiet</option>
        <option value="focus">Focus translation</option>
        <option value="card">Card</option>
      </select>
      <input name="showTranslationLabel" type="checkbox" />
      <select name="cacheMode">
        <option value="session">Session only</option>
        <option value="persistent">Persistent</option>
        <option value="disabled">Disabled</option>
      </select>
    `;
  });

  it("normalizes legacy integrated display settings to quiet", () => {
    fillForm({ ...DEFAULT_SETTINGS, displayStyle: "integrated" });

    expect(document.querySelector<HTMLSelectElement>('[name="displayStyle"]')?.value).toBe("quiet");
  });

  it("normalizes legacy highlighted display settings to card", () => {
    fillForm({ ...DEFAULT_SETTINGS, displayStyle: "highlighted" });

    expect(document.querySelector<HTMLSelectElement>('[name="displayStyle"]')?.value).toBe("card");
  });

  it("fills and reads the independent translation marker setting", () => {
    fillForm({ ...DEFAULT_SETTINGS, showTranslationLabel: true });

    expect(document.querySelector<HTMLInputElement>('[name="showTranslationLabel"]')?.checked).toBe(
      true
    );
    expect(readForm().showTranslationLabel).toBe(true);
  });

  it("fills and reads the cache mode setting", () => {
    fillForm({ ...DEFAULT_SETTINGS, cacheMode: "disabled" });

    expect(document.querySelector<HTMLSelectElement>('[name="cacheMode"]')?.value).toBe("disabled");
    expect(readForm().cacheMode).toBe("disabled");
  });

  it("round trips execution overrides and keeps auto values empty", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<select name="executionScope"><option>viewport</option><option>page</option></select><select name="executionMode"><option>auto</option><option>cloud</option></select><input name="executionConcurrency"><input name="executionBudget"><input name="executionOutput"><input name="executionTimeout"><input name="executionStreaming" type="checkbox">`
    );
    fillForm({
      ...DEFAULT_SETTINGS,
      execution: {
        scope: "page",
        mode: "cloud",
        concurrency: 2,
        inputTokenBudget: 1000,
        maxOutputTokens: 8192,
        timeoutMs: 15000,
        streaming: false
      }
    });
    expect(readForm().execution).toEqual({
      scope: "page",
      mode: "cloud",
      concurrency: 2,
      inputTokenBudget: 1000,
      maxOutputTokens: 8192,
      timeoutMs: 15000,
      streaming: false
    });
    fillForm(DEFAULT_SETTINGS);
    expect(readForm().execution).toEqual({ scope: "viewport", mode: "auto", streaming: true });
  });
});
