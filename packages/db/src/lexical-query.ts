const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "what",
  "which",
  "who",
  "when",
  "where",
  "why",
  "how",
  "and",
  "or",
  "of",
  "on",
  "in",
  "to",
  "by",
  "for",
  "from",
  "with",
  "that",
  "this",
  "apa",
  "siapa",
  "yang",
  "dan",
  "di",
  "ke",
  "dari",
  "untuk",
  "pada",
  "dengan",
  "bagaimana",
  "kapan",
  "dimana",
  "mengapa",
  "perlu",
  "dapat",
]);

const LEXICAL_QUERY_FRAMING_STOP_WORDS = new Set([
  "according",
  "document",
  "documents",
  "berapa",
  "menurut",
  "dokumen",
]);

const TASK_RETRIEVAL_FORMAT_STOP_WORDS = new Set([
  "answer",
  "answers",
  "exact",
  "format",
  "formatted",
  "instructions",
  "json",
  "output",
  "please",
  "prompt",
  "provide",
  "question",
  "respond",
  "response",
  "return",
  "source",
  "sources",
  "structured",
  "task",
  "valid",
]);
const MAX_LEXICAL_TASK_TERMS = 64;

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function retrievalQueryTokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(/\s+/u)
    .filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token));
}

export function lexicalTaskTerms(query: string): string[] {
  return [
    ...new Set(
      normalizeSearchText(query)
        .split(/\s+/u)
        .filter(
          (token) =>
            (token.length > 1 || /^\d$/u.test(token)) &&
            !QUERY_STOP_WORDS.has(token) &&
            !LEXICAL_QUERY_FRAMING_STOP_WORDS.has(token) &&
            !TASK_RETRIEVAL_FORMAT_STOP_WORDS.has(token),
        ),
    ),
  ].slice(0, MAX_LEXICAL_TASK_TERMS);
}
