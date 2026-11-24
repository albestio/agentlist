import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDocs } from "../src/docs.js";

const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentlist-docs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentHome = join(root, "agent-home");
  const agentsHome = join(root, "agents-home");
  const claudeHome = join(root, "claude-home");
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });

  // Pi global skills: a real skill dir plus a symlinked one (as on this machine)
  await mkdir(join(agentHome, "skills", "omarchy"), { recursive: true });
  await writeFile(join(agentHome, "skills", "omarchy", "SKILL.md"), skill("omarchy", "Desktop customization."));
  await writeFile(join(agentHome, "skills", "omarchy", "reference.md"), "# nested reference, not a skill\n");
  const linkedTarget = join(root, "outside", "linked-skill");
  await mkdir(linkedTarget, { recursive: true });
  await writeFile(join(linkedTarget, "SKILL.md"), skill("linked-skill", "Reached through a symlink."));
  await symlink(linkedTarget, join(agentHome, "skills", "linked"));

  // Shared skill root: both shapes coexist
  await mkdir(join(agentsHome, "skills", "branch-pr"), { recursive: true });
  await writeFile(join(agentsHome, "skills", "branch-pr", "SKILL.md"), skill("branch-pr", "Open pull requests."));
  await mkdir(join(agentsHome, "skills", "lifeos"), { recursive: true });
  await writeFile(join(agentsHome, "skills", "lifeos", "life-manager.md"), skill("life-manager", "GTD workflows."));

  // Claude skills
  await mkdir(join(claudeHome, "skills", "go-testing"), { recursive: true });
  await writeFile(join(claudeHome, "skills", "go-testing", "SKILL.md"), skill("go-testing", "Go test patterns."));

  // Instruction files: a big global one and two project ones
  await writeFile(join(agentHome, "AGENTS.md"), "# Pi rules\n\nBe brief.\n");
  await writeFile(join(claudeHome, "CLAUDE.md"), "# Claude rules\n" + "x".repeat(200_000));
  await writeFile(join(cwd, "AGENTS.md"), "# Project A\n");
  await writeFile(join(cwd, "CLAUDE.md"), "# Project C\n");

  return { root, agentHome, agentsHome, claudeHome, cwd };
}

test("skills are found in both shapes and nested references are not listed", async (t) => {
  const roots = await fixture(t);
  const report = await discoverDocs(roots);
  const names = report.skills.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["branch-pr", "life-manager", "linked-skill", "omarchy"]);
  const omarchy = report.skills.find((entry) => entry.name === "omarchy");
  assert.equal(omarchy.shape, "skill-dir");
  assert.equal(omarchy.description, "Desktop customization.");
  assert.equal(omarchy.ecosystem, "pi");
  assert.equal(typeof omarchy.truncated, "boolean");
  assert.ok(omarchy.lines >= 2);
  const flat = report.skills.find((entry) => entry.name === "life-manager");
  assert.equal(flat.shape, "flat");
  assert.equal(flat.source, "sharedSkills");
});

test("a symlinked skill directory is followed exactly once", async (t) => {
  const roots = await fixture(t);
  const report = await discoverDocs(roots);
  const linked = report.skills.find((entry) => entry.name === "linked-skill");
  assert.ok(linked, "expected the symlinked skill to be discovered");
  // Reported through the path it was discovered at, not the link target.
  assert.equal(linked.path, join(roots.agentHome, "skills", "linked", "SKILL.md"));
});

test("instruction files report size, path and a bounded preview", async (t) => {
  const roots = await fixture(t);
  const pi = await discoverDocs(roots);
  assert.equal(pi.instructions.length, 2, "claude docs stay out of the pi scan");
  const small = pi.instructions.find((entry) => entry.path === join(roots.agentHome, "AGENTS.md"));
  assert.equal(small.ecosystem, "pi");
  assert.equal(small.truncated, false);
  assert.match(small.preview, /# Pi rules/);

  const claude = await discoverDocs({ ...roots, ecosystem: "claude" });
  const big = claude.instructions.find((entry) => entry.path === join(roots.claudeHome, "CLAUDE.md"));
  assert.equal(big.bytes, 200_015);
  assert.equal(big.truncated, true);
  assert.ok(big.preview.length <= 1200, "preview must stay bounded");
  assert.equal(big.lines, 2);
});

test("the claude ecosystem scans only claude skill and doc roots", async (t) => {
  const roots = await fixture(t);
  const report = await discoverDocs({ ...roots, ecosystem: "claude" });
  assert.deepEqual(report.skills.map((entry) => entry.name), ["go-testing"]);
  assert.ok(report.skills.every((entry) => entry.ecosystem === "claude"));
  assert.deepEqual(report.instructions.map((entry) => entry.path).sort(), [
    join(roots.claudeHome, "CLAUDE.md"),
    join(roots.cwd, "CLAUDE.md"),
  ].sort());
});

test("both ecosystems scan everything and missing roots become issues", async (t) => {
  const roots = await fixture(t);
  const both = await discoverDocs({ ...roots, ecosystem: "both" });
  assert.equal(both.skills.length, 5);
  assert.deepEqual([...new Set(both.skills.map((entry) => entry.ecosystem))].sort(), ["claude", "pi"]);
  const empty = await discoverDocs({
    agentHome: join(roots.root, "nope"),
    agentsHome: join(roots.root, "nope2"),
    claudeHome: join(roots.root, "nope3"),
    cwd: join(roots.root, "nope4"),
  });
  assert.deepEqual(empty.skills, []);
  assert.deepEqual(empty.instructions, []);
  assert.equal(empty.issues.length, 3, "one issue per missing skill root");
  assert.ok(empty.issues.every((issue) => issue.severity === "info"));
  assert.ok(empty.docSources.every((source) => source.found === false), "a missing doc is reported, not an issue");
});

test("an oversized file is scanned from a bounded head instead of being read whole", async (t) => {
  const roots = await fixture(t);
  const hugeSkill = join(roots.agentHome, "skills", "huge", "SKILL.md");
  await mkdir(join(roots.agentHome, "skills", "huge"), { recursive: true });
  await writeFile(hugeSkill, skill("huge", "Too big to read whole.") + "z".repeat(1_100_000));
  await writeFile(join(roots.claudeHome, "CLAUDE.md"), "# huge\n" + "x".repeat(1_100_000));

  const report = await discoverDocs({ ...roots, ecosystem: "both" });
  const huge = report.skills.find((entry) => entry.name === "huge");
  assert.ok(huge, "the oversized skill is still listed");
  assert.equal(huge.bytes, 1_100_000 + skill("huge", "Too big to read whole.").length);
  assert.equal(huge.truncated, true);
  assert.ok(huge.preview.length <= 1200, "the preview stays bounded");
  assert.equal(JSON.stringify(report).includes("z".repeat(1300)), false, "no full file body reaches the payload");

  const doc = report.instructions.find((entry) => entry.name === "CLAUDE.md");
  assert.equal(doc.bytes, 1_100_007);
  assert.equal(doc.truncated, true);
  assert.ok(doc.preview.length <= 1200);
});
