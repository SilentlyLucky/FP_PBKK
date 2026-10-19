import { describe, expect, it } from "vitest";

import {
  formatAssistantTextForDisplay,
  normalizeAssistantText,
} from "./workspace-message-content.js";

describe("assistant transcript content", () => {
  it("unwraps a single answer envelope for ordinary chat", () => {
    expect(
      normalizeAssistantText('{"answer":"Hi! What can I help you with?"}'),
    ).toBe("Hi! What can I help you with?");
  });

  it("preserves a requested JSON answer and formats it as copyable code", () => {
    const prompt = "Tolong berikan hasilnya dalam format JSON.";
    expect(formatAssistantTextForDisplay('{"answer":"Hi"}', prompt)).toBe(
      '```json\n{\n  "answer": "Hi"\n}\n```',
    );
  });

  it("keeps JSON intent from an earlier turn for a follow-up answer", () => {
    const followUp = "Tambahkan status pada jawaban tadi.";
    const earlierPrompts = ["Berikan jawaban dalam format JSON."];

    expect(
      formatAssistantTextForDisplay(
        '{"answer":"Selesai"}',
        followUp,
        earlierPrompts,
      ),
    ).toBe('```json\n{\n  "answer": "Selesai"\n}\n```');
  });

  it("does not unwrap objects with extra fields or fenced JSON", () => {
    const object = '{"answer":"Hi","source":"fixture"}';
    const fenced = '```json\n{"answer":"Hi"}\n```';

    expect(normalizeAssistantText(object)).toBe(object);
    expect(normalizeAssistantText(fenced)).toBe(fenced);
  });

  it.each([
    "Berikan objek JSON dengan jawaban.",
    "Return a JSON object with the result.",
    "Gunakan schema yang saya berikan.",
  ])("preserves deliberate structured output for prompt: %s", (prompt) => {
    const response = '{"answer":"Hi"}';
    expect(normalizeAssistantText(response, prompt)).toBe(response);
  });

  it.each(["message", "response", "output", "content", "text"])(
    "preserves arbitrary single-field JSON objects using the %s key",
    (key) => {
      const response = JSON.stringify({ [key]: "this is a JSON field" });

      expect(normalizeAssistantText(response)).toBe(response);
    },
  );
});
