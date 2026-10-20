import type {
  ChatCompletionRequestInput,
  ProviderCompletion,
} from "@promptlab/contracts";
import {
  AgentDecisionSchema,
  parseModelJson,
  type AgentDecision,
} from "@promptlab/agent";
import type { CampusChatProvider } from "@promptlab/providers";
import { z } from "zod";

import { withProviderInferenceReservation } from "./provider-campaign.ts";

type WorkspaceChatDecisionProvider = Pick<CampusChatProvider, "complete">;
type JsonSchemaObject = Record<string, unknown>;

const agentDecisionJsonSchema = z.toJSONSchema(AgentDecisionSchema, {
  unrepresentable: "any",
}) as JsonSchemaObject;

export function workspaceChatDecisionJsonSchema(
  allowedTools: readonly string[],
): JsonSchemaObject {
  const schema = structuredClone(agentDecisionJsonSchema);
  const properties = schema.properties as JsonSchemaObject;
  const required = Object.keys(properties);
  schema.required = required;

  const toolCalls = properties.toolCalls as JsonSchemaObject;
  if (allowedTools.length === 0) {
    toolCalls.maxItems = 0;
    toolCalls.items = false;
    return schema;
  }
  toolCalls.maxItems = 1;

  const items = toolCalls.items as JsonSchemaObject;
  const variants = items.oneOf as JsonSchemaObject[];
  const allowedNames = new Set(allowedTools);
  const allowedVariants = variants.filter((variant) => {
    const variantProperties = variant.properties as JsonSchemaObject;
    const nameSchema = variantProperties.name as JsonSchemaObject;
    return (
      typeof nameSchema.const === "string" && allowedNames.has(nameSchema.const)
    );
  });
  if (allowedVariants.length !== allowedNames.size) {
    throw new Error("WORKSPACE_CHAT_DECISION_TOOL_SCHEMA_MISMATCH");
  }
  items.oneOf = allowedVariants;

  return schema;
}

export function workspaceChatDecisionOutputInstructions(
  allowedTools: readonly string[],
): string {
  const noChangeExample = {
    summary: "Prompt jelas dan dapat dijalankan.",
    targetRecommendation: null,
    toolCalls: [],
    candidate: null,
    noChangeRecommended: true,
    finalText: "Prompt sudah memadai; teruskan prompt asli ke Codex.",
    finish: true,
    clarificationRequired: false,
    clarification: null,
  };
  const candidateExample = {
    summary: "Instruksi dirapikan tanpa mengubah persyaratan.",
    targetRecommendation: null,
    toolCalls: [],
    candidate: {
      text: "<prompt pengganti lengkap yang mempertahankan permintaan asli>",
      changeSummary: "Merapikan struktur instruksi.",
      riskSummary: "Tidak ada persyaratan yang dihapus.",
      strategy: "Memisahkan tujuan, batasan, dan format keluaran.",
    },
    noChangeRecommended: false,
    finalText: null,
    finish: false,
    clarificationRequired: false,
    clarification: null,
  };
  const clarificationExample = {
    summary: "Satu pilihan penting diperlukan sebelum prompt dapat disusun.",
    targetRecommendation: null,
    toolCalls: [],
    candidate: null,
    noChangeRecommended: false,
    finalText: null,
    finish: false,
    clarificationRequired: true,
    clarification: {
      question: "Sasaran utama mana yang harus dipilih?",
      reasonCode: "objective_choice",
      choices: [],
      publicContext: null,
    },
  };

  return [
    "Keluarkan tepat satu objek JSON tanpa markdown atau teks di luarnya. Semua field top-level dalam schema wajib dikirim; gunakan null dan [] sesuai contoh, dan jangan menambah field.",
    "JSON Schema keputusan (toolCalls hanya memuat union tool yang tersedia pada giliran ini):",
    JSON.stringify(workspaceChatDecisionJsonSchema(allowedTools), null, 2),
    "Aturan antar-field yang wajib dipatuhi: clarificationRequired false berarti clarification null; true berarti clarification adalah objek berisi question, reasonCode, choices, dan publicContext. Klarifikasi harus memakai toolCalls [], candidate null, finalText null, finish false, dan noChangeRecommended false. No-op harus memakai candidate null, noChangeRecommended true, toolCalls [], finish true, clarificationRequired false, clarification null, serta finalText berupa alasan singkat bahwa prompt asli siap diteruskan; jangan jawab permintaan pengguna di finalText. Kandidat harus memakai objek candidate lengkap, noChangeRecommended false, toolCalls [], finalText null, finish false, clarificationRequired false, dan clarification null. Keputusan panggilan tool harus memakai candidate null, noChangeRecommended false, finalText null, finish false, clarificationRequired false, dan clarification null. Setiap toolCalls harus cocok tepat dengan satu varian union pada schema, memakai argumen yang diwajibkan varian itu, dan hanya memakai nama dari daftar tool yang tersedia. Untuk permintaan targetRecommendation, isi objek sesuai model dan effort yang disebut di atas; jika tidak diminta, gunakan null.",
    "Contoh bentuk saja; jangan salin isi contoh atau placeholder ke keputusan untuk pengguna:",
    `No-op:\n${JSON.stringify(noChangeExample, null, 2)}`,
    `Kandidat:\n${JSON.stringify(candidateExample, null, 2)}`,
    `Klarifikasi:\n${JSON.stringify(clarificationExample, null, 2)}`,
  ].join("\n\n");
}

export interface WorkspaceChatGenerationPolicy {
  disableThinking: boolean;
  maxOutputTokens: number;
}

/** Uses a bounded fast path only for unambiguous pings and arithmetic expressions. */
export function workspaceChatGenerationPolicyForPrompt(
  prompt: string,
): WorkspaceChatGenerationPolicy {
  const normalized = prompt.normalize("NFKC").trim().toLocaleLowerCase("id-ID");
  const isPing = /^(?:halo|hai|hi|hello|test|tes|ping)[.!?]*$/u.test(
    normalized,
  );
  const isArithmeticExpression =
    normalized.length <= 80 &&
    /\d/u.test(normalized) &&
    /[+*/^%=×÷-]/u.test(normalized) &&
    /^[\d\s()+*/^%=.,×÷-]+$/u.test(normalized);
  const useFastPath = isPing || isArithmeticExpression;

  return {
    disableThinking: useFastPath,
    maxOutputTokens: useFastPath ? 256 : 2_048,
  };
}

export async function completeWorkspaceChatDecision(input: {
  campusChat: WorkspaceChatDecisionProvider;
  request: ChatCompletionRequestInput;
  signal: AbortSignal;
  /** Called after a campaign reservation succeeds and immediately before inference. */
  onAttempt: () => void;
}): Promise<ProviderCompletion> {
  return withProviderInferenceReservation("campus_gateway", () => {
    input.onAttempt();
    return input.campusChat.complete(input.request, {
      signal: input.signal,
    });
  });
}

export function parseWorkspaceChatDecision(text: string): AgentDecision {
  try {
    return parseModelJson(text, AgentDecisionSchema, {
      requireSingleObject: true,
    });
  } catch {
    throw invalidWorkspaceChatOutput();
  }
}

function invalidWorkspaceChatOutput(): Error {
  return new Error("WORKSPACE_CHAT_OUTPUT_INVALID");
}
