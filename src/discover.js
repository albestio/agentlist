import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { readBoundedText } from "./scan-file.js";

const LIST_KEYS = new Set(["tools", "allowed_tools", "skills", "tags"]);

export const ECOSYSTEMS = ["pi", "claude", "both"];

export function resolveAgentHome(value = process.env.PI_CODING_AGENT_DIR) {
  return resolve(value || join(homedir(), ".pi", "agent"));
}

export function resolveClaudeHome(value = process.env.CLAUDE_CONFIG_DIR) {
  return resolve(value || join(homedir(), ".claude"));
}

function sourcesOf(ecosystem, { agentHome, claudeHome, project }) {
  if (ecosystem === "claude") {
    return [
      { key: "globalAgents", label: "Claude · Global · agents", scope: "global", dir: join(claudeHome, "agents") },
      { key: "projectAgents", label: "Claude · Project · .claude/agents", scope: "project", dir: join(project, ".claude", "agents") },
    ];
  }
  return [
    { key: "globalAgents", label: "Pi · Global · agents", scope: "global", dir: join(agentHome, "agents") },
    { key: "globalSubagents", label: "Pi · Global · subagents", scope: "global", dir: join(agentHome, "subagents") },
    { key: "projectAgents", label: "Pi · Project · .pi/agents", scope: "project", dir: join(project, ".pi", "agents") },
    { key: "projectSubagents", label: "Pi · Project · .pi/subagents", scope: "project", dir: join(project, ".pi", "subagents") },
  ];
}

export function sourcesFor({
  agentHome = resolveAgentHome(),
  claudeHome = resolveClaudeHome(),
  cwd = process.cwd(),
  ecosystem = "pi",
} = {}) {
  const roots = { agentHome, claudeHome, project: resolve(cwd) };
  const names = ecosystem === "both" ? ["pi", "claude"] : [ecosystem];
  return names.flatMap((name) => sourcesOf(name, roots).map((source) => ({ ...source, ecosystem: name })));
}

function stripQuotes(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function parseList(value) {
  return value.split(",").map(stripQuotes).filter(Boolean);
}

function asText(value) {
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined || value === null ? "" : String(value);
}

export function parseAgentFile(text, { path, scope, source }) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const fromPath = basename(path).replace(/\.md$/i, "");
  const empty = { description: "", model: "", tools: [], frontmatter: {}, body: "" };

  if (lines[0]?.trim() !== "---") {
    return { ...empty, name: fromPath, body: normalized.trim(), path, scope, source };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) {
    return { ...empty, name: fromPath, path, scope, source, parseError: "Unclosed frontmatter: no closing --- delimiter" };
  }

  const frontmatter = {};
  let listKey = null;
  for (const rawLine of lines.slice(1, closing)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const item = /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      frontmatter[listKey].push(stripQuotes(item[1]));
      continue;
    }
    const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    const [, key, raw] = field;
    if (raw.trim() === "") {
      frontmatter[key] = [];
      listKey = key;
    } else {
      const value = stripQuotes(raw);
      frontmatter[key] = LIST_KEYS.has(key.toLowerCase()) && value.startsWith("[") && value.endsWith("]")
        ? parseList(value.slice(1, -1))
        : LIST_KEYS.has(key.toLowerCase()) ? parseList(value) : value;
      listKey = null;
    }
  }

  const tools = frontmatter.tools === undefined
    ? []
    : Array.isArray(frontmatter.tools) ? frontmatter.tools : parseList(frontmatter.tools);
  return {
    name: asText(frontmatter.name) || fromPath,
    description: asText(frontmatter.description),
    model: asText(frontmatter.model),
    tools,
    frontmatter,
    body: lines.slice(closing + 1).join("\n").trim(),
    path,
    scope,
    source,
  };
}

export async function discoverAgents({
  agentHome = resolveAgentHome(),
  claudeHome = resolveClaudeHome(),
  cwd = process.cwd(),
  ecosystem = "pi",
} = {}) {
  if (!ECOSYSTEMS.includes(ecosystem)) throw new Error(`Unknown ecosystem: ${ecosystem}`);
  const sources = sourcesFor({ agentHome, claudeHome, cwd, ecosystem });
  const agents = [];
  const issues = [];

  for (const source of sources) {
    let entries;
    try {
      entries = await readdir(source.dir, { withFileTypes: true });
    } catch (error) {
      issues.push({ code: "SOURCE_UNAVAILABLE", source: source.key, path: source.dir, message: error.message });
      continue;
    }
    for (const entry of entries.filter((item) => item.isFile() && /\.md$/i.test(item.name))) {
      const path = join(source.dir, entry.name);
      try {
        agents.push({
          ...parseAgentFile((await readBoundedText(path)).text, { path, scope: source.scope, source: source.key }),
          ecosystem: source.ecosystem,
        });
      } catch (error) {
        issues.push({ code: "READ_FAILED", source: source.key, path, message: error.message });
      }
    }
  }

  // A null prototype keeps an agent literally named `__proto__` from mutating
  // the map instead of adding an entry.
  const effective = Object.create(null);
  for (const agent of agents) {
    // A name is only unique inside one ecosystem: with both selected, the same
    // agent name exists in each, so the effective id carries the ecosystem.
    agent.id = ecosystem === "both" ? `${agent.ecosystem}:${agent.name}` : agent.name;
    const previous = effective[agent.id];
    if (previous) previous.shadowedBy = agent.path;
    effective[agent.id] = agent;
  }
  return {
    cwd: resolve(cwd),
    agentHome: resolve(agentHome),
    claudeHome: resolve(claudeHome),
    ecosystem,
    sources: sources.map((source) => ({
      ...source,
      count: agents.filter((agent) => agent.source === source.key && agent.ecosystem === source.ecosystem).length,
    })),
    agents,
    effective,
    issues,
    generatedAt: new Date().toISOString(),
  };
}
