import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { cloneSettings, DEFAULT_SETTINGS, normalizeSettings, type CodeuiSettings } from "./settings.ts";

export const SETTINGS_FILE_NAME = "codeui.settings.json";

export interface SettingsPaths {
  global: string;
  project: string;
}

export interface LoadedSettings {
  settings: CodeuiSettings;
  warnings: string[];
  errors: string[];
}

export function getSettingsPaths(cwd: string): SettingsPaths {
  return {
    global: join(getAgentDir(), SETTINGS_FILE_NAME),
    project: join(cwd, CONFIG_DIR_NAME, SETTINGS_FILE_NAME),
  };
}

export async function loadSettings(paths: SettingsPaths, projectTrusted: boolean): Promise<LoadedSettings> {
  let settings = cloneSettings(DEFAULT_SETTINGS);
  const warnings: string[] = [];
  const errors: string[] = [];

  const global = await readSettingsFile(paths.global, settings);
  settings = global.settings;
  warnings.push(...global.warnings);
  if (global.error) errors.push(global.error);

  if (projectTrusted) {
    const project = await readSettingsFile(paths.project, settings);
    settings = project.settings;
    warnings.push(...project.warnings);
    if (project.error) errors.push(project.error);
  }
  return { settings, warnings, errors };
}

async function readSettingsFile(path: string, inherited: Readonly<CodeuiSettings>): Promise<{ settings: CodeuiSettings; warnings: string[]; error?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: cloneSettings(inherited), warnings: [] };
    return { settings: cloneSettings(inherited), warnings: [], error: `${path}: ${(error as Error).message}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { settings: cloneSettings(inherited), warnings: [], error: `${path}: malformed JSON (${(error as Error).message})` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings: cloneSettings(inherited), warnings: [], error: `${path}: settings root must be an object` };
  }
  const normalized = normalizeSettings(raw, inherited);
  return { settings: normalized.settings, warnings: normalized.warnings.map((warning) => `${path}: ${warning}`) };
}
