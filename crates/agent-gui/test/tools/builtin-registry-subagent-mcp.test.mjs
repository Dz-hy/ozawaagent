import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("retired legacy builtin registry stays removed", () => {
  const modulePath = fileURLToPath(
    new URL("../../src/lib/tools/builtinRegistry.ts", import.meta.url),
  );
  assert.equal(existsSync(modulePath), false, "builtinRegistry.ts must not be restored");
});
