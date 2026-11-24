import { isValidEcosystem, readStoredEcosystem, storeEcosystem } from "/storage.js";
import { renderDocs, sourceChips, buildDocDetail, formatBytes } from "/docs-view.js";
import { renderMarkdown } from "/markdown.js";

const params = new URLSearchParams(location.search);
const state = {
  cwd: params.get("cwd") || "",
  q: params.get("q") || "",
  scope: params.get("scope") || "all",
  // A link may pin the ecosystem; otherwise the last explicit choice wins, then pi.
  ecosystem: isValidEcosystem(params.get("ecosystem"))
    ? params.get("ecosystem")
    : readStoredEcosystem(globalThis.localStorage),
  agent: params.get("agent") || "",
  tab: params.get("tab") === "docs" ? "docs" : "agents",
  doc: params.get("doc") || "",
  report: null,
  docReport: null,
  detail: null,
};

const el = (id) => document.getElementById(id);
const sourcesBox = el("sources");
const listBox = el("list");
const detailBox = el("detail");
const countBox = el("count");
const statusBox = el("status");

/**
 * The page has one polite live region. Counts are rewritten on every keystroke,
 * so the settled result is announced after a short pause instead of each change.
 */
let statusTimer = null;
function announce(text) {
  globalThis.clearTimeout(statusTimer);
  statusTimer = globalThis.setTimeout(() => {
    statusTimer = null;
    if (statusBox.textContent !== text) statusBox.textContent = text;
  }, 250);
}

function syncUrl(push = false) {
  const next = new URLSearchParams();
  if (state.cwd) next.set("cwd", state.cwd);
  if (state.q) next.set("q", state.q);
  if (state.scope !== "all") next.set("scope", state.scope);
  if (state.ecosystem !== "pi") next.set("ecosystem", state.ecosystem);
  if (state.agent) next.set("agent", state.agent);
  if (state.tab === "docs") next.set("tab", "docs");
  if (state.doc) next.set("doc", state.doc);
  const url = location.pathname + (next.size ? "?" + next : "");
  history[push ? "pushState" : "replaceState"]({}, "", url);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function apiUrl(path) {
  const query = new URLSearchParams({ ecosystem: state.ecosystem });
  if (state.cwd) query.set("cwd", state.cwd);
  return path + "?" + query;
}

async function getJson(path) {
  const response = await fetch(apiUrl(path));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ")");
  return data;
}

function renderSources() {
  sourcesBox.replaceChildren();
  if (!state.report) return;
  const issues = state.report.issues || [];
  const missing = new Set(issues.filter((issue) => issue.code === "SOURCE_UNAVAILABLE").map((issue) => issue.source));
  const failures = issues.filter((issue) => issue.code !== "SOURCE_UNAVAILABLE");

  sourcesBox.append(node("span", "sources-title", "Sources"));
  for (const source of state.report.sources) {
    const absent = missing.has(source.key);
    const label = source.label + (absent ? " · not present" : " · " + source.count);
    const chip = node("span", "source-chip " + source.scope + (absent ? " missing" : ""), label);
    chip.title = absent ? source.dir + " (folder does not exist)" : source.dir;
    sourcesBox.append(chip);
  }

  if (missing.size) {
    const details = node("details", "issues");
    details.append(node("summary", "", missing.size === 1 ? "1 source folder not present" : missing.size + " source folders not present"));
    details.append(node("p", "issue-note", "A missing folder is normal: it means no agent of that kind was created yet. Nothing is wrong with the ones that do exist."));
    sourcesBox.append(details);
  }

  if (failures.length) {
    const details = node("details", "issues error");
    details.open = true;
    details.append(node("summary", "", failures.length === 1 ? "1 source failed to read" : failures.length + " sources failed to read"));
    const list = node("ul", "issue-list");
    for (const failure of failures) {
      const item = node("li", "");
      item.append(node("code", "", failure.code));
      item.append(document.createTextNode(" " + failure.path));
      list.append(item);
    }
    details.append(list);
    sourcesBox.append(details);
  }

  const parseErrors = state.report.agents.filter((agent) => agent.parseError).length;
  if (parseErrors) {
    const details = node("details", "issues error");
    details.open = true;
    details.append(node("summary", "", parseErrors === 1 ? "1 agent file could not be parsed" : parseErrors + " agent files could not be parsed"));
    const list = node("ul", "issue-list");
    for (const agent of state.report.agents.filter((item) => item.parseError)) {
      const entry = node("li", "");
      entry.append(node("code", "", agent.source));
      entry.append(document.createTextNode(" " + agent.path + " — " + agent.parseError));
      list.append(entry);
    }
    details.append(list);
    sourcesBox.append(details);
  }
}

