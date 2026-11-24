import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "agentlist-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentHome = join(root, "agent-home");
  const cwd = join(root, "project");
  await mkdir(join(agentHome, "agents"), { recursive: true });
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(agentHome, "agents", "scout.md"), "---\nname: scout\ndescription: Explorer\nmodel: model/a\n---\nGlobal body.\n");
  await writeFile(join(cwd, ".pi", "agents", "local.md"), "---\nname: local\ndescription: Local\n---\nLocal body.\n");
  const agentsHome = join(root, "agents-home");
  const claudeHome = join(root, "claude-home");
  const server = createServer({ agentHome, agentsHome, claudeHome, cwd });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, cwd, agentHome, base: "http://127.0.0.1:" + server.address().port };
}

test("GET /api/agents returns scoped sources and effective names", async (t) => {
  const { base, cwd } = await setup(t);
  const response = await fetch(base + "/api/agents?cwd=" + encodeURIComponent(cwd));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.cwd, cwd);
  assert.deepEqual(data.sources.map((s) => s.key), ["globalAgents", "globalSubagents", "projectAgents", "projectSubagents"]);
  assert.deepEqual(Object.keys(data.effective).sort(), ["local", "scout"]);
  assert.ok(data.agents.every((a) => !("body" in a)));
});

test("GET /api/agents/:name returns the full detail", async (t) => {
  const { base, cwd } = await setup(t);
  const response = await fetch(base + "/api/agents/scout?cwd=" + encodeURIComponent(cwd));
  assert.equal(response.status, 200);
  const agent = await response.json();
  assert.equal(agent.name, "scout");
  assert.equal(agent.body, "Global body.");
});

test("invalid cwd is rejected and unknown agents are 404", async (t) => {
  const { base } = await setup(t);
  const bad = await fetch(base + "/api/agents?cwd=" + encodeURIComponent("/definitely/not/a/real/path/agentlist"));
  assert.equal(bad.status, 400);
  const missing = await fetch(base + "/api/agents/nope");
  assert.equal(missing.status, 404);
});

