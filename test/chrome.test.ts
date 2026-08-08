import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderChromeFooter, renderChromeHeader, renderModelStatus, renderUsageMetrics } from "../src/chrome.ts";
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
  assert.match(header[0] ?? "", /PROJECT  repo/);
  assert.doesNotMatch(header[0] ?? "", /PROJECT  pi-codeui/, "the global chrome must identify the repository, not advertise the extension");
  assert.match(header[0] ?? "", /feature\/ui/);
  assert.match(header[0] ?? "", /1 changed  \+16 -4/);
  assert.match(header[0] ?? "", /READY/);
  assert.match(footer[1] ?? "", /PATH  ~\/dev\/pi\/pi-codeui/);
  assert.match(footer[1] ?? "", /IN 904k/);
  assert.match(footer[1] ?? "", /#7/);
  assert.doesNotMatch(footer[1] ?? "", /#22k|#62k/, "TURN must be an ordinal, not a token count");
  assert.match(footer[1] ?? "", /CTX 53%/);
  assert.match(footer[1] ?? "", /GPT-5\.3-CODEX/);
  assert.ok([...header, ...footer].every((line) => visibleWidth(line) === 120));

  const wideFooter = renderChromeFooter(git.state, settings, theme, context, 200);
  assert.match(wideFooter[1] ?? "", /TOKENS  904k in  107k out/);
  assert.match(wideFooter[1] ?? "", /TURN  7/);
  assert.match(wideFooter[1] ?? "", /CONTEXT  144k\/272k 53%/);
  assert.match(wideFooter[1] ?? "", /MODEL  GPT-5\.3-CODEX   THINK  X-HIGH/);
  assert.doesNotMatch(wideFooter[1] ?? "", /CACHE|TOTAL/, "redundant accounting must not dominate the primary status bar");

  const semanticTheme = {
    fg: (token: string, text: string) => `[${token}]${text}`,
    bg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  assert.match(renderModelStatus("gpt-5.6-sol", "xhigh", semanticTheme, false), /\[thinkingHigh\]X-HIGH/);
  assert.doesNotMatch(renderModelStatus("gpt-5.6-sol", "xhigh", semanticTheme, false), /thinkingXhigh|\[error\]/, "reasoning modes must not look like failures");
  const semanticFooter = renderChromeFooter(git.state, settings, semanticTheme, context, 240).join("\n");
  assert.match(semanticFooter, /\[muted\]~\/dev\/pi\/\[text\]pi-codeui/, "the active directory must be stronger than its parent path");

  settings.chrome.header = false;
  settings.chrome.footer = false;
  assert.deepEqual(renderChromeHeader(git.state, settings, theme, context, 80), []);
  assert.deepEqual(renderChromeFooter(git.state, settings, theme, context, 80), []);
  git.dispose();
});

test("chrome render matrix is width-safe and preserves textual state across glyph presets", async () => {
  const git = new GitStateController(exec, "/repo");
  await git.refresh();
  const context = {
    cwd: "/Users/alper/dev/pi/pi-codeui",
    model: "gpt-5.3-codex",
    thinking: "high",
    agentRunning: true,
    usage: {
      session: { input: 904_000, output: 107_000, cacheRead: 0, cacheWrite: 0, cached: 0, total: 1_011_000 },
      turnNumber: 7,
      contextTokens: 250_000,
      contextWindow: 272_000,
      contextPercent: 92,
    },
  };
  const widths = [1, 2, 3, 4, 12, 24, 40, 79, 80, 89, 90, 100, 140, 159, 160, 200, 220];

  for (const glyphPreset of ["nerd", "unicode", "ascii"] as const) {
    const settings = cloneSettings(DEFAULT_SETTINGS);
    settings.appearance.glyphPreset = glyphPreset;
    for (const width of widths) {
      const lines = [...renderChromeHeader(git.state, settings, theme, context, width), ...renderChromeFooter(git.state, settings, theme, context, width)];
      assert.equal(lines.length, 4, `${glyphPreset} chrome geometry changed at ${width} columns`);
      assert.ok(lines.every((line) => visibleWidth(line) === width), `${glyphPreset} chrome exceeded ${width} columns`);
    }
  }

  const settings = cloneSettings(DEFAULT_SETTINGS);
  const errorHeader = renderChromeHeader({ kind: "error", message: "failed" }, settings, theme, context, 100).join("\n");
  assert.match(errorHeader, /git error/);
  assert.match(errorHeader, /WORKING/);
  assert.match(renderUsageMetrics(context.usage, theme, true), /CTX 92%/, "critical context must be textually identifiable without color");
  git.dispose();
});
