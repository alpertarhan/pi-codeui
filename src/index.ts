import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function codeui(pi: ExtensionAPI): void {
  pi.registerCommand("codeui-doctor", {
    description: "Report pi-codeui scaffold and terminal appearance ownership",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;

      ctx.ui.notify(
        "pi-codeui M0 scaffold loaded. Fonts and ligatures are managed by the host terminal.",
        "info",
      );
    },
  });
}
