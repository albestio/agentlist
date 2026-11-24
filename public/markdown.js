// Absolute http(s) and mailto links, bare fragments, and same-origin paths.
// A path branch that also accepted `//host` would let a document turn a local
// reference into an off-site link.
const SAFE_URL = /^(?:https?:|mailto:|#|\/(?![\/\\]))/i;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline span of a line. Operates on already-escaped text, so no tag can slip in. */
function inline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, (_, code) => "<code>" + code + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, (_, text) => "<strong>" + text + "</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, (_, before, text) => before + "<em>" + text + "</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
      // A file is untrusted text: only a plainly safe scheme becomes a link.
      if (!SAFE_URL.test(href)) return label;
      return '<a href="' + href + '" rel="noreferrer noopener" target="_blank">' + label + "</a>";
    });
}

/**
 * Renders a bounded, trusted-shape subset of Markdown as escaped HTML.
 * Everything from the file is escaped first, so the only markup in the result
 * is the markup computed here. Unknown syntax stays as literal text.
 */
export function renderMarkdown(text) {
  if (!text) return "";
  // Comments are metadata, not content: they would otherwise render as noise.
  const lines = String(text).replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let list = null;
  let paragraph = [];
  let fence = null;

  const closeList = () => {
    if (list) {
      out.push("</" + list + ">");
      list = null;
    }
  };
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push("<p>" + inline(paragraph.map(escapeHtml).join(" ")) + "</p>");
      paragraph = [];
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (fence) {
      if (/^```/.test(line.trim())) {
        out.push("</code></pre>");
        fence = null;
      } else {
        out.push(escapeHtml(raw));
      }
      continue;
    }

    const openFence = /^```(\S*)\s*$/.exec(line.trim());
    if (openFence) {
      flushParagraph();
      closeList();
      const language = openFence[1] ? ' class="language-' + escapeHtml(openFence[1]) + '"' : "";
      out.push('<pre class="md-code"><code' + language + ">");
      fence = language || "plain";
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      out.push("<h" + level + ">" + inline(escapeHtml(heading[2])) + "</h" + level + ">");
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      closeList();
      out.push("<hr>");
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      out.push("<blockquote>" + inline(escapeHtml(quote[1])) + "</blockquote>");
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push("<" + kind + ">");
        list = kind;
      }
      out.push("<li>" + inline(escapeHtml((bullet || ordered)[1])) + "</li>");
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  if (fence) out.push("</code></pre>");
  flushParagraph();
  closeList();
  return out.join("\n");
}
