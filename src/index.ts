import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsPaths } from "./config.ts";
import { resolveGlyphs } from "./glyphs.ts";
import { SettingsController } from "./settings-controller.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

export default function codeui(pi: ExtensionAPI): void {
  let controller: SettingsController | undefined;

  pi.on("session_start", async (_event, ctx) => {
    controller?.dispose();
    controller = new SettingsController(getSettingsPaths(ctx.cwd), ctx.isProjectTrusted(), ctx.hasUI ? ctx.ui : undefined);
    await controller.start(ctx.mode === "tui");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    controller?.dispose();
    controller = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(SettingsController.statusKey, undefined);
  });

  pi.registerCommand("codeui-doctor", {
    description: "Report pi-codeui settings, glyphs, and terminal appearance ownership",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;

      const paths = getSettingsPaths(ctx.cwd);
      const settings = controller?.current ?? DEFAULT_SETTINGS;
      const glyphs = resolveGlyphs(settings);
      const terminal = process.env.TERM_PROGRAM || process.env.TERM || "unknown";
      ctx.ui.notify([
        `Global config: ${paths.global}`,
        `Project config: ${paths.project} (${ctx.isProjectTrusted() ? "trusted/active" : "untrusted/ignored"})`,
        `Glyph preset: ${glyphs.preset}`,
        `Samples: ${glyphs.icons.brand} ${glyphs.icons.branch} ${glyphs.icons.modified} ${glyphs.icons.added} ${glyphs.icons.untracked}`,
        `Terminal: ${terminal}`,
        "Font family, size, features, and ligatures are managed by the host terminal.",
      ].join("\n"), "info");
    },
  });
}
