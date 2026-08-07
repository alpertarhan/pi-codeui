import { unwatchFile, watch, watchFile, type FSWatcher, type Stats } from "node:fs";
import { basename, dirname } from "node:path";
import { loadSettings, type SettingsPaths } from "./config.ts";
import { cloneSettings, DEFAULT_SETTINGS, type CodeuiSettings } from "./settings.ts";

export interface SettingsControllerUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

export class SettingsController {
  static readonly statusKey = "pi-codeui.settings";
  private watchers: FSWatcher[] = [];
  private fallbackWatchers: Array<{ path: string; listener: (current: Stats, previous: Stats) => void }> = [];
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private hasLoaded = false;
  private settingsValue = cloneSettings(DEFAULT_SETTINGS);
  readonly paths: SettingsPaths;
  private readonly projectTrusted: boolean;
  private readonly ui: SettingsControllerUI | undefined;
  private readonly debounceMs: number;
  private readonly onChange: (() => void) | undefined;

  constructor(paths: SettingsPaths, projectTrusted: boolean, ui?: SettingsControllerUI, debounceMs = 75, onChange?: () => void) {
    this.paths = paths;
    this.projectTrusted = projectTrusted;
    this.ui = ui;
    this.debounceMs = debounceMs;
    this.onChange = onChange;
  }

  get current(): Readonly<CodeuiSettings> {
    return this.settingsValue;
  }

  async start(enableWatch = true): Promise<void> {
    this.disposed = false;
    await this.reload(false);
    if (!enableWatch || this.disposed) return;
    const configPaths = [this.paths.global, ...(this.projectTrusted ? [this.paths.project] : [])];
    const pathsByDirectory = new Map<string, string[]>();
    for (const path of configPaths) {
      const directory = dirname(path);
      pathsByDirectory.set(directory, [...(pathsByDirectory.get(directory) ?? []), path]);
    }
    for (const [directory, paths] of pathsByDirectory) {
      try {
        this.watchers.push(watch(directory, (_event, filename) => {
          if (filename && !paths.some((path) => filename.toString().startsWith(basename(path)))) return;
          this.scheduleReload();
        }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          for (const path of paths) {
            const listener = (current: Stats, previous: Stats): void => {
              if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size || current.nlink !== previous.nlink) {
                this.scheduleReload();
              }
            };
            watchFile(path, { interval: 500, persistent: false }, listener);
            this.fallbackWatchers.push({ path, listener });
          }
          continue;
        }
        this.ui?.notify(`pi-codeui cannot watch ${directory}: ${(error as Error).message}`, "warning");
      }
    }
  }

  private scheduleReload(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reload(true), this.debounceMs);
  }

  async reload(live = true): Promise<boolean> {
    const loaded = await loadSettings(this.paths, this.projectTrusted);
    if (this.disposed) return false;
    if (loaded.errors.length > 0) {
      const initial = !this.hasLoaded;
      if (initial) {
        this.settingsValue = loaded.settings;
        this.hasLoaded = true;
      }
      const message = `pi-codeui settings ${initial ? "loaded with safe fallbacks" : "unchanged"}: ${loaded.errors.join("; ")}`;
      if (live) this.ui?.notify(message, "warning");
      else this.ui?.setStatus(SettingsController.statusKey, message);
      return false;
    }
    this.settingsValue = loaded.settings;
    this.hasLoaded = true;
    this.onChange?.();
    this.ui?.setStatus(SettingsController.statusKey, undefined);
    const warningText = loaded.warnings.length ? ` (${loaded.warnings.join("; ")})` : "";
    if (live) this.ui?.notify(`pi-codeui settings reloaded${warningText}`, loaded.warnings.length ? "warning" : "info");
    else if (loaded.warnings.length) this.ui?.setStatus(SettingsController.statusKey, `settings warnings: ${loaded.warnings.join("; ")}`);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const { path, listener } of this.fallbackWatchers) unwatchFile(path, listener);
    this.fallbackWatchers = [];
    this.ui?.setStatus(SettingsController.statusKey, undefined);
  }
}
