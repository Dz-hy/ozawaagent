import type { GaCommandControlResult, GaCommandResult } from "../../../lib/ga/types";
import { GaBridgeError } from "../../../lib/ga/types";

export type GaCommandExecutor = (
  commandId: string,
  argsText: string,
  sessionId?: string,
) => Promise<GaCommandResult>;

export type ParsedGaCommand = { id: string; argsText: string };
export type GaCommandExpansion = {
  text: string;
  handled: boolean;
  control?: GaCommandControlResult;
};

/**
 * Parse only an exact command at the start
 * of the complete prompt. `/skill` remains the explicit skill escape and is never sent to the command registry.
 */
export function parseGaCommand(text: string): ParsedGaCommand | null {
  const match = /^\/([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  if (!match || match[1] === "skill") return null;
  return { id: match[1], argsText: (match[2] ?? "").trim() };
}

export async function expandGaCommandPrompt(
  text: string,
  execute: GaCommandExecutor,
  sessionId?: string,
): Promise<GaCommandExpansion> {
  const command = parseGaCommand(text);
  if (!command) return { text, handled: false };
  try {
    const completed = await execute(command.id, command.argsText, sessionId);
    if (completed.result.type === "control") {
      return {
        text: "",
        handled: completed.result.handled,
        control: completed.result,
      };
    }
    return { text: completed.result.prompt, handled: false };
  } catch (error) {
    if (error instanceof GaBridgeError && error.code === "command_not_found") {
      return { text, handled: false };
    }
    throw error;
  }
}
