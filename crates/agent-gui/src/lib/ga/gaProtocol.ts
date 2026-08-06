import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { GA_ASK_CONVERSATION_ARG } from "./gaAskUser";

const TOOL_HEADER = /^🛠️ Tool: `([^`]+)`\s*(?:📥 args:)?\s*$/;
const FENCE = /^(`{4,})([^`]*)$/;
const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

export type GaProtocolChunk =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
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

function normalizeToolArguments(
  name: string,
  args: Record<string, unknown>,
  conversationId?: string,
): Record<string, unknown> {
  if (name !== "ask_user") return args;
  const question = typeof args.question === "string" ? args.question.trim() : "";
  const candidates = Array.isArray(args.candidates)
    ? args.candidates.map((candidate) => String(candidate).trim()).filter(Boolean)
    : [];
  return {
    questions: [
      {
        id: "q1",
        prompt: question || "GenericAgent needs your input.",
        options:
          candidates.length > 0 ? candidates.map((label) => ({ label })) : [{ label: "Continue" }],
      },
    ],
    ...(conversationId ? { [GA_ASK_CONVERSATION_ARG]: conversationId } : {}),
  };
}

function findClosingFence(lines: string[], from: number, ticks: number) {
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "`".repeat(ticks)) return index;
  }
  return -1;
}

function pushTextChunk(chunks: GaProtocolChunk[], text: string) {
  const normalized = text.trim();
  if (normalized) chunks.push({ kind: "text", text: normalized });
}

export type GaProtocolOptions = {
  allowUnclosedThinking?: boolean;
};

function pushMixedText(chunks: GaProtocolChunk[], text: string, options: GaProtocolOptions = {}) {
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(THINKING_OPEN, cursor);
    if (open < 0) {
      pushTextChunk(chunks, text.slice(cursor));
      return;
    }

    const close = text.indexOf(THINKING_CLOSE, open + THINKING_OPEN.length);
    if (close < 0) {
      if (!options.allowUnclosedThinking) {
        pushTextChunk(chunks, text.slice(cursor));
        return;
      }
      pushTextChunk(chunks, text.slice(cursor, open));
      const thinking = text.slice(open + THINKING_OPEN.length).trim();
      if (thinking) {
        chunks.push({ kind: "thinking", text: thinking });
      } else {
        pushTextChunk(chunks, text.slice(open));
      }
      return;
    }

    pushTextChunk(chunks, text.slice(cursor, open));
    const thinking = text.slice(open + THINKING_OPEN.length, close).trim();
    if (thinking) chunks.push({ kind: "thinking", text: thinking });
    cursor = close + THINKING_CLOSE.length;
  }
}

function pushText(chunks: GaProtocolChunk[], lines: string[], options?: GaProtocolOptions) {
  pushMixedText(chunks, lines.join("\n"), options);
}

export function parseGaProtocol(
  text: string,
  idPrefix: string,
  timestamp: number,
  conversationId?: string,
  options?: GaProtocolOptions,
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

    pushText(chunks, prose, options);
    prose = [];
    const rawName = header[1].trim();
    const name = rawName === "ask_user" ? "AskUserQuestion" : rawName;
    const callId = `${idPrefix}-tool-${toolIndex}`;
    toolIndex += 1;
    const parsedArguments = parseArguments(lines.slice(index + 2, argsEnd).join("\n"));
    const call: ToolCall = {
      type: "toolCall",
      id: callId,
      name,
      arguments: normalizeToolArguments(rawName, parsedArguments, conversationId),
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
  pushText(chunks, prose, options);
  return chunks;
}

function appendAssistantContentChunk(content: AssistantMessage["content"], chunk: GaProtocolChunk) {
  if (chunk.kind === "text") {
    content.push({ type: "text", text: chunk.text });
  } else if (chunk.kind === "thinking") {
    content.push({ type: "thinking", thinking: chunk.text });
  } else {
    content.push(chunk.call);
  }
}

export function gaProtocolToMessages(
  text: string,
  base: Omit<AssistantMessage, "content">,
  idPrefix: string,
  conversationId?: string,
  options?: GaProtocolOptions,
): Message[] {
  const chunks = parseGaProtocol(text, idPrefix, base.timestamp, conversationId, options);
  if (!chunks.some((chunk) => chunk.kind === "tool")) {
    if (chunks.length === 0 || (chunks.length === 1 && chunks[0]?.kind === "text")) {
      return [{ ...base, content: [{ type: "text", text }] }];
    }
    const content: AssistantMessage["content"] = [];
    for (const chunk of chunks) appendAssistantContentChunk(content, chunk);
    return [{ ...base, content }];
  }

  const messages: Message[] = [];
  let assistantContent: AssistantMessage["content"] = [];
  const flushAssistant = () => {
    if (assistantContent.length === 0) return;
    messages.push({ ...base, content: assistantContent });
    assistantContent = [];
  };
  for (const chunk of chunks) {
    if (chunk.kind === "tool") {
      assistantContent.push(chunk.call);
      flushAssistant();
      if (chunk.result) messages.push(chunk.result);
      continue;
    }
    appendAssistantContentChunk(assistantContent, chunk);
  }
  flushAssistant();
  return messages;
}
