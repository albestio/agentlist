import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, resolveAgentHome, resolveClaudeHome, ECOSYSTEMS } from "./discover.js";
import { discoverDocs, readFullDoc, resolveAgentsHome, MAX_FULL_DOC_BYTES } from "./docs.js";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/storage.js", ["storage.js", "text/javascript; charset=utf-8"]],
  ["/docs-view.js", ["docs-view.js", "text/javascript; charset=utf-8"]],
  ["/markdown.js", ["markdown.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml; charset=utf-8"]],
]);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

// The UI answers on loopback only unless the operator disabled this check by
// binding a non-loopback address on purpose.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostAllowed(headerValue, allowedHosts) {
  if (allowedHosts === null) return true;
  if (!headerValue) return true;
  let name = headerValue.trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    name = end > 0 ? name.slice(0, end + 1) : name;
  } else {
    const colon = name.lastIndexOf(":");
    if (colon > -1) name = name.slice(0, colon);
  }
  return allowedHosts.has(name);
}

function send(res, status, payload, type = "application/json; charset=utf-8") {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...SECURITY_HEADERS });
  res.end(body);
}

async function validCwd(value, fallback) {
  const path = value ? resolve(value) : fallback;
  try {
    return (await stat(path)).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

function withoutBody(agent) {
  const { body, ...summary } = agent;
  return summary;
}

export function createServer({
  agentHome = resolveAgentHome(),
  agentsHome = resolveAgentsHome(),
  claudeHome = resolveClaudeHome(),
  cwd = process.cwd(),
  allowedHosts = LOOPBACK_HOSTS,
  discover = discoverAgents,
  docs = discoverDocs,
} = {}) {
  // Agent homes are resolved once so a project switch cannot silently re-point the scan.
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
      if (!hostAllowed(req.headers.host, allowedHosts)) {
        return send(res, 403, { error: "Host not allowed: agentList answers on loopback hosts only" });
      }
      const url = new URL(req.url, "http://localhost");
      const targetCwd = await validCwd(url.searchParams.get("cwd"), cwd);
      if (targetCwd === null) return send(res, 400, { error: "Invalid cwd: it must be an existing directory" });

      const ecosystem = url.searchParams.get("ecosystem") || "pi";
      if (!ECOSYSTEMS.includes(ecosystem)) {
        return send(res, 400, { error: "Invalid ecosystem: expected one of " + ECOSYSTEMS.join(", ") });
      }

      if (url.pathname === "/api/doc") {
        const result = await readFullDoc({
          agentHome, agentsHome, claudeHome, cwd: targetCwd, ecosystem, path: url.searchParams.get("path"),
        });
        if (result.status === "missing-path") return send(res, 400, { error: "Missing path: it must name one scanned document" });
        if (result.status === "not-scanned") {
          return send(res, 404, { error: "Not a document found in the scanned roots for this folder and ecosystem" });
        }
        if (result.status === "too-large") {
          return send(res, 413, {
            error: "Document is too large to load (" + result.bytes + " bytes, limit " + MAX_FULL_DOC_BYTES + ")",
            bytes: result.bytes,
          });
        }
        if (result.status === "read-failed") {
          console.error("agentList: reading a document failed:", result.message);
          return send(res, 500, { error: "Could not read the document" });
        }
        return send(res, 200, { path: result.entry.path, bytes: result.bytes, lines: result.lines, text: result.text });
      }

      if (url.pathname === "/api/docs") {
        return send(res, 200, await docs({ agentHome, agentsHome, claudeHome, cwd: targetCwd, ecosystem }));
      }

      if (url.pathname === "/api/agents") {
        const report = await discover({ agentHome, cwd: targetCwd, ecosystem });
        return send(res, 200, {
          ...report,
          agents: report.agents.map(withoutBody),
          effective: Object.fromEntries(Object.entries(report.effective).map(([name, agent]) => [name, withoutBody(agent)])),
        });
      }
      const detail = /^\/api\/agents\/([^/]+)$/.exec(url.pathname);
      if (detail) {
        let name;
        try {
          name = decodeURIComponent(detail[1]);
        } catch {
          return send(res, 400, { error: "Invalid agent name" });
        }
        const report = await discover({ agentHome, cwd: targetCwd, ecosystem });
        const agent = Object.hasOwn(report.effective, name) ? report.effective[name] : undefined;
        return agent ? send(res, 200, agent) : send(res, 404, { error: "Unknown agent" });
      }
      const asset = assets.get(url.pathname);
      if (asset) return send(res, 200, await readFile(join(publicDir, asset[0]), "utf8"), asset[1]);
      return send(res, 404, { error: "Not found" });
    } catch (error) {
      console.error("agentList: request failed:", error);
      return send(res, 500, { error: "Internal error" });
    }
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const initialCwd = process.argv[2] || process.env.AGENTLIST_CWD || process.cwd();
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("agentList: PORT must be an integer between 0 and 65535");
    process.exit(1);
  }
  const loopbackBind = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopbackBind) {
    console.error("agentList: listening on " + host + " exposes local file contents to that network");
  }
  createServer({ cwd: resolve(initialCwd), allowedHosts: loopbackBind ? undefined : null }).listen(port, host, () => {
    console.log("agentList running at http://" + host + ":" + port + "/?cwd=" + encodeURIComponent(resolve(initialCwd)));
  });
}
