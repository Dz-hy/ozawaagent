import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const skillBuiltinHelpers = loader.loadModule("src/lib/skills/builtin.ts");

test("builtin agent skills stay selected and sort first", () => {
  assert.deepEqual(skillBuiltinHelpers.mergeAlwaysEnabledSkillNames(["demo-skill"]), [
    "skills-creator",
    "skills-installer",
    "demo-skill",
  ]);
  assert.deepEqual(
    skillBuiltinHelpers.sortSkillsForDisplay([
      { name: "z-skill" },
      { name: "skills-installer" },
      { name: "a-skill" },
      { name: "code-review" },
      { name: "skills-creator" },
    ]).map((skill) => skill.name),
    ["skills-creator", "skills-installer", "a-skill", "code-review", "z-skill"],
  );
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("code-review"), true);
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("skills-creator"), false);
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("workflow-skill"), true);
});