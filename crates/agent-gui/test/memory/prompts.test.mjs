import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const shared = loader.loadModule("src/lib/memory/prompts/shared.ts");

test("shared policy constants stay single-sourced and contract-aligned", () => {
  assert.ok(shared.MEMORY_CONFIDENCE_CONTRACT_LINE.includes(">=5 characters"));
  assert.ok(shared.PROJECT_MEMORY_WRITE_EVIDENCE_GATE.includes("HARD precondition"));
  assert.equal(shared.MEMORY_SKIP_LIST_ITEMS.length, 5);
});
