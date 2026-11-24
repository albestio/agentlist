import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../public/markdown.js";

test("content is escaped, so file text can never inject markup", () => {
  const html = renderMarkdown('<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>');
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("headings, lists and paragraphs become structure", () => {
  const html = renderMarkdown("# Title\n\nIntro text.\n\n- one\n- two\n\n1. first\n2. second");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>Intro text\.<\/p>/);
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  assert.match(html, /<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/);
});

test("fenced code keeps its text literally and is not parsed as markdown", () => {
  const html = renderMarkdown("```js\nconst x = 1 < 2; // <b>\n```");
  assert.match(html, /<pre class="md-code"><code class="language-js">/);
  assert.match(html, /const x = 1 &lt; 2; \/\/ &lt;b&gt;/);
  assert.equal(html.includes("<b>"), false);
});

test("inline markup renders and links keep the url visible", () => {
  const html = renderMarkdown("Use `grep` with **bold** and *italic* and [a link](https://example.com).");
  assert.match(html, /<code>grep<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<a href="https:\/\/example\.com"[^>]*>a link<\/a>/);
});

test("a javascript: url is not made clickable", () => {
  const html = renderMarkdown("[click](javascript:alert(1))");
  assert.equal(html.includes("<a href=\"javascript:"), false);
  assert.match(html, /click/);
});

test("html comments are dropped instead of shown as noise", () => {
  const html = renderMarkdown("<!-- gentle-ai:persona -->\n# Rules\n<!--\nmulti\nline\n-->\nBody.");
  assert.equal(html.includes("gentle-ai:persona"), false);
  assert.equal(html.includes("multi"), false);
  assert.match(html, /<h1>Rules<\/h1>/);
  assert.match(html, /<p>Body\.<\/p>/);
});

test("blockquotes and horizontal rules are supported, empty input is safe", () => {
  assert.match(renderMarkdown("> quoted"), /<blockquote>quoted<\/blockquote>/);
  assert.match(renderMarkdown("---"), /<hr>/);
  assert.equal(renderMarkdown("").trim(), "");
  assert.equal(renderMarkdown(undefined).trim(), "");
});

test("a protocol-relative url is not made clickable, a same-origin path still is", () => {
  const html = renderMarkdown("[off-site](//evil.example/p) and [local](/docs/page.md)");
  assert.equal(html.includes('href="//evil.example'), false);
  assert.match(html, /<p>off-site and /, "an unsafe link keeps only its text");
  assert.match(html, /href="\/docs\/page\.md"/);
});
