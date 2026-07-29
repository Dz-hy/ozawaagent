import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const pathUtils = loader.loadModule("src/lib/tools/pathUtils.ts");
const systemToolOptions = loader.loadModule("src/lib/tools/systemToolOptions.ts");
const skillBuiltinHelpers = loader.loadModule("src/lib/skills/builtin.ts");

test("ToolPathResolver accepts broad workspace path inputs", async () => {
  const resolver = new pathUtils.ToolPathResolver({ workdir: "/workspace/project" });

  const relative = await resolver.resolvePath(" ./src\\App.tsx ", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(relative.scope, "workspace");
  assert.equal(relative.relativePath, "src/App.tsx");
  assert.equal(relative.absolutePath, "/workspace/project/src/App.tsx");
  assert.equal(relative.displayPath, "src/App.tsx");
  assert.equal(relative.root, "/workspace/project");
  assert.ok(!("pathRef" in relative));

  const absolute = await resolver.resolvePath("/workspace/project/src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(absolute.scope, "workspace");
  assert.equal(absolute.relativePath, "src/App.tsx");

  const fileUrl = await resolver.resolvePath("file:///workspace/project/src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(fileUrl.scope, "workspace");
  assert.equal(fileUrl.relativePath, "src/App.tsx");

  const pathRef = await resolver.resolvePath("workspace:src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(pathRef.scope, "workspace");
  assert.equal(pathRef.relativePath, "src/App.tsx");

  await assert.rejects(
    () =>
      resolver.resolvePath("../secret", {
        label: "Read.path",
        intent: "read",
        required: true,
      }),
    /cannot contain \.\./,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("//server/share/file.txt", {
        label: "Read.path",
        intent: "read",
        required: true,
      }),
    /UNC path/,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("file:////server/share/file.txt", {
        label: "Read.path",
        intent: "read",
        required: true,
        allowExternal: true,
      }),
    /UNC paths are not supported/,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("file://server/share/file.txt", {
        label: "Read.path",
        intent: "read",
        required: true,
        allowExternal: true,
      }),
    /UNC paths are not supported/,
  );
});

test("ToolPathResolver normalizes Windows workspace path variants", async () => {
  const resolver = new pathUtils.ToolPathResolver({ workdir: "C:/Users/Alice/Repo" });

  const relative = await resolver.resolvePath("src\\App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(relative.scope, "workspace");
  assert.equal(relative.relativePath, "src/App.tsx");
  assert.equal(relative.absolutePath, "C:/Users/Alice/Repo/src/App.tsx");

  const absolute = await resolver.resolvePath("C:\\Users\\Alice\\Repo\\src\\App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(absolute.scope, "workspace");
  assert.equal(absolute.relativePath, "src/App.tsx");

  const lowercaseDrive = await resolver.resolvePath("c:/users/alice/repo/src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(lowercaseDrive.scope, "workspace");
  assert.equal(lowercaseDrive.relativePath, "src/App.tsx");

  const driveFileUrl = await resolver.resolvePath("file:///C:/Users/Alice/Repo/src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(driveFileUrl.scope, "workspace");
  assert.equal(driveFileUrl.relativePath, "src/App.tsx");

  const localhostFileUrl = await resolver.resolvePath(
    "file://localhost/C:/Users/Alice/Repo/src/App.tsx",
    {
      label: "Read.path",
      intent: "read",
      required: true,
    },
  );
  assert.equal(localhostFileUrl.scope, "workspace");
  assert.equal(localhostFileUrl.relativePath, "src/App.tsx");

  const extendedWorkdirResolver = new pathUtils.ToolPathResolver({
    workdir: "\\\\?\\C:\\Users\\Alice\\Repo",
  });
  const normalPathWithExtendedWorkdir = await extendedWorkdirResolver.resolvePath(
    "C:\\Users\\Alice\\Repo\\src\\App.tsx",
    {
      label: "Read.path",
      intent: "read",
      required: true,
    },
  );
  assert.equal(normalPathWithExtendedWorkdir.scope, "workspace");
  assert.equal(normalPathWithExtendedWorkdir.relativePath, "src/App.tsx");

  const extendedPath = await resolver.resolvePath("\\\\?\\C:\\Users\\Alice\\Repo\\src\\App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(extendedPath.scope, "workspace");
  assert.equal(extendedPath.relativePath, "src/App.tsx");

  await assert.rejects(
    () =>
      resolver.resolvePath("C:Users\\Alice\\Repo\\src\\App.tsx", {
        label: "Read.path",
        intent: "read",
        required: true,
      }),
    /cannot contain ':' path segments/,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("\\\\server\\share\\file.txt", {
        label: "Read.path",
        intent: "read",
        required: true,
        allowExternal: true,
      }),
    /UNC path/,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("\\\\?\\UNC\\server\\share\\file.txt", {
        label: "Read.path",
        intent: "read",
        required: true,
        allowExternal: true,
      }),
    /UNC path/,
  );
});

test("ToolPathResolver resolves enabled Skill paths and gates external paths by intent", async () => {
  const resolver = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["skills-creator"],
      allowedSkillBaseDirs: ["skills-creator"],
    },
  });

  const skillUrl = await resolver.resolvePath("skill://skills-creator/SKILL.md", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(skillUrl.scope, "skill");
  assert.equal(skillUrl.relativePath, "skills-creator/SKILL.md");
  assert.equal(skillUrl.absolutePath, "/Users/me/.liveagent/skills/skills-creator/SKILL.md");
  assert.equal(skillUrl.displayPath, "skill://skills-creator/SKILL.md");
  assert.equal(skillUrl.root, "/Users/me/.liveagent/skills");
  assert.ok(!("pathRef" in skillUrl));

  const absoluteSkill = await resolver.resolvePath(
    "/Users/me/.liveagent/skills/skills-creator/SKILL.md",
    {
      label: "Read.path",
      intent: "read",
      required: true,
    },
  );
  assert.equal(absoluteSkill.scope, "skill");
  assert.equal(absoluteSkill.relativePath, "skills-creator/SKILL.md");

  await assert.rejects(
    () =>
      resolver.resolvePath("skill://metaphysics-steward/SKILL.md", {
        label: "Read.path",
        intent: "read",
        required: true,
      }),
    /not enabled/,
  );

  const stagedUpload = await resolver.resolvePath(
    "/Users/me/.liveagent/uploads/1721550000000/report.pdf",
    {
      label: "Read.path",
      intent: "read",
      required: true,
    },
  );
  assert.equal(stagedUpload.scope, "uploads");
  assert.equal(stagedUpload.root, "/Users/me/.liveagent/uploads");
  assert.equal(stagedUpload.relativePath, "1721550000000/report.pdf");
  assert.equal(stagedUpload.displayPath, "uploads/1721550000000/report.pdf");

  const stagedUploadDir = await resolver.resolvePath(
    "C:\\Users\\Me\\.liveagent\\uploads\\1721550000000",
    {
      label: "List.path",
      intent: "list",
      required: true,
    },
  );
  assert.equal(stagedUploadDir.scope, "uploads");
  assert.equal(stagedUploadDir.relativePath, "1721550000000");

  const stagedUploadRoot = await resolver.resolvePath("/Users/me/.liveagent/uploads", {
    label: "List.path",
    intent: "list",
    required: true,
  });
  assert.equal(stagedUploadRoot.scope, "uploads");
  assert.equal(stagedUploadRoot.root, "/Users/me/.liveagent/uploads");
  assert.equal(stagedUploadRoot.absolutePath, "/Users/me/.liveagent/uploads");
  assert.equal(stagedUploadRoot.relativePath, undefined);
  assert.equal(stagedUploadRoot.displayPath, "uploads");

  await assert.rejects(
    () =>
      resolver.resolvePath("/Users/me/.liveagent/uploads", {
        label: "Write.path",
        intent: "write",
        required: true,
      }),
    /only supports read access/,
  );

  await assert.rejects(
    () =>
      resolver.resolvePath("/Users/me/.liveagent/uploads/1721550000000/report.pdf", {
        label: "Write.path",
        intent: "write",
        required: true,
      }),
    /only supports read access/,
  );
  await assert.rejects(
    () =>
      resolver.resolvePath("/Users/me/.liveagent/uploads/1721550000000/report.pdf", {
        label: "Delete.path",
        intent: "delete",
        required: true,
      }),
    /only supports read access/,
  );

  const externalImage = await resolver.resolvePath("/Users/me/Pictures/chart.png", {
    label: "Image.path",
    intent: "image",
    required: true,
    allowExternal: true,
  });
  assert.equal(externalImage.scope, "external");
  assert.equal(externalImage.root, "/Users/me/Pictures/chart.png");
  assert.equal(externalImage.displayPath, "/Users/me/Pictures/chart.png");

  await assert.rejects(
    () =>
      resolver.resolvePath("/Users/me/Pictures/chart.png", {
        label: "Write.path",
        intent: "write",
        required: true,
      }),
    /outside the workspace and enabled Skills/,
  );
});

test("ToolPathResolver teaches the skill:// shape when the skill path is empty", async () => {
  const resolver = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
  });

  await assert.rejects(
    () =>
      resolver.resolvePath("skill://", {
        label: "Write.path",
        intent: "write",
        required: true,
      }),
    /Write\.path must include the skill name and a file path after skill:\/\/.*skill:\/\/<skill-name>\/SKILL\.md/,
  );

  // Listing the skills root (required: false) still resolves.
  const skillsRoot = await resolver.resolvePath("skill://", {
    label: "List.path",
    intent: "read",
    required: false,
  });
  assert.equal(skillsRoot.scope, "skill");
  assert.equal(skillsRoot.relativePath, undefined);
  assert.equal(skillsRoot.root, "/Users/me/.liveagent/skills");
});

test("ToolPathResolver prefers the skill scope when the skills root nests inside the workspace", async () => {
  const resolver = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    skillsRootEnabled: true,
    skillsRootDir: "/workspace/project/.liveagent/skills",
  });

  const nestedSkill = await resolver.resolvePath(
    "/workspace/project/.liveagent/skills/demo/SKILL.md",
    {
      label: "Read.path",
      intent: "read",
      required: true,
    },
  );
  assert.equal(nestedSkill.scope, "skill");
  assert.equal(nestedSkill.relativePath, "demo/SKILL.md");
  assert.equal(nestedSkill.root, "/workspace/project/.liveagent/skills");
  assert.equal(nestedSkill.displayPath, "skill://demo/SKILL.md");

  const workspaceFile = await resolver.resolvePath("/workspace/project/src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(workspaceFile.scope, "workspace");
  assert.equal(workspaceFile.relativePath, "src/App.tsx");
  assert.equal(workspaceFile.root, "/workspace/project");
});

test("ToolPathResolver expands ~ only with an injected home directory", async () => {
  const withHome = new pathUtils.ToolPathResolver({
    workdir: "/Users/me/project",
    homeDir: "/Users/me",
  });
  const expanded = await withHome.resolvePath("~/project/notes/todo.md", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(expanded.scope, "workspace");
  assert.equal(expanded.relativePath, "notes/todo.md");
  assert.equal(expanded.absolutePath, "/Users/me/project/notes/todo.md");

  const withAsyncHome = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    resolveHomeDir: async () => "/Users/me",
  });
  const external = await withAsyncHome.resolvePath("~/notes.md", {
    label: "Image.path",
    intent: "image",
    required: true,
    allowExternal: true,
  });
  assert.equal(external.scope, "external");
  assert.equal(external.absolutePath, "/Users/me/notes.md");
  assert.equal(external.root, "/Users/me/notes.md");
  assert.equal(external.displayPath, "/Users/me/notes.md");

  const withoutHome = new pathUtils.ToolPathResolver({ workdir: "/workspace/project" });
  await assert.rejects(
    () =>
      withoutHome.resolvePath("~/notes.md", {
        label: "Read.path",
        intent: "read",
        required: true,
      }),
    /Cannot resolve ~\/ paths in this session; use a workspace-relative or absolute path instead/,
  );

  const fixedSkills = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
  });
  const skillViaHome = await fixedSkills.resolvePath("~/.liveagent/skills/demo/SKILL.md", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(skillViaHome.scope, "skill");
  assert.equal(skillViaHome.relativePath, "demo/SKILL.md");
  assert.equal(skillViaHome.displayPath, "skill://demo/SKILL.md");
});

test("ToolPathResolver still accepts legacy workspace:/skill: prefixed inputs", async () => {
  const resolver = new pathUtils.ToolPathResolver({
    workdir: "/workspace/project",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
  });

  const workspaceRef = await resolver.resolvePath("workspace:src/App.tsx", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(workspaceRef.scope, "workspace");
  assert.equal(workspaceRef.relativePath, "src/App.tsx");
  assert.equal(workspaceRef.displayPath, "src/App.tsx");
  assert.ok(!("pathRef" in workspaceRef));

  const skillRef = await resolver.resolvePath("skill:demo/SKILL.md", {
    label: "Read.path",
    intent: "read",
    required: true,
  });
  assert.equal(skillRef.scope, "skill");
  assert.equal(skillRef.relativePath, "demo/SKILL.md");
  assert.equal(skillRef.displayPath, "skill://demo/SKILL.md");
  assert.ok(!("pathRef" in skillRef));
});

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
      { name: "liveagent-code-review" },
      { name: "skills-creator" },
    ]).map((skill) => skill.name),
    ["skills-creator", "skills-installer", "a-skill", "liveagent-code-review", "z-skill"],
  );
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("liveagent-code-review"), true);
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("skills-creator"), false);
  assert.equal(skillBuiltinHelpers.isUserSelectableSkillName("workflow-skill"), true);
});

test("Write rejection for external paths echoes the resolved path and a corrected example", async () => {
  const resolver = new pathUtils.ToolPathResolver({ workdir: "/workspace/project" });

  await assert.rejects(
    resolver.resolvePath("/", {
      label: "Write.path",
      intent: "write",
      required: true,
    }),
    (error) => {
      assert.match(error.message, /Write\.path resolves outside the workspace and enabled Skills: \//);
      assert.match(error.message, /path="notes\.md"/);
      assert.match(error.message, /skill:\/\//);
      return true;
    },
  );
});
