import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSettings } from "../src/config.ts";
import { fitGlyph, GLYPH_PRESETS, resolveGlyphs } from "../src/glyphs.ts";
import { SettingsController } from "../src/settings-controller.ts";
import { BORDER_PRESETS, DEFAULT_SETTINGS, DENSITY_PRESETS, normalizeSettings } from "../src/settings.ts";

async function fixture(): Promise<{ root: string; global: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-codeui-"));
  const global = join(root, "agent", "codeui.settings.json");
  const project = join(root, "work", ".pi", "codeui.settings.json");
  await mkdir(join(root, "agent"), { recursive: true });
  await mkdir(join(root, "work", ".pi"), { recursive: true });
  return { root, global, project };
}

async function eventually(check: () => boolean, timeout = 2000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) assert.fail("condition not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("defaults and concrete appearance presets are complete", () => {
  assert.equal(DEFAULT_SETTINGS.appearance.density, "compact");
  assert.equal(DEFAULT_SETTINGS.explorer.overlayWidth, "52%");
  assert.deepEqual(Object.keys(DENSITY_PRESETS), ["compact", "comfortable"]);
  assert.deepEqual(Object.keys(BORDER_PRESETS), ["rounded", "square", "minimal"]);
});

test("normalization ignores unknown keys and inherits invalid values", () => {
  const result = normalizeSettings({
    unknown: true,
    appearance: { density: "tiny", borders: "square", extra: 1 },
    widget: { maxFiles: 999, enabled: false },
    explorer: { overlayWidth: "99%", diffContext: 0 },
    vim: { externalEditor: [] },
  });
  assert.equal(result.settings.appearance.density, DEFAULT_SETTINGS.appearance.density);
  assert.equal(result.settings.appearance.borders, "square");
  assert.equal(result.settings.widget.maxFiles, DEFAULT_SETTINGS.widget.maxFiles);
  assert.equal(result.settings.widget.enabled, false);
  assert.equal(result.settings.explorer.diffContext, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("unknown field")));
  assert.ok(result.warnings.some((warning) => warning.includes("overlayWidth")));
});

test("global settings merge below trusted project settings", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  await writeFile(paths.global, JSON.stringify({ appearance: { density: "comfortable" }, widget: { maxFiles: 8 } }));
  await writeFile(paths.project, JSON.stringify({ widget: { maxFiles: 2 }, git: { showUntracked: false } }));

  const trusted = await loadSettings(paths, true);
  assert.equal(trusted.settings.appearance.density, "comfortable");
  assert.equal(trusted.settings.widget.maxFiles, 2);
  assert.equal(trusted.settings.git.showUntracked, false);

  await writeFile(paths.project, "not json");
  const untrusted = await loadSettings(paths, false);
  assert.equal(untrusted.errors.length, 0);
  assert.equal(untrusted.settings.widget.maxFiles, 8);
});

test("malformed files are unusable while valid layers remain safe", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  await writeFile(paths.global, JSON.stringify({ widget: { maxFiles: 7 } }));
  await writeFile(paths.project, "{");
  const loaded = await loadSettings(paths, true);
  assert.equal(loaded.settings.widget.maxFiles, 7);
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0] ?? "", /malformed JSON/);
});

test("custom overrides and every glyph preset resolve", () => {
  for (const preset of ["nerd", "unicode", "ascii"] as const) {
    const normalized = normalizeSettings({ appearance: { glyphPreset: preset } });
    assert.deepEqual(resolveGlyphs(normalized.settings).icons, GLYPH_PRESETS[preset]);
  }
  const custom = normalizeSettings({ appearance: { glyphPreset: "custom", fallbackGlyphPreset: "ascii", icons: { branch: "BR", brand: "X" } } });
  const resolved = resolveGlyphs(custom.settings);
  assert.equal(resolved.icons.branch, "BR");
  assert.equal(resolved.icons.brand, "X");
  assert.equal(resolved.icons.modified, "M");
  assert.equal(fitGlyph("界x", 2), "界");
  assert.equal(fitGlyph("x", 2), "x ");
});

test("successful live reload clears a stale initial settings status", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  await writeFile(paths.global, "{");
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  let changes = 0;
  const controller = new SettingsController(paths, false, {
    notify: (message) => notifications.push(message),
    setStatus: (_key, value) => statuses.push(value),
  }, 75, () => changes++);

  await controller.start(false);
  assert.match(statuses.at(-1) ?? "", /safe fallbacks/);
  await writeFile(paths.global, JSON.stringify({ widget: { maxFiles: 6 } }));
  assert.equal(await controller.reload(true), true);
  assert.equal(statuses.at(-1), undefined);
  assert.equal(controller.current.widget.maxFiles, 6);
  assert.equal(changes, 1);
  assert.match(notifications.at(-1) ?? "", /settings reloaded/);
  controller.dispose();
});

test("watcher handles atomic replacement, preserves invalid live settings, and stops", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  const notifications: string[] = [];
  const controller = new SettingsController(paths, true, {
    notify: (message) => notifications.push(message),
    setStatus: () => {},
  }, 20);
  t.after(() => controller.dispose());
  await controller.start();

  const replacement = `${paths.global}.tmp`;
  await writeFile(replacement, JSON.stringify({ widget: { maxFiles: 9 } }));
  await rename(replacement, paths.global);
  await eventually(() => controller.current.widget.maxFiles === 9);

  await writeFile(paths.global, "{");
  await eventually(() => notifications.some((message) => message.includes("unchanged")));
  assert.equal(controller.current.widget.maxFiles, 9);

  controller.dispose();
  await writeFile(paths.global, JSON.stringify({ widget: { maxFiles: 3 } }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(controller.current.widget.maxFiles, 9);
});

test("bundled theme contains Pi 0.84 required tokens", async () => {
  const theme = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../themes/codeui-midnight.json", import.meta.url), "utf8")) as { colors: Record<string, unknown> };
  const piSchema = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.json", import.meta.url), "utf8")) as { properties: { colors: { required: string[] } } };
  assert.equal(piSchema.properties.colors.required.length, 51);
  assert.deepEqual(piSchema.properties.colors.required.filter((token) => !(token in theme.colors)), []);
});
