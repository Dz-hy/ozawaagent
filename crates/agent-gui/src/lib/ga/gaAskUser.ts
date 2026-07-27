import type { AskUserQuestionAnswer } from "../chat/askUserQuestion";

export const GA_ASK_CONVERSATION_ARG = "__gaConversationId";

type SubmitOutcome = { ok: boolean; message?: string };
type Sender = (prompt: string) => Promise<boolean>;

const EMPTY_ANSWERS: AskUserQuestionAnswer[] = [];
const senders = new Map<string, Sender>();
const answersByToolCallId = new Map<string, AskUserQuestionAnswer[]>();
const listeners = new Set<() => void>();

function publish() {
  for (const listener of [...listeners]) listener();
}

export function registerGaAskSender(conversationId: string, sender: Sender) {
  senders.set(conversationId, sender);
  return () => {
    if (senders.get(conversationId) === sender) senders.delete(conversationId);
  };
}

export function subscribeGaAskAnswers(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getGaAskAnswers(toolCallId: string) {
  return answersByToolCallId.get(toolCallId) ?? EMPTY_ANSWERS;
}

export function formatGaAskAnswers(answers: AskUserQuestionAnswer[]) {
  if (answers.length === 1) return answers[0]?.selectedLabel.trim() ?? "";
  return answers
    .map((answer) => `${answer.prompt.trim()}\n${answer.selectedLabel.trim()}`)
    .join("\n\n");
}

export async function submitGaAskAnswers(
  toolCallId: string,
  conversationId: string,
  answers: AskUserQuestionAnswer[],
): Promise<SubmitOutcome> {
  if (answersByToolCallId.has(toolCallId)) return { ok: true };
  const sender = senders.get(conversationId);
  if (!sender) return { ok: false, message: "GenericAgent conversation is not available." };
  const prompt = formatGaAskAnswers(answers);
  if (!prompt) return { ok: false, message: "An answer is required." };
  const accepted = await sender(prompt);
  if (!accepted) return { ok: false, message: "GenericAgent did not accept the answer." };
  answersByToolCallId.set(
    toolCallId,
    answers.map((answer) => ({ ...answer })),
  );
  publish();
  return { ok: true };
}
