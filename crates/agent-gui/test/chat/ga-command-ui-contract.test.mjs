import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../src/", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");

test("composer exposes a unified command-first slash palette", () => {
  const composer = source("components/chat/MentionComposer.tsx");
  assert.match(composer, /Commands \/ Skills/);
  const commandLoop = composer.indexOf("for (const command of availableCommands)");
  const skillLoop = composer.indexOf("for (const skill of enabledSkills)", commandLoop);
  assert.ok(commandLoop >= 0 && skillLoop > commandLoop, "commands must precede skills");
  assert.match(composer, /suggestion\.type === "command"/);
  assert.match(composer, /const replacement = `\$\{command\.name\} `;/);
});

test("command discovery is threaded from the bridge to the composer", () => {
  const page = source("pages/ChatPage.tsx");
  const bar = source("pages/chat/components/ChatComposerBar.tsx");
  assert.match(page, /gaBridgeClient\s*\.listCommands\(\)/);
  assert.match(page, /availableCommands=\{availableComposerCommands\}/);
  assert.match(bar, /availableCommands=\{availableCommands\}/);
});

test("typed command execution expands only in the GenericAgent send branch", () => {
  const sender = source("pages/chat/runtime/useSendChatTurn.ts");
  const gaBranch = sender.indexOf("if (gaBridgeClient)");
  const expansion = sender.indexOf("expandGaCommandPrompt", gaBranch);
  const draftClear = sender.indexOf("composerRef.current?.clear()", gaBranch);
  assert.ok(gaBranch >= 0 && expansion > gaBranch);
  assert.ok(draftClear < 0 || expansion < draftClear, "command failure must preserve the draft");
});
