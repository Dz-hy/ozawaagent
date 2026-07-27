import type { GaCommandResult } from "../../../lib/ga/types";
import { GaBridgeError } from "../../../lib/ga/types";

export type GaCommandExecutor = (commandId: string, argsText: string) => Promise<GaCommandResult>;

export type ParsedGaCommand = { id: string; argsText: string };

/**
 * Parse only an exact command at the start of the complete prompt. `/skill`
 * remains the explicit skill escape and is never sent to the command registry.
 */
export function parseGaCommand(text: string): ParsedGaCommand | null {
  const match = /^\/([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  if (!match || match[1] === "skill") return null;
  return { id: match[1], argsText: (match[2] ?? "").trim() };
}

export async function expandGaCommandPrompt(
  text: string,
  execute: GaCommandExecutor,
): Promise<string> {
  const command = parseGaCommand(text);
  if (!command) return text;
  try {
    const completed = await execute(command.id, command.argsText);
    return completed.result.type === "prompt" ? completed.result.prompt : text;
  } catch (error) {
    if (error instanceof GaBridgeError && error.code === "command_not_found") return text;
    throw error;
  }
}
