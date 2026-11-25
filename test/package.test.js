import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("the package exposes an executable, so npx has something to run", async () => {
  assert.ok(manifest.bin, "package.json must declare a bin entry");
  const entry = Object.entries(manifest.bin);
  assert.deepEqual(entry.map(([name]) => name), ["agentlist"]);
  const target = entry[0][1];
  assert.equal(target, "src/server.js");

  const source = await readFile(new URL("../" + target, import.meta.url), "utf8");
  assert.match(source.split("\n")[0], /^#!\/usr\/bin\/env node$/, "the bin target needs a node shebang");

  const mode = (await stat(root + target)).mode;
  assert.ok(mode & 0o111, "the bin target must be executable");
});

test("the published tarball carries the app, not the tests", () => {
  assert.deepEqual(manifest.files, ["src", "public", "README.md", "LICENSE"]);
  assert.equal(manifest.private, true, "agentList is distributed through git, not the npm registry");
});
