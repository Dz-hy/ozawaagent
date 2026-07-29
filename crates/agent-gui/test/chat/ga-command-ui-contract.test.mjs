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

test("typed command execution expands in the sole GenericAgent send path", () => {
  const sender = source("pages/chat/runtime/useSendChatTurn.ts");
  const gaPath = sender.indexOf("GenericAgent is the sole owner of chat semantics");
  const expansion = sender.indexOf("expandGaCommandPrompt", gaPath);
  const draftClear = sender.indexOf("composerRef.current?.clear()", gaPath);
  assert.ok(gaPath >= 0 && expansion > gaPath);
  assert.doesNotMatch(sender, /chatRuntimeHost\.runTurn/);
  assert.ok(draftClear < 0 || expansion < draftClear, "command failure must preserve the draft");
});
