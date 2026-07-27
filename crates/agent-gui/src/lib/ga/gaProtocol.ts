import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

const TOOL_HEADER = /^🛠️ Tool: `([^`]+)`\s*(?:📥 args:)?\s*$/;
const FENCE = /^(`{4,})([^`]*)$/;

export type GaProtocolChunk =
  | { kind: "text"; text: string }
  | { kind: "tool"; call: ToolCall; result?: ToolResultMessage };

function parseArguments(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  } catch {
    return { raw: text };
  }
}

function findClosingFence(lines: string[], from: number, ticks: number) {
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "`".repeat(ticks)) return index;
  }
  return -1;
}

function pushText(chunks: GaProtocolChunk[], lines: string[]) {
  const text = lines.join("\n").trim();
  if (text) chunks.push({ kind: "text", text });
}

export function parseGaProtocol(
  text: string,
  idPrefix: string,
  timestamp: number,
): GaProtocolChunk[] {
  const lines = String(text || "").split(/\r?\n/);
  const chunks: GaProtocolChunk[] = [];
  let prose: string[] = [];
  let toolIndex = 0;

  for (let index = 0; index < lines.length; ) {
    const header = TOOL_HEADER.exec(lines[index] || "");
    const argsFence = FENCE.exec((lines[index + 1] || "").trim());
    if (!header || !argsFence || argsFence[2].trim() !== "text") {
      prose.push(lines[index] || "");
      index += 1;
      continue;
    }

    const argsTicks = argsFence[1].length;
    const argsEnd = findClosingFence(lines, index + 2, argsTicks);
    if (argsEnd < 0) {
      prose.push(...lines.slice(index));
      break;
    }

    pushText(chunks, prose);
    prose = [];
    const name = header[1].trim();
    const callId = `${idPrefix}-tool-${toolIndex}`;
    toolIndex += 1;
    const call: ToolCall = {
      type: "toolCall",
      id: callId,
      name,
      arguments: parseArguments(lines.slice(index + 2, argsEnd).join("\n")),
    };
    index = argsEnd + 1;

    let result: ToolResultMessage | undefined;
    const resultFence = FENCE.exec((lines[index] || "").trim());
    if (resultFence && resultFence[1].length >= 5 && resultFence[2].trim() === "") {
      const resultTicks = resultFence[1].length;
      const resultEnd = findClosingFence(lines, index + 1, resultTicks);
      if (resultEnd >= 0) {
        const resultText = lines
          .slice(index + 1, resultEnd)
          .join("\n")
          .trim();
        result = {
          role: "toolResult",
          toolCallId: callId,
          toolName: name,
          content: [{ type: "text", text: resultText }],
          isError: /(?:^|\n)\s*(?:\[Status\]\s*)?(?:❌|error\b|failed\b)/i.test(resultText),
          timestamp,
        };
        index = resultEnd + 1;
      }
    }
    chunks.push(result ? { kind: "tool", call, result } : { kind: "tool", call });
  }
  pushText(chunks, prose);
  return chunks;
}

export function gaProtocolToMessages(
  text: string,
  base: Omit<AssistantMessage, "content">,
  idPrefix: string,
): Message[] {
  const chunks = parseGaProtocol(text, idPrefix, base.timestamp);
  if (!chunks.some((chunk) => chunk.kind === "tool")) {
    return [{ ...base, content: [{ type: "text", text }] }];
  }

  const messages: Message[] = [];
  let assistantContent: AssistantMessage["content"] = [];
  const flushAssistant = () => {
    if (assistantContent.length === 0) return;
    messages.push({ ...base, content: assistantContent });
    assistantContent = [];
  };
  for (const chunk of chunks) {
    if (chunk.kind === "text") {
      assistantContent.push({ type: "text", text: chunk.text });
      continue;
    }
    assistantContent.push(chunk.call);
    flushAssistant();
    if (chunk.result) messages.push(chunk.result);
  }
  flushAssistant();
  return messages;
}
