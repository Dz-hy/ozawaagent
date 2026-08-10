import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const rightDockModel = loader.loadModule("src/components/project-tools/rightDockModel.ts");
const RIGHT_DOCK_TAB_IDS = settings.RIGHT_DOCK_SINGLETON_TAB_IDS;

const DAY_MS = 24 * 60 * 60 * 1000;

function settingsWithRightDock(projects, width = 420) {
  return settings.normalizeSettings({
    customSettings: {
      rightDock: { width, projects },
    },
  });
}

test("normalizeRightDockProjectState keeps unknown session ids and never resets activeTabId", () => {
  const state = settings.normalizeRightDockProjectState({
    activeTabId: "session-unknown",
    tabOrder: ["session-a", "session-b", RIGHT_DOCK_TAB_IDS.gitReview],
    tools: { gitReview: { openedAt: 5 } },
    openVersion: 2,
    stateVersion: 3,
    writerId: "writer-x",
    lastUsedAt: 42,
  });

  // Session ids that no client can currently resolve are still user intent.
  assert.deepEqual(state.tabOrder, ["session-a", "session-b", RIGHT_DOCK_TAB_IDS.gitReview]);
  // An active id pointing at an unknown tab is preserved verbatim; resolution
  // happens at render time via resolveEffectiveActiveTabId.
  assert.equal(state.activeTabId, "session-unknown");
  assert.deepEqual(state.tools, { gitReview: { openedAt: 5 } });
  assert.equal(state.openVersion, 2);
  assert.equal(state.stateVersion, 3);
  assert.equal(state.writerId, "writer-x");
  assert.equal(state.lastUsedAt, 42);
});

test("normalizeRightDockProjectState migrates the full legacy tabs shape", () => {
  const state = settings.normalizeRightDockProjectState({
    activeTabId: "terminal-1",
    tabOrder: ["terminal-1", RIGHT_DOCK_TAB_IDS.fileTree],
    tabs: {
      "terminal-1": {
        id: "terminal-1",
        kind: "terminal",
        projectPathKey: "/workspace/app",
        createdAt: 1,
      },
      [RIGHT_DOCK_TAB_IDS.fileTree]: {
        id: RIGHT_DOCK_TAB_IDS.fileTree,
        kind: "fileTree",
        projectPathKey: "/workspace/app",
        createdAt: 7,
        uiState: {
          query: "abc",
          selectedPath: "src/x.ts",
          expandedPaths: ["", "src"],
          showHidden: true,
          revision: 2,
          stateVersion: 3,
        },
      },
      invalid: {
        id: "invalid",
        kind: "unknown",
        projectPathKey: "/workspace/app",
        createdAt: 9,
      },
    },
    openVersion: 4,
    stateVersion: 5,
  });

  // Terminal and invalid entries are dropped from tools; fileTree migrates
  // with openedAt taken from the legacy createdAt.
  assert.deepEqual(state.tools, {
    fileTree: {
      openedAt: 7,
      uiState: {
        query: "abc",
        selectedPath: "src/x.ts",
        expandedPaths: ["", "src"],
        showHidden: true,
        revision: 2,
      },
    },
  });
  // The terminal session id survives in tabOrder even though its tab entry
  // was dropped.
  assert.deepEqual(state.tabOrder, ["terminal-1", RIGHT_DOCK_TAB_IDS.fileTree]);
  assert.equal(state.activeTabId, "terminal-1");
  assert.equal(state.openVersion, 4);
  assert.equal(state.stateVersion, 5);
  assert.equal(state.writerId, "");
  assert.equal(state.lastUsedAt, 0);
});

test("normalizeRightDockSettings keeps the 100 most recently used project buckets", () => {
  const projects = {};
  // First-inserted bucket has the oldest lastUsedAt: the legacy behaviour
  // (insertion-order break) would evict the last-inserted key instead.
  for (let i = 0; i <= 100; i += 1) {
    projects[`/workspace/p${String(i).padStart(3, "0")}`] = {
      tabOrder: [RIGHT_DOCK_TAB_IDS.gitReview],
      tools: { gitReview: { openedAt: 1 } },
      openVersion: 1,
      stateVersion: 1,
      writerId: "w",
      lastUsedAt: 1_000 + i,
    };
  }

  const normalized = settings.normalizeRightDockSettings({ width: 420, projects });

  assert.equal(Object.keys(normalized.projects).length, 100);
  assert.equal(normalized.projects["/workspace/p000"], undefined);
  assert.ok(normalized.projects["/workspace/p001"]);
  assert.ok(normalized.projects["/workspace/p100"]);
});