test("the web UI and its assets are served", async (t) => {
  const { base } = await setup(t);
  const page = await fetch(base + "/?cwd=" + encodeURIComponent("/tmp"));
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /Search agents/);
  assert.match(html, /href="\/favicon\.svg"/);
  // The doc preview is a native modal dialog: the platform owns focus, the
  // top layer and backdrop dismissal, so no hand-rolled ARIA is needed.
  assert.match(html, /<dialog[^>]*id="drawer"[^>]*closedby="any"/);
  assert.doesNotMatch(html, /aria-modal/, "a native modal must not claim aria-modal");
  assert.doesNotMatch(html, /role="dialog"/, "a native modal must not carry role=dialog");
  assert.match(html, /id="drawer-close"/);
  // Meta and document share one scroll surface, so the facts scroll away with the text.
  assert.match(html, /class="drawer-scroll"[\s\S]*id="drawer-meta"[\s\S]*id="drawer-body"/);
  assert.equal(html.includes('class="preview"'), false, "no inline preview disclosure is served");
  // The ecosystem selector scopes both tabs, so it must live outside the tab panel.
  assert.ok(
    html.indexOf('id="ecosystem"') > 0 && html.indexOf('id="ecosystem"') < html.indexOf('class="tabs"'),
    "ecosystem selector must sit above the tabs",
  );
  const script = await fetch(base + "/app.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  const storageModule = await fetch(base + "/storage.js");
  assert.equal(storageModule.status, 200);
  assert.match(storageModule.headers.get("content-type"), /javascript/);
  const css = await fetch(base + "/styles.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /css/);
  const icon = await fetch(base + "/favicon.svg");
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type"), /image\/svg\+xml/);
  const svg = await icon.text();
  assert.match(svg, /<svg[\s>]/);
  assert.match(svg, /\u{1F916}/u);
});

test("the ecosystem parameter selects sources and rejects unknown values", async (t) => {
  const { base, cwd, agentHome } = await setup(t);
  await mkdir(join(agentHome, "..", "claude-home", "agents"), { recursive: true });
  const plain = await (await fetch(base + "/api/agents?cwd=" + encodeURIComponent(cwd))).json();
  assert.equal(plain.ecosystem, "pi");
  const claude = await fetch(base + "/api/agents?ecosystem=claude&cwd=" + encodeURIComponent(cwd));
  assert.equal(claude.status, 200);
  const claudeBody = await claude.json();
  assert.equal(claudeBody.ecosystem, "claude");
  assert.deepEqual(claudeBody.sources.map((s) => s.key), ["globalAgents", "projectAgents"]);
  const both = await (await fetch(base + "/api/agents?ecosystem=both&cwd=" + encodeURIComponent(cwd))).json();
  assert.equal(both.ecosystem, "both");
  assert.deepEqual(both.sources.map((s) => s.key), ["globalAgents", "globalSubagents", "projectAgents", "projectSubagents", "globalAgents", "projectAgents"]);
  const bad = await fetch(base + "/api/agents?ecosystem=emacs&cwd=" + encodeURIComponent(cwd));
  assert.equal(bad.status, 400);
});

test("GET /api/docs lists skills and instruction docs with bounded previews", async (t) => {
  const { base, cwd, agentHome } = await setup(t);
  await mkdir(join(agentHome, "skills", "demo"), { recursive: true });
  await writeFile(join(agentHome, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill.\n---\nBody.\n");
  await writeFile(join(agentHome, "AGENTS.md"), "# Global rules\n");
  await writeFile(join(cwd, "CLAUDE.md"), "# Claude\n" + "y".repeat(150000));

  const response = await fetch(base + "/api/docs?cwd=" + encodeURIComponent(cwd));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ecosystem, "pi");
  assert.deepEqual(data.skills.map((s) => s.name), ["demo"]);
  assert.equal(data.skills[0].description, "A demo skill.");
  const docs = data.instructions.map((d) => d.name);
  assert.deepEqual(docs, ["AGENTS.md"]);
  assert.ok(data.docSources.some((s) => s.key === "piProjectInstructions" && s.found === false));

  const claude = await (await fetch(base + "/api/docs?ecosystem=claude&cwd=" + encodeURIComponent(cwd))).json();
  const big = claude.instructions.find((d) => d.name === "CLAUDE.md");
  assert.equal(big.bytes, 150009);
  assert.equal(big.truncated, true);
  assert.ok(big.preview.length <= 1200);
  assert.equal(JSON.stringify(claude).includes("y".repeat(1300)), false, "the full file must never be returned");

  const bad = await fetch(base + "/api/docs?ecosystem=emacs&cwd=" + encodeURIComponent(cwd));
  assert.equal(bad.status, 400);
});

test("GET /api/doc returns the full text only for a scanned document", async (t) => {
  const { base, cwd, agentHome } = await setup(t);
  await mkdir(join(agentHome, "skills", "demo"), { recursive: true });
  const skillPath = join(agentHome, "skills", "demo", "SKILL.md");
  await writeFile(skillPath, "---\nname: demo\ndescription: Demo.\n---\n" + "line\n".repeat(400));
  const outside = join(cwd, "not-a-scanned-doc.md");
  await writeFile(outside, "# secret outside the scan\n");

  const query = "cwd=" + encodeURIComponent(cwd) + "&path=";
  const full = await fetch(base + "/api/doc?" + query + encodeURIComponent(skillPath));
  assert.equal(full.status, 200);
  const body = await full.json();
  assert.equal(body.path, skillPath);
  assert.match(body.text, /line\nline\n/);
  assert.ok(body.text.length > 1200, "the full text is longer than the bounded preview");

  const rejected = await fetch(base + "/api/doc?" + query + encodeURIComponent(outside));
  assert.equal(rejected.status, 404, "a path outside the scanned roots must not be readable");

  const traversal = await fetch(base + "/api/doc?" + query + encodeURIComponent("/etc/hostname"));
  assert.equal(traversal.status, 404);

  const missing = await fetch(base + "/api/doc?cwd=" + encodeURIComponent(cwd));
  assert.equal(missing.status, 400);

  // A flat file at the root of the skill tree: its directory has no SKILL.md, so it is scanned.
  const hugePath = join(agentHome, "skills", "huge.md");
  await writeFile(hugePath, "x".repeat(1_100_000));
  const huge = await fetch(base + "/api/doc?" + query + encodeURIComponent(hugePath));
  assert.equal(huge.status, 413);
});

test("every response carries hardening headers", async (t) => {
  const { base } = await setup(t);
  const response = await fetch(base + "/api/agents");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/);
});

test("a foreign Host header is rejected to stop DNS rebinding", async (t) => {
  const { server, cwd } = await setup(t);
  const port = server.address().port;
  const path = "/api/agents?cwd=" + encodeURIComponent(cwd);
  const foreign = await rawRequest(port, path, { host: "evil.example" });
  assert.equal(foreign.status, 403);
  const loopback = await rawRequest(port, path, { host: "127.0.0.1:" + port });
  assert.equal(loopback.status, 200);
});

test("prototype keys are never served as agents", async (t) => {
  const { base, cwd } = await setup(t);
  for (const name of ["__proto__", "constructor", "toString"]) {
    const response = await fetch(base + "/api/agents/" + name + "?cwd=" + encodeURIComponent(cwd));
    assert.equal(response.status, 404, name + " must not resolve to an inherited property");
  }
});

test("a malformed agent name is rejected without leaking internals", async (t) => {
  const { base, cwd } = await setup(t);
  const response = await fetch(base + "/api/agents/%E0%A4%A?cwd=" + encodeURIComponent(cwd));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "Invalid agent name");
  assert.equal(JSON.stringify(body).includes("URI malformed"), false);
});

function rawRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}
