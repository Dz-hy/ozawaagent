import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createTodoToolCall(argumentsValue, id = "call-todo") {
  return { type: "toolCall", id, name: "TodoWrite", arguments: argumentsValue };
}

function loadTodoTools() {
  const loader = createTsModuleLoader();
  return loader.loadModule("src/lib/tools/todoTools.ts");
}

test("TodoWrite schema accepts a well-formed todos array", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule("src/lib/tools/todoTools.ts");
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");
  assert.ok(tool);

  const args = validateToolArguments(
    tool,
    createTodoToolCall({
      todos: [{ content: "Run tests", status: "pending", activeForm: "Running tests" }],
    }),
  );
  assert.deepEqual(args, {
    todos: [{ content: "Run tests", status: "pending", activeForm: "Running tests" }],
  });
});

test("TodoWrite schema rejects a todo item missing content", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule("src/lib/tools/todoTools.ts");
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");

  assert.throws(() =>
    validateToolArguments(
      tool,
      createTodoToolCall({
        todos: [{ status: "pending", activeForm: "Running tests" }],
      }),
    ),
  );
});

test("TodoWrite schema rejects a todo item missing status", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule("src/lib/tools/todoTools.ts");
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");

  assert.throws(() =>
    validateToolArguments(
      tool,
      createTodoToolCall({
        todos: [{ content: "Run tests", activeForm: "Running tests" }],
      }),
    ),
  );
});

test("TodoWrite schema rejects a todo item missing activeForm", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule("src/lib/tools/todoTools.ts");
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");

  assert.throws(() =>
    validateToolArguments(
      tool,
      createTodoToolCall({
        todos: [{ content: "Run tests", status: "pending" }],
      }),
    ),
  );
});

test("TodoWrite schema rejects an invalid status literal", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule("src/lib/tools/todoTools.ts");
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");

  assert.throws(() =>
    validateToolArguments(
      tool,
      createTodoToolCall({
        todos: [{ content: "Run tests", status: "done", activeForm: "Running tests" }],
      }),
    ),
  );
});

test("TodoWrite schema rejects a non-array todos value", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTodoTools, createTodoToolState } = loader.loadModule("src/lib/tools/todoTools.ts");
  const bundle = createTodoTools({ state: createTodoToolState() });
  const tool = bundle.tools.find((candidate) => candidate.name === "TodoWrite");

  assert.throws(() =>
    validateToolArguments(tool, createTodoToolCall({ todos: "not-an-array" })),
  );
});

test("executor stores a valid full todo list and reports isError: false", async () => {
  const { createTodoTools, createTodoToolState } = loadTodoTools();
  const state = createTodoToolState();
  const bundle = createTodoTools({ state });
  const todos = [
    { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
    { content: "Ship release", status: "pending", activeForm: "Shipping release" },
  ];

  const result = await bundle.executeToolCall(createTodoToolCall({ todos }));

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "todo_write");
  assert.deepEqual(result.details.todos, todos);
  assert.deepEqual(state.getTodos(), todos);
});

test("executor replaces rather than merges on a second full-replacement call", async () => {
  const { createTodoTools, createTodoToolState } = loadTodoTools();
  const state = createTodoToolState();
  const bundle = createTodoTools({ state });

  await bundle.executeToolCall(
    createTodoToolCall({
      todos: [
        { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
        { content: "Ship release", status: "pending", activeForm: "Shipping release" },
      ],
    }),
  );

  const secondTodos = [
    { content: "Ship release", status: "in_progress", activeForm: "Shipping release" },
  ];
  const result = await bundle.executeToolCall(createTodoToolCall({ todos: secondTodos }));

  assert.equal(result.isError, false);
  assert.deepEqual(state.getTodos(), secondTodos);
});

test("executor rejects a call with more than one in_progress item", async () => {
  const { createTodoTools, createTodoToolState } = loadTodoTools();
  const state = createTodoToolState();
  const bundle = createTodoTools({ state });

  const result = await bundle.executeToolCall(
    createTodoToolCall({
      todos: [
        { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
        { content: "Ship release", status: "in_progress", activeForm: "Shipping release" },
      ],
    }),
  );

  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /in_progress/);
  assert.match(text, /one at a time|only one/i);
  // A rejected call must not clobber whatever was previously stored.
  assert.deepEqual(state.getTodos(), []);
});

test("executor rejects a malformed todos structure", async () => {
  const { createTodoTools, createTodoToolState } = loadTodoTools();
  const state = createTodoToolState();
  const bundle = createTodoTools({ state });

  const result = await bundle.executeToolCall(
    createTodoToolCall({
      todos: [{ content: "Run tests", status: "pending" }],
    }),
  );

  assert.equal(result.isError, true);
  assert.deepEqual(state.getTodos(), []);
});

test("getOrCreateTodoToolState returns the same state for a conversation and a fresh one after dispose", () => {
  const { getOrCreateTodoToolState, disposeTodoToolState } = loadTodoTools();

  const first = getOrCreateTodoToolState("conversation-todo-1");
  first.setTodos([{ content: "Run tests", status: "pending", activeForm: "Running tests" }]);

  const second = getOrCreateTodoToolState("conversation-todo-1");
  assert.equal(second, first);
  assert.deepEqual(second.getTodos(), [
    { content: "Run tests", status: "pending", activeForm: "Running tests" },
  ]);

  disposeTodoToolState("conversation-todo-1");
  const third = getOrCreateTodoToolState("conversation-todo-1");
  assert.notEqual(third, first);
  assert.deepEqual(third.getTodos(), []);
});
