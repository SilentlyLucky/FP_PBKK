import { relative, sep } from "node:path";

export interface RestrictedProtocolMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
}

export interface RestrictedCodexSession {
  respond(
    id: number | string,
    response:
      { result: unknown } | { error: { code: number; message: string } },
  ): void;
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
}

export type RestrictedTurnViolationHandler = (
  message: string,
  outcomeMayBeUnknown: boolean,
) => void;

const SAFE_NON_TOOL_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "contextCompaction",
]);

const SERVER_REQUEST_ERROR = {
  code: -32000,
  message: "PromptLab does not permit Codex tool or approval requests.",
};

export function isAllowedCodexNonToolItemType(type: unknown): type is string {
  return typeof type === "string" && SAFE_NON_TOOL_ITEM_TYPES.has(type);
}

export function codexServerRequestRefusal(
  method: string,
):
  | { result: { decision: "decline" } }
  | { error: { code: number; message: string } } {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    return { result: { decision: "decline" } };
  }
  return { error: SERVER_REQUEST_ERROR };
}

export type CodexInstructionSourceEvidence =
  | "unreported"
  | "reported-empty"
  | "reported-scoped"
  | "external"
  | "malformed";

export function codexInstructionSourceEvidence(
  started: unknown,
  scratchDirectory: string,
): CodexInstructionSourceEvidence {
  if (!isRecord(started) || !("instructionSources" in started)) {
    return "unreported";
  }
  if (!Array.isArray(started.instructionSources)) return "malformed";
  if (started.instructionSources.length === 0) return "reported-empty";

  for (const source of started.instructionSources) {
    if (typeof source !== "string") return "malformed";
    const path = relative(scratchDirectory, source);
    if (path !== "" && (path.startsWith(`..${sep}`) || path === "..")) {
      return "external";
    }
  }
  return "reported-scoped";
}

export function unconfirmedCodexToolControls(response: unknown): string[] {
  const root = isRecord(response) ? response : null;
  const config = root && isRecord(root.config) ? root.config : null;
  const features = config && isRecord(config.features) ? config.features : null;
  const mcpServers = config?.mcp_servers;

  const checks: Array<[string, boolean]> = [
    ["features.shell_tool", features?.shell_tool === false],
    ["features.unified_exec", features?.unified_exec === false],
    ["features.multi_agent", features?.multi_agent === false],
    ["features.apps", features?.apps === false],
    ["web_search", config?.web_search === "disabled"],
    ["project_doc_max_bytes", config?.project_doc_max_bytes === 0],
    [
      "mcp_servers",
      isRecord(mcpServers) && Object.keys(mcpServers).length === 0,
    ],
    ["approval_policy", config?.approval_policy === "never"],
    ["sandbox_mode", config?.sandbox_mode === "read-only"],
  ];

  return checks.flatMap(([name, confirmed]) => (confirmed ? [] : [name]));
}

export class CodexTurnProtocolGuard {
  private turnId: string | null = null;
  private violated = false;
  private interruptSent = false;

  constructor(
    private readonly session: RestrictedCodexSession,
    private readonly threadId: string,
    private readonly onViolation: RestrictedTurnViolationHandler,
  ) {}

  setTurnId(turnId: string): void {
    this.turnId = turnId;
    if (this.violated) this.interruptTurn();
  }

  handle(message: RestrictedProtocolMessage): void {
    const params = isRecord(message.params) ? message.params : null;

    if (message.id !== undefined && typeof message.method === "string") {
      this.session.respond(
        message.id,
        codexServerRequestRefusal(message.method),
      );
      const requestThreadId =
        params && typeof params.threadId === "string" ? params.threadId : null;
      if (!requestThreadId || requestThreadId === this.threadId) {
        const requestTurnId =
          params && typeof params.turnId === "string" ? params.turnId : null;
        if (requestTurnId) this.turnId = requestTurnId;
        this.reject(
          "Codex app-server requested a tool or approval during a restricted target turn.",
          false,
        );
      }
      return;
    }

    if (!params || params.threadId !== this.threadId) return;
    if (message.method === "turn/started") {
      const turn = isRecord(params.turn) ? params.turn : null;
      if (typeof turn?.id === "string") this.setTurnId(turn.id);
      return;
    }

    if (
      message.method !== "item/started" &&
      message.method !== "item/completed"
    ) {
      return;
    }

    if (typeof params.turnId === "string") this.setTurnId(params.turnId);
    const item = isRecord(params.item) ? params.item : null;
    if (!isAllowedCodexNonToolItemType(item?.type)) {
      this.reject(
        "Codex app-server reported an unrecognized or tool item during a restricted target turn.",
        true,
      );
    }
  }

  private reject(message: string, outcomeMayBeUnknown: boolean): void {
    if (!this.violated) {
      this.violated = true;
      this.onViolation(message, outcomeMayBeUnknown);
    }
    this.interruptTurn();
  }

  private interruptTurn(): void {
    if (!this.turnId || this.interruptSent) return;
    this.interruptSent = true;
    void this.session
      .request(
        "turn/interrupt",
        { threadId: this.threadId, turnId: this.turnId },
        2_000,
      )
      .catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
