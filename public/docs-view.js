import { renderMarkdown } from "/markdown.js";

const ECOSYSTEM_LABEL = { pi: "Pi", claude: "Claude" };

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Skills and instruction docs matching the query, grouped for the Docs tab. */
export function filterDocs(report, query) {
  const needle = (query || "").trim().toLowerCase();
  const matches = (entry) => {
    if (!needle) return true;
    return [entry.name, entry.description, entry.path, entry.ecosystem, entry.source]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle);
  };
  const skills = (report?.skills || []).filter(matches);
  const instructions = (report?.instructions || []).filter(matches);
  return { skills, instructions, total: skills.length + instructions.length };
}

export function sourceChips(report, box) {
  box.replaceChildren(node("span", "sources-title", "Sources"));
  const chip = (source, suffix) => {
    const element = node("span", "source-chip " + source.scope + (suffix === "missing" ? " missing" : ""),
      source.label + " · " + suffix);
    element.title = source.dir || source.path;
    box.append(element);
  };
  for (const source of report.skillSources) {
    chip(source, source.count === 0 && !source.dir ? "not present" : String(source.count));
  }
  for (const source of report.docSources) {
    if (!source.found) chip(source, "not found");
  }
}

function previewButton(entry, onOpen) {
  const button = node("button", "preview-button", "Preview");
  button.type = "button";
  button.setAttribute("aria-label", "Preview " + entry.name);
  button.addEventListener("click", () => onOpen(entry));
  return button;
}

function skillRow(entry, onOpen) {
  const row = node("article", "doc-row");
  const head = node("div", "doc-head");
  head.append(node("span", "row-name", entry.name));
  head.append(node("span", "eco-badge " + entry.ecosystem, ECOSYSTEM_LABEL[entry.ecosystem] || entry.ecosystem));
  head.append(node("span", "doc-kind", entry.shape === "skill-dir" ? "SKILL.md" : "flat .md"));
  head.append(node("span", "doc-size", formatBytes(entry.bytes)));
  head.append(previewButton(entry, onOpen));
  row.append(head);
  if (entry.description) row.append(node("p", "doc-desc", entry.description));
  row.append(node("p", "doc-path", entry.path));
  return row;
}

function docRow(entry, onOpen) {
  const row = node("article", "doc-row");
  const head = node("div", "doc-head");
  head.append(node("span", "row-name", entry.name));
  head.append(node("span", "eco-badge " + entry.ecosystem, ECOSYSTEM_LABEL[entry.ecosystem] || entry.ecosystem));
  head.append(node("span", "doc-kind", entry.label || entry.source));
  head.append(node("span", "doc-size", formatBytes(entry.bytes) + " · " + entry.lines + " lines"));
  head.append(previewButton(entry, onOpen));
  row.append(head);
  row.append(node("p", "doc-path", entry.path));
  return row;
}

export function renderDocs(report, query, { listBox, countBox, onOpen }) {
  const { skills, instructions, total } = filterDocs(report, query);
  listBox.replaceChildren();
  if (!report) return;

  const heading = (title, amount) => {
    const box = node("div", "doc-section-head");
    // h2: the section lives under the page h1, so a h3 would skip a level.
    box.append(node("h2", "doc-section-title", title));
    box.append(node("span", "muted", String(amount)));
    return box;
  };

  const skillsSection = node("section", "doc-section");
  skillsSection.append(heading("Skills", skills.length));
  if (skills.length) for (const entry of skills) skillsSection.append(skillRow(entry, onOpen));
  else skillsSection.append(node("p", "muted", report.skills.length
    ? "No skill matches the current search."
    : "No skill was found in the scanned roots."));
  listBox.append(skillsSection);

  const docsSection = node("section", "doc-section");
  docsSection.append(heading("Instruction files", instructions.length));
  if (instructions.length) for (const entry of instructions) docsSection.append(docRow(entry, onOpen));
  else docsSection.append(node("p", "muted", report.instructions.length
    ? "No instruction file matches the current search."
    : "No AGENTS.md or CLAUDE.md was found for this ecosystem and folder."));
  listBox.append(docsSection);

  countBox.textContent = total + " shown · " + (report.skills.length + report.instructions.length) +
    " detected · " + report.skills.length + " skills · " + report.instructions.length + " docs";

  const issueBox = node("div", "doc-issues");
  const info = report.issues.filter((issue) => issue.severity === "info");
  if (info.length) {
    const details = node("details", "issues");
    details.append(node("summary", "", info.length + " skill folders not present"));
    details.append(node("p", "issue-note", "A missing folder is normal: no skill of that kind was installed yet."));
    issueBox.append(details);
  }
  const failures = report.issues.filter((issue) => issue.severity !== "info");
  if (failures.length) {
    const details = node("details", "issues error");
    details.open = true;
    details.append(node("summary", "", failures.length + " skill folders failed to read"));
    const list = node("ul", "issue-list");
    for (const failure of failures) list.append(node("li", "", failure.path + " — " + failure.message));
    details.append(list);
    issueBox.append(details);
  }
  listBox.prepend(issueBox);
}

/**
 * Builds the offcanvas content for one entry: header data plus the rendered,
 * bounded preview. The panel is the only scrollable surface, so no list and
 * document scroll ever nest.
 */
export function buildDocDetail(entry) {
  const shownLines = (entry.preview || "").split("\n").length;
  const title = entry.name;
  const subtitle = (ECOSYSTEM_LABEL[entry.ecosystem] || entry.ecosystem) +
    " · " + (entry.shape === "skill-dir" ? "SKILL.md" : entry.kind === "instructions" || entry.label ? entry.label || entry.source : "flat .md");

  const facts = [
    ["Path", entry.path],
    ["Size", formatBytes(entry.bytes)],
    ["Lines", String(entry.lines)],
    ["Scope", entry.scope],
    ["Source", entry.source],
  ];
  if (entry.model) facts.push(["Model", entry.model]);
  if (entry.description) facts.push(["Description", entry.description]);

  const body = node("div", "md md-drawer");
  body.innerHTML = renderMarkdown(entry.preview);
  if (!entry.preview || !entry.preview.trim()) body.append(node("p", "muted", "(empty)"));

  const note = entry.truncated
    ? "Showing the first " + shownLines + " of " + entry.lines + " lines (" + formatBytes(entry.bytes) + " in total)."
    : undefined;

  // Only offered when there is more to read: the preview is already the whole file otherwise.
  const actions = node("div", "drawer-actions");
  if (entry.truncated) {
    const button = node("button", "read-full", "Read complete doc");
    button.type = "button";
    button.dataset.path = entry.path;
    actions.append(button);
    actions.append(node("span", "muted drawer-actions-hint", formatBytes(entry.bytes) + " total"));
  }

  return { title, subtitle, facts, body, note, actions };
}

export { node };
