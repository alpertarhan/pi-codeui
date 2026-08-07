import assert from "node:assert/strict";
import test from "node:test";
import { fuzzySearch, parseSearchQuery, type SearchDocument } from "../src/search.ts";

const documents: SearchDocument<string>[] = [
  { id: "file:settings", kind: "file", title: "src/settings-controller.ts", detail: "modified working", value: "settings" },
  { id: "file:git", kind: "file", title: "src/git-explorer.ts", detail: "staged", value: "git" },
  { id: "activity:test", kind: "activity", title: "Running the test suite", detail: "npm test completed", value: "test" },
  { id: "check:type", kind: "check", title: "src/app.ts:12:5", detail: "TS2322 wrong type", value: "type" },
];

test("search query prefixes select files, activity, and checks", () => {
  assert.deepEqual(parseSearchQuery("f: git"), { kind: "file", text: "git" });
  assert.deepEqual(parseSearchQuery("activity: test"), { kind: "activity", text: "test" });
  assert.deepEqual(parseSearchQuery("checks: TS2322"), { kind: "check", text: "TS2322" });
});

test("fuzzy search ranks exact path matches before subsequences", () => {
  assert.equal(fuzzySearch(documents, "git explorer")[0]?.value, "git");
  assert.equal(fuzzySearch(documents, "settings ctrl")[0]?.value, "settings");
  assert.deepEqual(fuzzySearch(documents, "c: wrong").map((result) => result.value), ["type"]);
  assert.deepEqual(fuzzySearch(documents, "a: test").map((result) => result.value), ["test"]);
  assert.equal(fuzzySearch(documents, "does-not-exist").length, 0);
});

test("empty search preserves useful document order", () => {
  assert.deepEqual(fuzzySearch(documents, "").map((result) => result.value), ["settings", "git", "test", "type"]);
});
