import { stripVTControlCharacters } from "node:util";

const RESET = "\x1b[0m";
const WIDTH_CACHE_LIMIT = 1_024;
const widthCache = new Map<string, number>();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const zeroWidth = /^(?:\p{Mark}|\p{Format}|\p{Control})+$/u;
const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

const escapeLength = (value: string, start: number): number => {
  if (value.charCodeAt(start) !== 0x1b) return 0;
  const kind = value[start + 1];
  if (kind === "[") {
    for (let index = start + 2; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index - start + 1;
    }
    return value.length - start;
  }
  if (kind === "]") {
    for (let index = start + 2; index < value.length; index++) {
      if (value.charCodeAt(index) === 0x07) return index - start + 1;
      if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") return index - start + 2;
    }
    return value.length - start;
  }
  if (kind === "_" || kind === "P" || kind === "^" || kind === "X") {
    for (let index = start + 2; index < value.length; index++) {
      if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") return index - start + 2;
    }
    return value.length - start;
  }
  return Math.min(2, value.length - start);
};

const isWideCodePoint = (code: number): boolean =>
  code >= 0x1100 && (
    code <= 0x115f
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x20000 && code <= 0x3fffd)
  );

const graphemeWidth = (segment: string): number => {
  if (segment === "\t") return 3;
  if (zeroWidth.test(segment)) return 0;
  if (emoji.test(segment)) return 2;
  const code = segment.codePointAt(0);
  return code !== undefined && isWideCodePoint(code) ? 2 : 1;
};

const tokens = (value: string): Array<{ raw: string; width: number; sgr?: string }> => {
  const result: Array<{ raw: string; width: number; sgr?: string }> = [];
  let index = 0;
  while (index < value.length) {
    const length = escapeLength(value, index);
    if (length > 0) {
      const raw = value.slice(index, index + length);
      result.push({ raw, width: 0, sgr: /^\x1b\[[0-9;]*m$/.test(raw) ? raw : undefined });
      index += length;
      continue;
    }
    let end = index + 1;
    while (end < value.length && value.charCodeAt(end) !== 0x1b) end++;
    for (const { segment } of graphemes.segment(value.slice(index, end))) result.push({ raw: segment, width: graphemeWidth(segment) });
    index = end;
  }
  return result;
};

/** Remove ANSI CSI, OSC, APC, DCS, and other VT control sequences. */
export function stripTerminalSequences(value: string): string {
  if (!value.includes("\x1b")) return value;
  let result = "";
  for (let index = 0; index < value.length;) {
    const length = escapeLength(value, index);
    if (length > 0) index += length;
    else result += value[index++];
  }
  return stripVTControlCharacters(result);
}

/** Return terminal-cell width without relying on optional pi-tui utility exports. */
export function visibleWidth(value: string): number {
  if (!value) return 0;
  if (/^[\x20-\x7e]*$/.test(value)) return value.length;
  const cached = widthCache.get(value);
  if (cached !== undefined) return cached;
  const clean = stripTerminalSequences(value).replace(/\t/g, "   ");
  let width = 0;
  if (/^[\x20-\x7e]*$/.test(clean)) width = clean.length;
  else for (const { segment } of graphemes.segment(clean)) width += graphemeWidth(segment);
  if (widthCache.size >= WIDTH_CACHE_LIMIT) widthCache.delete(widthCache.keys().next().value!);
  widthCache.set(value, width);
  return width;
}

/** ANSI-safe terminal-cell truncation compatible with pi-tui's common call shape. */
export function truncateToWidth(value: string, maxWidth: number, ellipsis = "...", pad = false): string {
  const width = Math.max(0, maxWidth);
  const current = visibleWidth(value);
  if (current <= width) return pad ? value + " ".repeat(width - current) : value;
  if (width === 0) return "";
  const fittedEllipsis = [...graphemes.segment(stripTerminalSequences(ellipsis))]
    .map(({ segment }) => segment)
    .reduce((result, segment) => visibleWidth(result + segment) <= width ? result + segment : result, "");
  const target = Math.max(0, width - visibleWidth(fittedEllipsis));
  let result = "";
  let used = 0;
  let hadAnsi = false;
  for (const token of tokens(value)) {
    if (token.width === 0) {
      result += token.raw;
      hadAnsi ||= token.raw.startsWith("\x1b");
      continue;
    }
    if (used + token.width > target) break;
    result += token.raw;
    used += token.width;
  }
  if (hadAnsi) result += RESET;
  result += fittedEllipsis;
  return pad ? result + " ".repeat(Math.max(0, width - used - visibleWidth(fittedEllipsis))) : result;
}

/** Simple ANSI-safe grapheme wrapping for insight and diagnostic copy. */
export function wrapTextWithAnsi(value: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  let activeSgr = "";
  const flush = () => {
    lines.push(activeSgr && !line.endsWith(RESET) ? `${line}${RESET}` : line);
    line = activeSgr;
    lineWidth = 0;
  };
  for (const token of tokens(value)) {
    if (token.sgr) {
      line += token.raw;
      activeSgr = /^\x1b\[(?:0|)m$/.test(token.raw) ? "" : `${activeSgr}${token.raw}`;
      continue;
    }
    if (token.raw === "\n") {
      flush();
      continue;
    }
    if (token.width === 0) {
      line += token.raw;
      continue;
    }
    if (lineWidth + token.width > maxWidth && lineWidth > 0) flush();
    if (lineWidth === 0 && /^\s$/u.test(token.raw)) continue;
    line += token.raw;
    lineWidth += token.width;
  }
  if (lineWidth > 0 || line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

/** Detect plain or Shift-only Kitty CSI-u printable input. */
export function decodeKittyPrintable(value: string): string | undefined {
  const match = /^\x1b\[(\d+)(?::(\d+))?(?::\d+)?(?:;(\d+)(?::\d+)?)?u$/.exec(value);
  if (!match) return undefined;
  const modifier = Number.parseInt(match[3] ?? "1", 10) - 1;
  if ((modifier & ~1) !== 0) return undefined;
  const code = modifier === 1 && match[2] ? Number.parseInt(match[2], 10) : Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xe000 && code <= 0xf8ff)) return undefined;
  try {
    return String.fromCodePoint(code);
  } catch {
    return undefined;
  }
}
