import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth as piVisibleWidth } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../src/tui-compat.ts";

const samples = [
  "plain ascii",
  "e\u0301",
  "Türkçe",
  "日本語",
  "🙂",
  "👨‍💻",
  " main",
  "\x1b[36mcyan\x1b[0m",
  "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
];

test("local terminal width compatibility matches pi-tui for product glyphs and ANSI", () => {
  for (const sample of samples) assert.equal(visibleWidth(sample), piVisibleWidth(sample), JSON.stringify(sample));
  assert.equal(stripTerminalSequences("\x1b[31mred\x1b[0m"), "red");
  assert.equal(stripTerminalSequences("\x1b]0;title\x07visible"), "visible");
  assert.equal(stripTerminalSequences("\x1b_hidden\x1b\\visible"), "visible");
});

test("local truncation and wrapping stay width-safe without pi-tui runtime helpers", () => {
  const styled = "\x1b[36m日本語 and a deliberately long status\x1b[0m";
  for (const width of [0, 1, 2, 5, 12, 24]) {
    const line = truncateToWidth(styled, width, "…");
    assert.ok(visibleWidth(line) <= width);
  }
  assert.equal(stripTerminalSequences(truncateToWidth(styled, 7, "…")), "日本語…");
  const wrapped = wrapTextWithAnsi(styled, 8);
  assert.ok(wrapped.length > 1);
  assert.ok(wrapped.every((line) => visibleWidth(line) <= 8));
  assert.match(stripTerminalSequences(wrapped.join("")), /日本語 and a deliberately long status/);
});

test("local Kitty printable decoding preserves normal-mode control shortcuts", () => {
  assert.equal(decodeKittyPrintable("\x1b[97u"), "a");
  assert.equal(decodeKittyPrintable("\x1b[97:65;2u"), "A");
  assert.equal(decodeKittyPrintable("\x1b[97;5u"), undefined, "Ctrl-modified input must remain available to Pi keybindings");
  assert.equal(decodeKittyPrintable("\x1b[A"), undefined);
});