test("normalizeRightDockSettings expires tombstones after the 90 day TTL", () => {
  const now = Date.now();
  const tombstone = (lastUsedAt) => ({
    tabOrder: [],
    tools: {},
    openVersion: 1,
    stateVersion: 1,
    writerId: "w",
    lastUsedAt,
  });

  const normalized = settings.normalizeRightDockSettings({
    projects: {
      "/workspace/expired": tombstone(now - 91 * DAY_MS),
      "/workspace/fresh": tombstone(now - 89 * DAY_MS),
      "/workspace/unstamped": tombstone(0),
      // Truly empty buckets (no tools, both versions 0) are dropped outright.
      "/workspace/empty": { tabOrder: [], tools: {}, openVersion: 0, stateVersion: 0 },
    },
  });

  assert.equal(normalized.projects["/workspace/expired"], undefined);
  assert.ok(normalized.projects["/workspace/fresh"]);
  assert.equal(normalized.projects["/workspace/fresh"].lastUsedAt, now - 89 * DAY_MS);
  // A tombstone without a timestamp starts its expiry clock at "now".
  const unstamped = normalized.projects["/workspace/unstamped"];
  assert.ok(unstamped);
  assert.ok(unstamped.lastUsedAt >= now);
  assert.ok(unstamped.lastUsedAt <= Date.now());
  assert.equal(normalized.projects["/workspace/empty"], undefined);
});

test("resolveEffectiveActiveTabId resolves persisted ids against visible tabs", () => {
  const resolve = rightDockModel.resolveEffectiveActiveTabId;
  const visible = ["session-1", RIGHT_DOCK_TAB_IDS.fileTree];

  // (a) visible id is returned as-is.
  assert.equal(resolve("session-1", visible, false), "session-1");
  assert.equal(resolve(RIGHT_DOCK_TAB_IDS.fileTree, visible, true), RIGHT_DOCK_TAB_IDS.fileTree);
  // (b) unknown session id while sessions are still loading: wait, do not
  // fall back (falling back would race the session list).
  assert.equal(resolve("session-later", visible, false), null);
  // (c) unknown session id once sessions are loaded: it is dead, fall back.
  assert.equal(resolve("session-dead", visible, true), "session-1");
  // (d) a tool id can never appear later; fall back even before sessions load.
  assert.equal(resolve(RIGHT_DOCK_TAB_IDS.gitReview, visible, false), "session-1");
  // (e) no persisted id: first visible tab, or null when nothing is visible.
  assert.equal(resolve(undefined, visible, false), "session-1");
  assert.equal(resolve(undefined, [], true), null);
});

test("closeRightDockToolTabState removes the tool and reassigns activeTabId only when needed", () => {
  const state = {
    activeTabId: RIGHT_DOCK_TAB_IDS.gitReview,
    tabOrder: ["session-1", RIGHT_DOCK_TAB_IDS.gitReview, RIGHT_DOCK_TAB_IDS.fileTree],
    tools: { gitReview: { openedAt: 1 }, fileTree: { openedAt: 2 } },
    openVersion: 2,
    stateVersion: 3,
    writerId: "w",
    lastUsedAt: 9,
  };

  const closedActive = rightDockModel.closeRightDockToolTabState(state, "gitReview", "session-1");
  assert.equal(closedActive.activeTabId, "session-1");
  assert.deepEqual(closedActive.tabOrder, ["session-1", RIGHT_DOCK_TAB_IDS.fileTree]);
  assert.deepEqual(Object.keys(closedActive.tools), ["fileTree"]);
  // Pure content transform: version stamping happens in
  // updateRightDockProjectState, not here.
  assert.equal(closedActive.openVersion, 2);
  assert.equal(closedActive.stateVersion, 3);

  const closedInactive = rightDockModel.closeRightDockToolTabState(state, "fileTree", null);
  assert.equal(closedInactive.activeTabId, RIGHT_DOCK_TAB_IDS.gitReview);
  assert.deepEqual(closedInactive.tabOrder, ["session-1", RIGHT_DOCK_TAB_IDS.gitReview]);
  assert.deepEqual(Object.keys(closedInactive.tools), ["gitReview"]);

  // Closing a tool that is not open returns the same reference.
  assert.equal(rightDockModel.closeRightDockToolTabState(closedActive, "gitReview", null), closedActive);
});

