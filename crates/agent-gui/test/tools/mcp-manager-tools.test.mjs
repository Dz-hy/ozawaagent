import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("retired legacy adapter stays removed", () => {
  const modulePath = fileURLToPath(
    new URL("../../src/lib/tools/mcpManagerTools.ts", import.meta.url),
  );
  assert.equal(existsSync(modulePath), false, "mcpManagerTools.ts must not be restored");
});
