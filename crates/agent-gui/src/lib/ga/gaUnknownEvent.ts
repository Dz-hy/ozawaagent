import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { GaMessageDto } from "./types";

const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const MAX_DEPTH = 8;

function redact(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return "[max depth]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(nested, depth + 1);
    }
    return out;
  }
  return value;
}

export function gaUnknownMessageToTool(
  message: GaMessageDto,
  idPrefix: string,
  timestamp: number,
): { call: ToolCall; result: ToolResultMessage } {
  const role = String(message.role ?? "unknown");
  const eventType =
    typeof message.type === "string" && message.type.trim() ? message.type.trim() : role;
  const safePayload = redact(message);
  const callId = `${idPrefix}-event`;
  return {
    call: {
      type: "toolCall",
      id: callId,
      name: "GenericAgentEvent",
      arguments: { eventType, role },
    },
    result: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "GenericAgentEvent",
      content: [{ type: "text", text: JSON.stringify(safePayload, null, 2) }],
      isError: false,
      timestamp,
    },
  };
}
