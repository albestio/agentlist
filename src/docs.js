import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { readBoundedText } from "./scan-file.js";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseAgentFile, resolveAgentHome, resolveClaudeHome } from "./discover.js";

const PREVIEW_MAX_CHARS = 1200;
const PREVIEW_MAX_LINES = 30;
const SKILL_FILE = "SKILL.md";

export function resolveAgentsHome(value = process.env.AGENTS_HOME) {
  return resolve(value || join(homedir(), ".agents"));
}

/** Skill roots per ecosystem. Pi also reads the shared agent skills directory. */
function skillSources(name, roots) {
  if (name === "claude") {
    return [
      { key: "claudeGlobalSkills", label: "Claude · Global skills", scope: "global", dir: join(roots.claudeHome, "skills") },
      { key: "claudeProjectSkills", label: "Claude · Project skills", scope: "project", dir: join(roots.project, ".claude", "skills") },
    ];
  }
  return [
    { key: "piGlobalSkills", label: "Pi · Global skills", scope: "global", dir: join(roots.agentHome, "skills") },
    { key: "sharedSkills", label: "Shared · agents/skills", scope: "global", dir: join(roots.agentsHome, "skills") },
    { key: "piProjectSkills", label: "Pi · Project skills", scope: "project", dir: join(roots.project, ".pi", "skills") },
  ];
}

/** Instruction documents: AGENTS.md belongs to Pi, CLAUDE.md to Claude. */
function docSources(name, roots) {
  if (name === "claude") {
    return [
      { key: "claudeGlobalInstructions", label: "Claude · Global CLAUDE.md", scope: "global", path: join(roots.claudeHome, "CLAUDE.md") },
      { key: "claudeProjectInstructions", label: "Claude · Project CLAUDE.md", scope: "project", path: join(roots.project, "CLAUDE.md") },
    ];
  }
  return [
    { key: "piGlobalInstructions", label: "Pi · Global AGENTS.md", scope: "global", path: join(roots.agentHome, "AGENTS.md") },
    { key: "piProjectInstructions", label: "Pi · Project AGENTS.md", scope: "project", path: join(roots.project, "AGENTS.md") },
  ];
}

function normalize(text) {
  return text.replace(/\r\n?/g, "\n");
}

function stripBody(text) {
  const normalized = normalize(text);
  if (!normalized.startsWith("---")) return normalized;
  const closing = normalized.indexOf("\n---", 3);
  return closing === -1 ? normalized : normalized.slice(closing + 4);
}

/** A bounded preview, never the whole file: a 91 KB global doc must not be dumped. */
function boundedPreview(text) {
  const normalized = normalize(text);
  const lines = normalized.split("\n");
  const head = lines.slice(0, PREVIEW_MAX_LINES).join("\n").slice(0, PREVIEW_MAX_CHARS);
  return { preview: head, truncated: head.length < normalized.length, lines: lines.length };
}

async function readableFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readSkillEntry(path, source, ecosystem, issues, fallbackName, shape) {
  try {
    const { text, bytes, complete } = await readBoundedText(path);
    const parsed = parseAgentFile(text, { path, scope: source.scope, source: source.key });
    const declared = parsed.name && parsed.name.toLowerCase() !== SKILL_FILE.replace(".md", "").toLowerCase()
      ? parsed.name
      : fallbackName;
    const bounded = boundedPreview(stripBody(text));
    return {
      name: declared || fallbackName,
      description: parsed.description,
      path,
      dir: dirname(path),
      scope: source.scope,
      ecosystem,
      source: source.key,
      shape,
      bytes,
      lines: bounded.lines,
      preview: bounded.preview,
      truncated: !complete || bounded.truncated,
    };
  } catch (error) {
    issues.push({ code: "READ_FAILED", severity: "warning", source: source.key, path, message: error.message });
    return undefined;
  }
}

/**
 * Walks a skill root. A directory holding SKILL.md is one skill and is not
 * descended into, so `references/*.md` are never listed as skills. Any other
 * `.md` directly inside a plain directory is a flat skill. Symlinked skill
 * directories are followed (Pi links its skills this way) with a visited set,
 * which also stops symlink loops.
 */
