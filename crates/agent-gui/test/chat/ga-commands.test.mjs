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
  const execute = async (id, argsText) => {
    calls.push([id, argsText]);
    return { command_id: id, result: { type: "prompt", prompt: `expanded:${argsText}` } };
  };
  assert.equal(await expandGaCommandPrompt("hello", execute), "hello");
  assert.equal(await expandGaCommandPrompt("/goal ship", execute), "expanded:ship");
  assert.deepEqual(calls, [["goal", "ship"]]);
});

test("unknown GA commands fall back but registry failures remain visible", async () => {
  const { GaBridgeError } = loadModule("src/lib/ga/types.ts");
  assert.equal(
    await expandGaCommandPrompt("/unknown", async () => {
      throw new GaBridgeError("missing", "command_not_found", 404);
    }),
    "/unknown",
  );
  await assert.rejects(
    expandGaCommandPrompt("/goal", async () => {
      throw new GaBridgeError("offline", "command_registry_unavailable", 503);
    }),
    /offline/,
  );
});
