import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderChromeFooter, renderChromeHeader } from "../src/chrome.ts";
import type { GitExec } from "../src/git/git.ts";
import { GitStateController } from "../src/git-state.ts";
import { cloneSettings, DEFAULT_SETTINGS } from "../src/settings.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const exec: GitExec = async (_command, args) => {
  if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
  if (args[0] === "status") return { stdout: "## feature/ui\0 M src/app.ts\0", stderr: "", code: 0, killed: false };
  return { stdout: "8\t2\tsrc/app.ts\0", stderr: "", code: 0, killed: false };
};

test("global chrome matches the mockup hierarchy and stays width-safe", async () => {
  const git = new GitStateController(exec, "/repo");
  await git.refresh();
  const settings = cloneSettings(DEFAULT_SETTINGS);
  const context = {
    cwd: "/Users/alper/dev/pi/pi-codeui",
    model: "gpt-5.3-codex",
    thinking: "xhigh",
    agentRunning: false,
    usage: {
      session: { input: 904_000, output: 107_000, cacheRead: 18_000_000, cacheWrite: 0, cached: 18_000_000, total: 19_011_000 },
      turnNumber: 7,
      contextTokens: 144_000,
      contextWindow: 272_000,
      contextPercent: 53,
    },
  };

  const header = renderChromeHeader(git.state, settings, theme, context, 120);
  const footer = renderChromeFooter(git.state, settings, theme, context, 120);
  assert.equal(header.length, 2);
  assert.equal(footer.length, 2);
  assert.match(header[0] ?? "", /pi-codeui/);
  assert.match(header[0] ?? "", /feature\/ui/);
  assert.match(header[0] ?? "", /ready/);
  assert.match(footer[1] ?? "", /I904k/);
  assert.match(footer[1] ?? "", /T#7/);
  assert.doesNotMatch(footer[1] ?? "", /T22k|T62k/, "TURN must be an ordinal, not a token count");
  assert.match(footer[1] ?? "", /CTX 144k\/272k 53%/);
  assert.match(footer[1] ?? "", /gpt-5\.3-codex/);
  assert.ok([...header, ...footer].every((line) => visibleWidth(line) === 120));

  for (const width of [24, 40, 80]) {
    assert.ok([...renderChromeHeader(git.state, settings, theme, context, width), ...renderChromeFooter(git.state, settings, theme, context, width)]
      .every((line) => visibleWidth(line) <= width));
  }

  settings.chrome.header = false;
  settings.chrome.footer = false;
  assert.deepEqual(renderChromeHeader(git.state, settings, theme, context, 80), []);
  assert.deepEqual(renderChromeFooter(git.state, settings, theme, context, 80), []);
  git.dispose();
});
