import type { CompletePromptRunInput } from "../../lib/automation";

export function createCompletePromptRunInput(
  executionId: string,
  success: boolean,
  durationMs: number,
  output: string,
): CompletePromptRunInput {
  return {
    executionId,
    success,
    durationMs,
    output,
  };
}