async function scanSkillDir(dir, source, ecosystem, issues, visited) {
  const skillPath = join(dir, SKILL_FILE);
  if (await readableFile(skillPath)) {
    const entry = await readSkillEntry(skillPath, source, ecosystem, issues, basename(dir), "skill-dir");
    return entry ? [entry] : [];
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    issues.push({ code: "SOURCE_UNAVAILABLE", severity: "info", source: source.key, path: dir, message: error.message });
    return [];
  }

  const skills = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      let real;
      try {
        if (!(await stat(path)).isDirectory()) continue;
        real = await realpath(path);
      } catch {
        continue;
      }
      if (visited.has(real)) continue;
      visited.add(real);
      skills.push(...(await scanSkillDir(path, source, ecosystem, issues, visited)));
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    if (entry.name.toLowerCase() === SKILL_FILE.toLowerCase()) continue;
    const skill = await readSkillEntry(path, source, ecosystem, issues, basename(entry.name, ".md"), "flat");
    if (skill) skills.push(skill);
  }
  return skills;
}

async function readInstructionDoc(source, ecosystem, issues) {
  try {
    const info = await stat(source.path);
    if (!info.isFile()) return undefined;
    const { text, bytes, complete } = await readBoundedText(source.path);
    const bounded = boundedPreview(text);
    return {
      name: basename(source.path),
      label: source.label,
      path: source.path,
      scope: source.scope,
      ecosystem,
      source: source.key,
      bytes,
      lines: bounded.lines,
      preview: bounded.preview,
      truncated: !complete || bounded.truncated,
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      issues.push({ code: "READ_FAILED", severity: "warning", source: source.key, path: source.path, message: error.message });
    }
    return undefined;
  }
}

export async function discoverDocs({
  agentHome = resolveAgentHome(),
  agentsHome = resolveAgentsHome(),
  claudeHome = resolveClaudeHome(),
  cwd = process.cwd(),
  ecosystem = "pi",
} = {}) {
  if (!["pi", "claude", "both"].includes(ecosystem)) throw new Error(`Unknown ecosystem: ${ecosystem}`);
  const roots = { agentHome, agentsHome, claudeHome, project: resolve(cwd) };
  const names = ecosystem === "both" ? ["pi", "claude"] : [ecosystem];

  const skills = [];
  const instructions = [];
  const issues = [];
  const skillSourceReport = [];
  const docSourceReport = [];

  for (const name of names) {
    for (const source of skillSources(name, roots)) {
      const visited = new Set();
      try {
        visited.add(await realpath(source.dir));
      } catch {
        /* the source is missing; scanSkillDir reports it */
      }
      const found = await scanSkillDir(source.dir, source, name, issues, visited);
      skills.push(...found);
      skillSourceReport.push({ ...source, ecosystem: name, count: found.length });
    }
    for (const source of docSources(name, roots)) {
      const doc = await readInstructionDoc(source, name, issues);
      if (doc) instructions.push(doc);
      docSourceReport.push({ ...source, ecosystem: name, found: doc !== undefined });
    }
  }

  return {
    cwd: roots.project,
    ecosystem,
    skillSources: skillSourceReport,
    docSources: docSourceReport,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    instructions: instructions.sort((a, b) => a.name.localeCompare(b.name)),
    issues,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Full text of one document, read on demand.
 *
 * The path is never trusted on its own: it must be a document the current scan
 * already discovered, so the endpoint cannot be used to read arbitrary files.
 */
export const MAX_FULL_DOC_BYTES = 1_000_000;

export async function readFullDoc({
  agentHome = resolveAgentHome(),
  agentsHome = resolveAgentsHome(),
  claudeHome = resolveClaudeHome(),
  cwd = process.cwd(),
  ecosystem = "pi",
  path,
} = {}) {
  if (typeof path !== "string" || !path) return { status: "missing-path" };
  const report = await discoverDocs({ agentHome, agentsHome, claudeHome, cwd, ecosystem });
  const entry = [...report.skills, ...report.instructions].find((item) => item.path === resolve(path));
  if (!entry) return { status: "not-scanned" };
  if (entry.bytes > MAX_FULL_DOC_BYTES) return { status: "too-large", bytes: entry.bytes };
  try {
    const text = await readFile(entry.path, "utf8");
    return { status: "ok", entry, text, bytes: Buffer.byteLength(text), lines: text.split("\n").length };
  } catch (error) {
    return { status: "read-failed", message: error.message };
  }
}
