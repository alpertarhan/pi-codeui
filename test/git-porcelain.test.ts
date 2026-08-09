import assert from "node:assert/strict";
import test from "node:test";
import { parseBranch, parseNumstat, parseStatus, PorcelainError } from "../src/git/porcelain.ts";

const status = (...records: string[]) => parseStatus(["## main", ...records].join("\0") + "\0");

test("parses all branch header forms", () => {
  assert.deepEqual(parseBranch("## main"), { name: "main", ahead: 0, behind: 0, detached: false, unborn: false, gone: false });
  assert.deepEqual(parseBranch("## feature...origin/feature"), { name: "feature", upstream: "origin/feature", ahead: 0, behind: 0, detached: false, unborn: false, gone: false });
  assert.deepEqual(parseBranch("## main...origin/main [ahead 2]"), { name: "main", upstream: "origin/main", ahead: 2, behind: 0, detached: false, unborn: false, gone: false });
  assert.deepEqual(parseBranch("## main...origin/main [behind 3]"), { name: "main", upstream: "origin/main", ahead: 0, behind: 3, detached: false, unborn: false, gone: false });
  assert.deepEqual(parseBranch("## main...origin/main [ahead 2, behind 3]"), { name: "main", upstream: "origin/main", ahead: 2, behind: 3, detached: false, unborn: false, gone: false });
  assert.equal(parseBranch("## main...origin/main [gone]").gone, true);
  assert.deepEqual(parseBranch("## No commits yet on new"), { name: "new", ahead: 0, behind: 0, detached: false, unborn: true, gone: false });
  assert.deepEqual(parseBranch("## No commits yet on main...origin/main [ahead 1, behind 2]"), { name: "main", upstream: "origin/main", ahead: 1, behind: 2, detached: false, unborn: true, gone: false });
  assert.deepEqual(parseBranch("## No commits yet on main...origin/main [gone]"), { name: "main", upstream: "origin/main", ahead: 0, behind: 0, detached: false, unborn: true, gone: true });
  assert.deepEqual(parseBranch("## HEAD (no branch)"), { name: null, ahead: 0, behind: 0, detached: true, unborn: false, gone: false });
});

test("parses status pairs and derives independent MM counts", () => {
  const parsed = status("M  staged", " M working", "T  type-staged", " T type-working", "A  added", " D deleted", "?? new", "MM both");
  assert.deepEqual(parsed.files.map(({ index, worktree }) => index + worktree), ["M ", " M", "T ", " T", "A ", " D", "??", "MM"]);
  assert.deepEqual(parsed.counts, { staged: 4, unstaged: 4, untracked: 1, conflicted: 0 });
});

test("all seven conflict pairs are a separate bucket", () => {
  const pairs = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];
  const parsed = status(...pairs.map((pair, index) => `${pair} conflict-${index}`));
  assert.deepEqual(parsed.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 7 });
  assert.ok(parsed.files.every((file) => file.conflicted && !file.staged && !file.unstaged));
});

test("rename/copy -z records preserve destination/source order and unusual paths", () => {
  const parsed = status("R  new name", "old name", " C destination\t界\n", "source\tname");
  assert.deepEqual(parsed.files.map(({ path, oldPath }) => [path, oldPath]), [
    ["new name", "old name"],
    ["destination\t界\n", "source\tname"],
  ]);
});

test("clean output works with and without a trailing NUL", () => {
  assert.deepEqual(parseStatus("## main\0").files, []);
  assert.deepEqual(parseStatus("## main").counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
});

test("malformed porcelain and branch metadata fail predictably", () => {
  for (const fixture of ["", "main\0", "## main\0M bad\0", "## main\0R  new\0", "## main\0ZZ bad\0"]) {
    assert.throws(() => parseStatus(fixture), PorcelainError);
  }
  assert.throws(() => parseBranch("## main [ahead nope]"), PorcelainError);
  assert.throws(() => parseBranch("## main...origin/main [unknown]"), PorcelainError);
});

test("numstat totals and per-file stats preserve unusual paths and binary markers", () => {
  const parsed = parseNumstat("2\t3\ta\tname\n界\0-\t-\tbinary.dat\0");
  assert.deepEqual({ files: parsed.files, added: parsed.added, deleted: parsed.deleted, binaryFiles: parsed.binaryFiles }, { files: 2, added: 2, deleted: 3, binaryFiles: 1 });
  assert.deepEqual(parsed.byPath?.get("a\tname\n界"), { added: 2, deleted: 3, binary: false });
  assert.deepEqual(parsed.byPath?.get("binary.dat"), { added: 0, deleted: 0, binary: true });
  assert.throws(() => parseNumstat("bad\0"), PorcelainError);
  assert.throws(() => parseNumstat("1\t2\t\0"), PorcelainError);
});