function matches(agent) {
  if (state.scope !== "all" && agent.scope !== state.scope) return false;
  if (!state.q) return true;
  const haystack = [agent.name, agent.description, agent.model, agent.ecosystem, (agent.tools || []).join(" ")].join(" ").toLowerCase();
  return haystack.includes(state.q.toLowerCase());
}

function renderList() {
  listBox.replaceChildren();
  if (!state.report) return;
  const visible = state.report.agents.filter(matches).sort((a, b) => a.name.localeCompare(b.name));
  countBox.textContent = visible.length + " shown · " + state.report.agents.length + " discovered · " + Object.keys(state.report.effective).length + " effective names";
  announce(countBox.textContent);
  if (!visible.length) {
    const empty = node("li", "empty list-empty");
    empty.append(node("p", "", "No agents match the current filters."));
    const clear = node("button", "ghost", "Clear filters");
    clear.type = "button";
    clear.addEventListener("click", clearFilters);
    empty.append(clear);
    listBox.append(empty);
    return;
  }
  for (const agent of visible) {
    // Structure stays list/li/button: the button keeps its native role, so
    // screen readers announce it as a list item that can be activated.
    const item = node("li", "");
    const row = node("button", "row" + (state.agent === agent.id ? " selected" : ""));
    row.type = "button";
    row.append(node("span", "row-name", agent.name));
    row.append(node("span", "eco-badge " + agent.ecosystem, agent.ecosystem));
    row.append(node("span", "row-scope " + agent.scope, agent.scope));
    row.append(node("span", "row-model", agent.model || "—"));
    row.append(node("span", "row-source", agent.source));
    row.append(node("span", "row-desc", agent.description || agent.parseError || "—"));
    if (agent.shadowedBy) row.append(node("span", "badge", "shadowed"));
    if (agent.parseError) row.append(node("span", "badge error", "parse error"));
    row.addEventListener("click", () => {
      state.agent = agent.id;
      syncUrl(true);
      renderList();
      loadDetail();
    });
    item.append(row);
    listBox.append(item);
  }
}

function renderDetail() {
  detailBox.replaceChildren();
  const agent = state.detail;
  if (!agent) {
    detailBox.append(node("p", "empty", "Select an agent to see its source, frontmatter and instructions."));
    return;
  }
  detailBox.append(node("h2", "", agent.name));
  if (agent.description) detailBox.append(node("p", "description", agent.description));
  const meta = node("dl", "meta");
  for (const [label, value] of [["Ecosystem", agent.ecosystem || "pi"], ["Scope", agent.scope], ["Source", agent.source], ["File", agent.path], ["Model", agent.model || "—"]]) {
    meta.append(node("dt", "", label));
    meta.append(node("dd", "", value));
  }
  detailBox.append(meta);
  if (agent.shadowedBy) detailBox.append(node("p", "warning", "Shadowed by " + agent.shadowedBy));
  if (agent.parseError) detailBox.append(node("p", "warning", agent.parseError));
  detailBox.append(node("h3", "", "Tools"));
  const tools = node("div", "chips");
  if ((agent.tools || []).length) for (const tool of agent.tools) tools.append(node("span", "chip", tool));
  else tools.append(node("span", "muted", "none declared"));
  detailBox.append(tools);
  const extras = Object.entries(agent.frontmatter || {}).filter(([key]) => !["name", "description", "model", "tools"].includes(key));
  if (extras.length) {
    detailBox.append(node("h3", "", "Other frontmatter"));
    const extraBox = node("dl", "meta");
    for (const [key, value] of extras) {
      extraBox.append(node("dt", "", key));
      extraBox.append(node("dd", "", Array.isArray(value) ? value.join(", ") : String(value)));
    }
    detailBox.append(extraBox);
  }
  detailBox.append(node("h3", "", "Instructions"));
  detailBox.append(node("pre", "body", agent.body || "(empty)"));
}

