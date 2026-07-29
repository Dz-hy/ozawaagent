import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("retired LiveAgent shell tool adapter stays removed", () => {
  const modulePath = fileURLToPath(new URL("../../src/lib/tools/shellTools.ts", import.meta.url));
  assert.equal(existsSync(modulePath), false, "shellTools.ts must not be restored");
});
