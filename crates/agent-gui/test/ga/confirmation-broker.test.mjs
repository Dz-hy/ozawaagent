import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { confirmationBroker } = loader.loadModule("src/lib/ga/confirmationBroker.ts");

const CONFIRMATION = {
  category: "command",
  target: "scrape",
  name: "/scrape",
  risks: ["shell", "network"],
  source: "user",
  state: "required",
};

test("confirmation broker delivers requests to the single listener", async () => {
  const seen = [];
  const unsubscribe = confirmationBroker.subscribe((confirmation, respond) => {
    seen.push(confirmation);
    respond(true);
  });

  const granted = await confirmationBroker.request(CONFIRMATION);
  assert.equal(granted, true);
  assert.deepEqual(seen, [CONFIRMATION]);
  unsubscribe();
});

test("confirmation broker serializes concurrent requests", async () => {
  const order = [];
  let respondCurrent = null;
  const unsubscribe = confirmationBroker.subscribe((_confirmation, respond) => {
    respondCurrent = respond;
    order.push("shown");
  });

  const first = confirmationBroker.request(CONFIRMATION);
  const second = confirmationBroker.request({ ...CONFIRMATION, target: "other" });
  // 队列串行：第一个请求展示期间，第二个不得被推送
  assert.deepEqual(order, ["shown"]);
  respondCurrent(true);
  assert.equal(await first, true);
  // 第一个回应后，第二个才被推送
  assert.deepEqual(order, ["shown", "shown"]);
  respondCurrent(false);
  assert.equal(await second, false);
  unsubscribe();
});

test("confirmation broker queues requests until a listener subscribes", async () => {
  const pending = confirmationBroker.request(CONFIRMATION);
  let resolved = false;
  pending.then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolved, false, "request must stay pending without a listener");

  const unsubscribe = confirmationBroker.subscribe((_confirmation, respond) => {
    respond(true);
  });
  assert.equal(await pending, true);
  unsubscribe();
});
