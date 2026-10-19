const structuredOutputRequest =
  /(?:\bjson\b|application\/json|\bjsonl\b|\bschema\b|\bjson\s*object\b|\bobjek\s+json\b|\bformat\s+(?:json|objek)\b|\bstruktur\s+json\b)/iu;

const answerEnvelopeKeys = ["answer"] as const;

function hasStructuredOutputIntent(
  userPrompt: string,
  conversationContextPrompts: readonly string[],
): boolean {
  return [userPrompt, ...conversationContextPrompts].some((prompt) =>
    structuredOutputRequest.test(prompt),
  );
}

function parseAnswerEnvelope(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 1 || !answerEnvelopeKeys.some((key) => key in record))
      return null;
    const answerKey = answerEnvelopeKeys.find((key) => key in record);
    if (!answerKey || typeof record[answerKey] !== "string") return null;
    return (record[answerKey] as string).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Hides only the canonical single-field answer envelope. Explicit JSON intent
 * from this turn or an earlier conversation turn keeps JSON intact.
 */
export function normalizeAssistantText(
  text: string,
  userPrompt = "",
  conversationContextPrompts: readonly string[] = [],
): string {
  if (hasStructuredOutputIntent(userPrompt, conversationContextPrompts))
    return text;
  return parseAnswerEnvelope(text) ?? text;
}

export function prettyPrintRequestedJson(
  text: string,
  userPrompt: string,
  conversationContextPrompts: readonly string[] = [],
): string {
  if (!hasStructuredOutputIntent(userPrompt, conversationContextPrompts))
    return text;
  const trimmed = text.trim();
  if (
    trimmed.startsWith("```") ||
    !trimmed.startsWith("{") ||
    !trimmed.endsWith("}")
  )
    return text;
  try {
    const value: unknown = JSON.parse(trimmed);
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  } catch {
    return text;
  }
}

export function formatAssistantTextForDisplay(
  text: string,
  userPrompt = "",
  conversationContextPrompts: readonly string[] = [],
): string {
  return hasStructuredOutputIntent(userPrompt, conversationContextPrompts)
    ? prettyPrintRequestedJson(text, userPrompt, conversationContextPrompts)
    : normalizeAssistantText(text, userPrompt, conversationContextPrompts);
}