describe("tab drag engine", () => {
  // a: [0,80) b: [84,244) (wide) c: [248,308)
  const slots = [
    { id: "a", left: 0, width: 80 },
    { id: "b", left: 84, width: 160 },
    { id: "c", left: 248, width: 60 },
  ];

  test("computeTabDragInsertIndex crosses a neighbour when the dragged edge passes its midpoint", () => {
    const index = (draggedId, offset) =>
      rightDockModel.computeTabDragInsertIndex(slots, draggedId, offset);
    // Dragging "a" rightwards: its right edge (80 + offset) crosses b's
    // midpoint (164) past offset 84, then c's midpoint (278) past offset 198.
    assert.equal(index("a", 0), 0);
    assert.equal(index("a", 84), 0);
    assert.equal(index("a", 85), 1);
    assert.equal(index("a", 198), 1);
    assert.equal(index("a", 199), 2);
    // Dragging "c" leftwards: its left edge (248 + offset) crosses b's
    // midpoint at offset -85, then a's midpoint (40) at offset -209.
    assert.equal(index("c", 0), 2);
    assert.equal(index("c", -84), 2);
    assert.equal(index("c", -85), 1);
    assert.equal(index("c", -208), 1);
    assert.equal(index("c", -209), 0);
    // Because the snapshot never changes mid-drag, the same offset always
    // yields the same index — the live-DOM variant oscillated here when the
    // dragged tab was narrower than its neighbour.
    assert.equal(index("c", -100), index("c", -100));
    // Unknown dragged id degrades to index 0 (the caller guards on the slot).
    assert.equal(index("ghost", 0), 0);
  });

  test("computeTabDragInsertIndex reaches both ends within the clamp range", () => {
    const index = (draggedId, offset) =>
      rightDockModel.computeTabDragInsertIndex(slots, draggedId, offset);
    const clamp = (draggedId, offset) =>
      rightDockModel.clampTabDragOffset(slots, draggedId, offset);
    // "b" (width 160) is wider than both neighbours. Under the old
    // center-vs-midpoint rule its center could never pass a's midpoint within
    // the clamp, making the first slot unreachable.
    assert.equal(index("b", clamp("b", -9999)), 0);
    assert.equal(index("b", clamp("b", 9999)), 2);
    // "a" (width 80) is wider than "c" (width 60): the last slot must still
    // be reachable at the right clamp limit.
    assert.equal(index("a", clamp("a", 9999)), 2);
    assert.equal(index("c", clamp("c", -9999)), 0);
  });

  test("applyTabDragInsertIndex produces the final order and clamps the index", () => {
    const apply = rightDockModel.applyTabDragInsertIndex;
    assert.deepEqual(apply(["a", "b", "c"], "a", 2), ["b", "c", "a"]);
    assert.deepEqual(apply(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
    assert.deepEqual(apply(["a", "b", "c"], "b", 1), ["a", "b", "c"]);
    assert.deepEqual(apply(["a", "b", "c"], "a", 99), ["b", "c", "a"]);
    assert.deepEqual(apply(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
    // Unknown dragged id: order unchanged.
    assert.deepEqual(apply(["a", "b"], "ghost", 1), ["a", "b"]);
  });

  test("computeTabShiftOffsets opens the drop gap by one dragged width plus gap", () => {
    const shift = (draggedId, insertIndex) =>
      rightDockModel.computeTabShiftOffsets(slots, draggedId, insertIndex, 4);
    // "a" (width 80) dragged past both: b and c slide left by 84.
    assert.deepEqual(shift("a", 2), { b: -84, c: -84 });
    assert.deepEqual(shift("a", 1), { b: -84 });
    assert.deepEqual(shift("a", 0), {});
    // "c" (width 60) dragged to the front: a and b slide right by 64.
    assert.deepEqual(shift("c", 0), { a: 64, b: 64 });
    assert.deepEqual(shift("c", 1), { b: 64 });
    assert.deepEqual(shift("c", 2), {});
    assert.deepEqual(rightDockModel.computeTabShiftOffsets(slots, "ghost", 0, 4), {});
  });

  test("clampTabDragOffset keeps the dragged tab inside the strip content bounds", () => {
    const clamp = (draggedId, offset) =>
      rightDockModel.clampTabDragOffset(slots, draggedId, offset);
    // Content spans [0, 308]; "a" (left 0, width 80) may move within [0, 228].
    assert.equal(clamp("a", -50), 0);
    assert.equal(clamp("a", 120), 120);
    assert.equal(clamp("a", 500), 228);
    // "c" (left 248, width 60) may move within [-248, 0].
    assert.equal(clamp("c", 50), 0);
    assert.equal(clamp("c", -500), -248);
    assert.equal(clamp("ghost", 30), 0);
  });

  test("computeTabAutoScrollVelocity ramps with pointer depth into either edge", () => {
    const velocity = (clientX) => rightDockModel.computeTabAutoScrollVelocity(100, 500, clientX);
    assert.equal(velocity(300), 0);
    assert.equal(velocity(141), 0);
    assert.equal(velocity(459), 0);
    // Deeper into the edge zone scrolls faster; beyond the edge is clamped.
    assert.ok(velocity(110) < velocity(130));
    assert.ok(velocity(130) < 0);
    assert.ok(velocity(470) > 0);
    assert.ok(velocity(490) > velocity(470));
    assert.equal(velocity(0), -rightDockModel.TAB_AUTO_SCROLL_MAX_STEP_PX);
    assert.equal(velocity(999), rightDockModel.TAB_AUTO_SCROLL_MAX_STEP_PX);
  });

  test("horizontal keyboard reorder keeps the existing Left/Right behavior", () => {
    assert.deepEqual(rightDockModel.reorderTabIdsByKeyboard(["a", "b", "c"], "b", "ArrowLeft"), [
      "b",
      "a",
      "c",
    ]);
    assert.deepEqual(rightDockModel.reorderTabIdsByKeyboard(["a", "b", "c"], "b", "ArrowRight"), [
      "a",
      "c",
      "b",
    ]);
  });
});

test("rightDockNeighborTabId picks the right neighbour, then the left, then null", () => {
  const ids = ["a", "b", "c"];
  assert.equal(rightDockModel.rightDockNeighborTabId(ids, "b"), "c");
  assert.equal(rightDockModel.rightDockNeighborTabId(ids, "c"), "b");
  assert.equal(rightDockModel.rightDockNeighborTabId(["only"], "only"), null);
});

test("updateRightDockProjectState stamps versions centrally and skips no-op updates", () => {
  const base = settings.normalizeSettings({});
  const opened = settings.openRightDockSingletonTab(base, "/workspace/app", "gitReview");

  // Content-identical updates return the previous settings reference.
  assert.equal(
    settings.updateRightDockProjectState(opened, "/workspace/app", (current) => ({ ...current })),
    opened,
  );
  // Re-opening the already-active singleton is also a no-op.
  assert.equal(settings.openRightDockSingletonTab(opened, "/workspace/app", "gitReview"), opened);

  const before = settings.getRightDockProjectState(opened.customSettings, "/workspace/app");
  const changed = settings.updateRightDockProjectState(opened, "/workspace/app", (current) => ({
    ...current,
    tabOrder: [...current.tabOrder, "session-new"],
  }));
  const after = settings.getRightDockProjectState(changed.customSettings, "/workspace/app");

  assert.deepEqual(after.tabOrder, [RIGHT_DOCK_TAB_IDS.gitReview, "session-new"]);
  assert.equal(after.stateVersion, before.stateVersion + 1);
  assert.equal(after.writerId, settings.getRightDockWriterId());
  assert.ok(after.lastUsedAt >= before.lastUsedAt);
});
