import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../src/", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");

test("settings routes hooks and cron to GenericAgent-backed views", () => {
  const settings = source("pages/SettingsPage.tsx");
  assert.match(settings, /case "hooks":[\s\S]*<GaHooksSection \/>/);
  assert.match(settings, /case "cron":[\s\S]*<GaAutomationSection \/>/);
  assert.doesNotMatch(settings, /<HooksSection/);
  assert.doesNotMatch(settings, /<CronSection/);
});

test("settings routes providers exclusively to GenericAgent model profiles", () => {
  const settings = source("pages/SettingsPage.tsx");
  const types = source("pages/settings/types.ts");
  assert.match(settings, /case "providers":[\s\S]*<GaModelProfilesSection \/>/);
  assert.doesNotMatch(settings, /ProvidersSection/);
  assert.doesNotMatch(settings, /id: "models"/);
  assert.doesNotMatch(types, /\| "models"/);
});

test("application startup does not initialize or execute legacy automation or memory engines", () => {
  const app = source("App.tsx");
  assert.doesNotMatch(app, /initAutomation/);
  assert.doesNotMatch(app, /CronPromptRunner/);
  assert.doesNotMatch(app, /MemoryOrganizerHost/);
});

test("GenericAgent hooks are read-only and automation is Agent Prompt only", () => {
  const hooks = source("pages/settings/GaHooksSection.tsx");
  const automation = source("pages/settings/GaAutomationSection.tsx");
  assert.match(hooks, /gaBridgeClient\.getHooks\(\)/);
  assert.match(hooks, /snapshot\?\.observations/);
  assert.doesNotMatch(hooks, /createHook|updateHook|deleteHook|discover_and_load|observation\.ctx/);
  assert.match(automation, /gaBridgeClient\.createAutomation/);
  assert.match(automation, /gaBridgeClient\.updateAutomation/);
  assert.match(automation, /gaBridgeClient\.deleteAutomation/);
  assert.doesNotMatch(automation, /bash|http|runCronNow|runNow/);
});
