import { stripTerminalSequences } from "./tui-compat.ts";

export function sanitizeTerminalLine(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "�");
}
