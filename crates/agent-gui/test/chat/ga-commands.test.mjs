import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { loadModule } = createTsModuleLoader({
  stubs: {
    "../../../lib/ga/types": {
      GaBridgeError: class GaBridgeError extends Error {
        constructor(message, code, status) {
          super(message);
          this.code = code;
          this.status = status;
        }
      },
    },
  },
});
const { expandGaCommandPrompt, parseGaCommand } = loadModule(
  "src/pages/chat/runtime/gaCommands.ts",
);

test("GA commands parse only complete line-start command prompts", () => {
  assert.deepEqual(parseGaCommand("/goal ship it"), { id: "goal", argsText: "ship it" });
  assert.deepEqual(parseGaCommand("  /goal\tship\nnext  "), {
    id: "goal",
    argsText: "ship\nnext",
  });
  assert.equal(parseGaCommand("prefix /goal ship"), null);
  assert.equal(parseGaCommand("/goal.more"), null);
  assert.equal(parseGaCommand("/skill goal"), null);
});

test("GA commands expand through the registry while preserving ordinary prompts", async () => {
  const calls = [];
  const execute = async (id, argsText, sessionId) => {
    calls.push([id, argsText, sessionId]);
    return { command_id: id, result: { type: "prompt", prompt: `expanded:${argsText}` } };
  };
  assert.deepEqual(await expandGaCommandPrompt("hello", execute), { text: "hello", handled: false });
  assert.deepEqual(await expandGaCommandPrompt("/goal ship", execute), {
    text: "expanded:ship",
    handled: false,
  });
  assert.deepEqual(calls, [["goal", "ship", undefined]]);
});

test("control commands are handled without becoming prompts", async () => {
  const calls = [];
  const execute = async (id, argsText, sessionId) => {
    calls.push([id, argsText, sessionId]);
    return {
      command_id: id,
      result: { type: "control", handled: true, runtime: { reasoning_effort: argsText } },
    };
  };
  assert.deepEqual(await expandGaCommandPrompt("/effort high", execute, "s1"), {
    text: "",
    handled: true,
    control: { type: "control", handled: true, runtime: { reasoning_effort: "high" } },
  });
  assert.deepEqual(calls, [["effort", "high", "s1"]]);
});

test("unknown GA commands fall back but registry failures remain visible", async () => {
  const { GaBridgeError } = loadModule("src/lib/ga/types.ts");
  assert.deepEqual(
    await expandGaCommandPrompt("/unknown", async () => {
      throw new GaBridgeError("missing", "command_not_found", 404);
    }),
    { text: "/unknown", handled: false },
  );
  await assert.rejects(
    expandGaCommandPrompt("/goal", async () => {
      throw new GaBridgeError("offline", "command_registry_unavailable", 503);
    }),
    /offline/,
  );
});
