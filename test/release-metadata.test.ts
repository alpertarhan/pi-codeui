import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const json = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("v1 package metadata exposes the canonical Pi package and gallery contract", async () => {
  const pkg = await json("../package.json");
  assert.equal(pkg.name, "pi-codeui");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.repository, { type: "git", url: "git+https://github.com/alpertarhan/pi-codeui.git" });
  assert.equal(pkg.homepage, "https://github.com/alpertarhan/pi-codeui#readme");
  assert.equal(pkg.bugs?.url, "https://github.com/alpertarhan/pi-codeui/issues");
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.match(pkg.pi?.image ?? "", /^https:\/\/raw\.githubusercontent\.com\/alpertarhan\/pi-codeui\//);
  assert.deepEqual(pkg.pi?.extensions, ["./src/index.ts"]);
  assert.deepEqual(pkg.pi?.themes, ["./themes/codeui-midnight.json"]);
  for (const file of ["docs/COMPATIBILITY.md", "docs/MIGRATION-v1.md", "docs/RELEASING.md", "schemas/codeui.settings.schema.json"]) {
    const shipped = pkg.files.some((entry: string) => file === entry || file.startsWith(`${entry}/`));
    assert.ok(shipped, `${file} must ship in the npm package`);
  }
});

test("split compatibility does not import optional pi-tui runtime guards", async () => {
  const splitSource = await readFile(new URL("../src/split-panel.ts", import.meta.url), "utf8");
  assert.doesNotMatch(splitSource, /\bisViewportTUI\b/, "cross-install Pi runtimes may not export the optional helper");
  assert.match(splitSource, /typeof .*setLayoutRoot.*=== "function"/, "viewport detection must use the capability CodeUI actually needs");
});

test("schema and install documentation use the canonical unscoped name", async () => {
  const schema = await json("../schemas/codeui.settings.schema.json");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(schema.$id, "https://unpkg.com/pi-codeui/schemas/codeui.settings.schema.json");
  assert.match(readme, /pi install npm:pi-codeui/);
  assert.match(readme, /git:github\.com\/alpertarhan\/pi-codeui/);
  assert.doesNotMatch(readme, /npm:@pi-codeui\/core/);
});