async function loadDetail() {
  if (!state.agent) { state.detail = null; renderDetail(); return; }
  try {
    state.detail = await getJson("/api/agents/" + encodeURIComponent(state.agent));
  } catch (error) {
    state.detail = null;
    detailBox.replaceChildren(node("p", "warning", error.message));
  }
  renderDetail();
}

async function loadReport() {
  try {
    state.report = await getJson("/api/agents");
    sourcesBox.replaceChildren(node("span", "sources-title", "Loading…"));
    renderSources();
    renderList();
    if (state.agent) await loadDetail();
  } catch (error) {
    sourcesBox.replaceChildren(node("span", "warning", error.message));
    listBox.replaceChildren(node("li", "warning", error.message));
    countBox.textContent = "";
    announce("");
  }
}

function clearFilters() {
  state.q = "";
  state.scope = "all";
  state.agent = "";
  el("search").value = "";
  el("scope").value = "all";
  syncUrl();
  renderList();
  renderDetail();
}

el("search").addEventListener("input", (event) => {
  state.q = event.target.value;
  syncUrl();
  renderList();
});
el("scope").addEventListener("change", (event) => {
  state.scope = event.target.value;
  syncUrl();
  renderList();
});
el("ecosystem").addEventListener("change", (event) => {
  state.ecosystem = event.target.value;
  storeEcosystem(globalThis.localStorage, state.ecosystem);
  state.agent = "";
  state.detail = null;
  syncUrl();
  reloadActiveView();
  renderDetail();
});
el("clear").addEventListener("click", clearFilters);
el("cwd-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.cwd = el("cwd").value.trim();
  state.agent = "";
  state.detail = null;
  syncUrl();
  loadReport();
  if (state.tab === "docs") loadDocs();
});
window.addEventListener("popstate", () => {
  const next = new URLSearchParams(location.search);
  state.cwd = next.get("cwd") || "";
  state.q = next.get("q") || "";
  state.scope = next.get("scope") || "all";
  state.ecosystem = isValidEcosystem(next.get("ecosystem"))
    ? next.get("ecosystem")
    : readStoredEcosystem(globalThis.localStorage);
  state.agent = next.get("agent") || "";
  const nextDoc = next.get("doc") || "";
  if (nextDoc !== state.doc) {
    state.doc = nextDoc;
    if (nextDoc) globalThis.setTimeout(() => openDocByPath(nextDoc), 0);
    else closeDrawer();
  }
  el("cwd").value = state.cwd;
  el("doc-search").value = state.q;
  el("search").value = state.q;
  el("scope").value = state.scope;
  el("ecosystem").value = state.ecosystem;
  renderList();
  loadDetail();
});

el("cwd").value = state.cwd;
el("ecosystem").value = state.ecosystem;
el("doc-search").value = state.q;

const docListBox = el("doc-list");
const docCountBox = el("doc-count");

async function loadDocs() {
  try {
    state.docReport = await getJson("/api/docs");
    sourceChips(state.docReport, sourcesBox);
    renderDocResults();
    if (state.doc) openDocByPath(state.doc);
  } catch (error) {
    state.docReport = null;
    docListBox.replaceChildren(node("p", "warning", error.message));
    docCountBox.textContent = "";
    announce("");
  }
}

const TAB_ORDER = ["agents", "docs"];
const tabButtons = { agents: el("tab-agents"), docs: el("tab-docs") };
const tabPanels = { agents: el("view-agents"), docs: el("view-docs") };

function showTab(tab, { push = false } = {}) {
  state.tab = tab === "docs" ? "docs" : "agents";
  for (const key of TAB_ORDER) {
    const selected = key === state.tab;
    tabButtons[key].setAttribute("aria-selected", String(selected));
    // Roving tabindex: only the selected tab is in the tab sequence.
    tabButtons[key].tabIndex = selected ? 0 : -1;
    // An inactive panel stays reachable by find-in-page through until-found,
    // which fires beforematch so the owning tab can be selected first.
    if (selected) tabPanels[key].removeAttribute("hidden");
    else tabPanels[key].setAttribute("hidden", "until-found");
  }
  // A tab switch must refresh its own view: the other tab may have changed the
  // cwd or the ecosystem in the meantime.
  if (state.tab === "docs") loadDocs();
  else loadReport();
  syncUrl(push);
}

