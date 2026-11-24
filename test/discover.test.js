import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, sourcesFor, parseAgentFile } from "../src/discover.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentlist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentHome = join(root, "agent-home");
  const cwd = join(root, "project");
  const dirs = {
    globalAgents: join(agentHome, "agents"),
    globalSubagents: join(agentHome, "subagents"),
    projectAgents: join(cwd, ".pi", "agents"),
    projectSubagents: join(cwd, ".pi", "subagents"),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  await writeFile(join(dirs.globalAgents, "scout.md"), "---\nname: scout\ndescription: Global explorer\nmodel: model/a\ntools:\n  - read\n  - grep\n---\nBody line.\n");
  await writeFile(join(dirs.globalSubagents, "reviewer.md"), "---\nname: reviewer\ndescription: Reviewer\nmodel: model/b\ntools: read, grep\n---\nReview body.\n");
  await writeFile(join(dirs.projectAgents, "local.md"), "plain body without frontmatter\n");
  await writeFile(join(dirs.projectSubagents, "scout.md"), "---\nname: scout\ndescription: Project override\n---\nOverride body.\n");
  await writeFile(join(dirs.projectSubagents, "broken.md"), "---\nname: broken\nno closing delimiter\n");
  const claudeHome = join(root, "claude-home");
  const claude = { globalAgents: join(claudeHome, "agents"), projectAgents: join(cwd, ".claude", "agents") };
  for (const dir of Object.values(claude)) await mkdir(dir, { recursive: true });
  await writeFile(join(claude.globalAgents, "jd-judge-a.md"), "---\nname: jd-judge-a\ndescription: Claude judge\nmodel: sonnet\ntools: Bash, Read\n---\nClaude body.\n");
  await writeFile(join(claude.projectAgents, "backend-developer.md"), "---\nname: backend-developer\ndescription: DDD backend\nmodel: sonnet\n---\nBackend body.\n");
  await writeFile(join(claude.projectAgents, "scout.md"), "---\nname: scout\ndescription: Claude scout\nmodel: haiku\n---\nClaude scout body.\n");
  return { root, agentHome, claudeHome, cwd, dirs, claude };
}

test("sources are the four documented directories, in precedence order", async (t) => {
  const { agentHome, cwd, dirs } = await fixture(t);
  const sources = sourcesFor({ agentHome, cwd });
  assert.deepEqual(sources.map((s) => s.key), ["globalAgents", "globalSubagents", "projectAgents", "projectSubagents"]);
  assert.deepEqual(sources.map((s) => s.scope), ["global", "global", "project", "project"]);
  assert.deepEqual(sources.map((s) => s.dir), [dirs.globalAgents, dirs.globalSubagents, dirs.projectAgents, dirs.projectSubagents]);
});

test("discovers agents with parsed frontmatter, body and effective winner", async (t) => {
  const { agentHome, cwd } = await fixture(t);
  const report = await discoverAgents({ agentHome, cwd });
  assert.equal(report.agents.length, 5);
  const globalScout = report.agents.find((a) => a.name === "scout" && a.scope === "global");
  assert.deepEqual(globalScout.tools, ["read", "grep"]);
  assert.equal(globalScout.model, "model/a");
  assert.equal(globalScout.body, "Body line.");
  const reviewer = report.agents.find((a) => a.name === "reviewer");
  assert.deepEqual(reviewer.tools, ["read", "grep"]);
  const local = report.agents.find((a) => a.name === "local");
  assert.equal(local.description, "");
  assert.equal(local.body, "plain body without frontmatter");
  assert.equal(report.effective.scout.source, "projectSubagents");
  assert.equal(report.effective.scout.description, "Project override");
  assert.equal(globalScout.shadowedBy, report.effective.scout.path);
});

test("malformed and missing files are reported without aborting discovery", async (t) => {
  const { agentHome, cwd } = await fixture(t);
  const report = await discoverAgents({ agentHome, cwd });
  const broken = report.agents.find((a) => a.name === "broken");
  assert.match(broken.parseError, /frontmatter/i);
  const empty = await discoverAgents({ agentHome: join(agentHome, "missing"), cwd: join(cwd, "missing") });
  assert.deepEqual(empty.agents, []);
  assert.equal(empty.issues.length, 4);
  assert.ok(empty.issues.every((issue) => issue.code === "SOURCE_UNAVAILABLE"));
});

test("parseAgentFile supports quoted values and inline arrays", () => {
  const agent = parseAgentFile("---\nname: \"quoted\"\ndescription: 'A description'\ntools: [read, grep]\n---\ntext", { path: "/x/quoted.md", scope: "global", source: "globalAgents" });
  assert.equal(agent.name, "quoted");
  assert.equal(agent.description, "A description");
  assert.deepEqual(agent.tools, ["read", "grep"]);
  assert.equal(agent.body, "text");
});

test("default ecosystem is pi, so claude roots are ignored", async (t) => {
  const { agentHome, claudeHome, cwd } = await fixture(t);
  const report = await discoverAgents({ agentHome, claudeHome, cwd });
  assert.equal(report.ecosystem, "pi");
  assert.equal(report.agents.length, 5);
  assert.ok(report.agents.every((agent) => agent.ecosystem === "pi"));
  assert.deepEqual(report.sources.map((s) => s.key), ["globalAgents", "globalSubagents", "projectAgents", "projectSubagents"]);
});

test("claude ecosystem scans only the two claude directories", async (t) => {
  const { agentHome, claudeHome, cwd } = await fixture(t);
  const report = await discoverAgents({ agentHome, claudeHome, cwd, ecosystem: "claude" });
  assert.equal(report.ecosystem, "claude");
  assert.deepEqual(report.sources.map((s) => s.key), ["globalAgents", "projectAgents"]);
  assert.deepEqual(report.agents.map((a) => a.name).sort(), ["backend-developer", "jd-judge-a", "scout"]);
  assert.ok(report.agents.every((agent) => agent.ecosystem === "claude"));
  const judge = report.agents.find((a) => a.name === "jd-judge-a");
  assert.equal(judge.model, "sonnet");
  assert.deepEqual(judge.tools, ["Bash", "Read"]);
  assert.equal(report.effective["jd-judge-a"].path, judge.path);
});

test("both ecosystems keep same-name agents apart through the effective id", async (t) => {
  const { agentHome, claudeHome, cwd } = await fixture(t);
  const report = await discoverAgents({ agentHome, claudeHome, cwd, ecosystem: "both" });
  assert.equal(report.ecosystem, "both");
  assert.equal(report.agents.length, 8);
  assert.deepEqual(Object.keys(report.effective).sort(), [
    "claude:backend-developer", "claude:jd-judge-a", "claude:scout",
    "pi:broken", "pi:local", "pi:reviewer", "pi:scout",
  ]);
  assert.equal(report.effective["pi:scout"].description, "Project override");
  assert.equal(report.effective["claude:scout"].model, "haiku");
  assert.equal(report.effective["claude:jd-judge-a"].model, "sonnet");
  assert.ok(report.agents.every((agent) => agent.id.startsWith(agent.ecosystem + ":")));
});