for (const key of TAB_ORDER) {
  tabButtons[key].addEventListener("click", () => showTab(key, { push: true }));
  tabPanels[key].addEventListener("beforematch", () => {
    if (state.tab !== key) showTab(key, { push: true });
  });
}

el("tabs").addEventListener("keydown", (event) => {
  const current = TAB_ORDER.indexOf(state.tab);
  let next = null;
  if (event.key === "ArrowRight") next = (current + 1) % TAB_ORDER.length;
  else if (event.key === "ArrowLeft") next = (current - 1 + TAB_ORDER.length) % TAB_ORDER.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = TAB_ORDER.length - 1;
  if (next === null) return;
  event.preventDefault();
  const key = TAB_ORDER[next];
  // Selection follows focus, as the tabs pattern expects.
  showTab(key, { push: true });
  tabButtons[key].focus();
});

showTab(state.tab);

function renderDocResults() {
  renderDocs(state.docReport, state.q, { listBox: docListBox, countBox: docCountBox, onOpen: openDrawer });
  announce(docCountBox.textContent);
}

el("doc-search").addEventListener("input", (event) => {
  state.q = event.target.value;
  el("search").value = state.q;
  syncUrl();
  if (state.docReport) renderDocResults();
  renderList();
});

const drawer = el("drawer");
const drawerTitle = el("drawer-title");
const drawerSubtitle = el("drawer-subtitle");
const drawerMeta = el("drawer-meta");
const drawerBody = el("drawer-body");
const drawerScroll = el("drawer-scroll");
const drawerNote = el("drawer-note");
const drawerActions = el("drawer-actions");

function fillDrawer(entry) {
  const detail = buildDocDetail(entry);
  drawerTitle.textContent = detail.title;
  drawerSubtitle.textContent = detail.subtitle;
  drawerMeta.replaceChildren();
  for (const [label, value] of detail.facts) {
    drawerMeta.append(node("dt", "", label));
    drawerMeta.append(node("dd", "", value));
  }
  drawerBody.replaceChildren(detail.body);
  drawerScroll.scrollTop = 0;
  drawerNote.hidden = detail.note === undefined;
  drawerNote.textContent = detail.note || "";
  drawerActions.replaceChildren(detail.actions);
}

function openDrawer(entry) {
  fillDrawer(entry);
  state.doc = entry.path;
  syncUrl();
  // showModal() puts the panel in the top layer: the page behind is inert, the
  // browser keeps focus inside, and closedby="any" provides Esc and backdrop
  // dismissal. Repeated opens (history navigation) must not call it twice.
  if (!drawer.open) drawer.showModal();
}

function closeDrawer() {
  if (drawer.open) drawer.close();
}

// Every close path — close button, Esc, backdrop, script — ends here, so the
// URL stays in sync and the browser returns focus to the trigger by itself.
drawer.addEventListener("close", () => {
  if (!state.doc) return;
  state.doc = "";
  syncUrl();
});

function openDocByPath(path) {
  const report = state.docReport;
  if (!report || !path) return false;
  const entry = [...report.skills, ...report.instructions].find((item) => item.path === path);
  if (!entry) return false;
  openDrawer(entry);
  return true;
}

el("drawer-close").addEventListener("click", () => closeDrawer());

async function readCompleteDoc(path, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Loading…";
  try {
    const query = new URLSearchParams({ ecosystem: state.ecosystem, path });
    if (state.cwd) query.set("cwd", state.cwd);
    const response = await fetch("/api/doc?" + query);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ")");
    const rendered = node("div", "md md-drawer");
    rendered.innerHTML = renderMarkdown(data.text);
    drawerBody.replaceChildren(rendered);
    drawerNote.hidden = false;
    drawerNote.textContent = "Complete document: " + data.lines + " lines, " + formatBytes(data.bytes) + ".";
    drawerActions.replaceChildren();
    drawerScroll.scrollTop = 0;
  } catch (error) {
    button.disabled = false;
    button.textContent = previous;
    drawerNote.hidden = false;
    drawerNote.textContent = "Could not read the complete document: " + error.message;
  }
}

drawerActions.addEventListener("click", (event) => {
  const button = event.target.closest("button.read-full");
  if (button) readCompleteDoc(button.dataset.path, button);
});
