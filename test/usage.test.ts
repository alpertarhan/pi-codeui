import assert from "node:assert/strict";
import test from "node:test";
import { calculateUsageSnapshot, formatTokens } from "../src/usage.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const entry = (id: string, role: string, value?: ReturnType<typeof usage>) => ({
  type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z",
  message: { role, content: [], ...(value ? { usage: value } : {}) },
});

test("usage snapshot reports session, latest turn, cache, total, and context", () => {
  const entries = [
    entry("u1", "user"),
    entry("a1", "assistant", usage(100, 20, 30, 5)),
    entry("t1", "toolResult", usage(10, 2)),
    entry("u2", "user"),
    entry("a2", "assistant", usage(50, 10, 100)),
  ] as any[];
  const manager = { getEntries: () => entries, getBranch: () => entries } as any;
  const snapshot = calculateUsageSnapshot(manager, { tokens: 144_000, contextWindow: 272_000, percent: 52.94 });

  assert.deepEqual(snapshot.session, {
    input: 160, output: 32, cacheRead: 130, cacheWrite: 5, cached: 135, total: 327,
  });
  assert.deepEqual(snapshot.turn, {
    input: 50, output: 10, cacheRead: 100, cacheWrite: 0, cached: 100, total: 160,
  });
  assert.equal(snapshot.contextTokens, 144_000);
  assert.equal(snapshot.contextWindow, 272_000);
  assert.equal(snapshot.contextPercent, 52.94);
});

test("token formatter stays compact", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_250), "1.3k");
  assert.equal(formatTokens(18_000), "18k");
  assert.equal(formatTokens(1_250_000), "1.3M");
  assert.equal(formatTokens(18_000_000), "18M");
});
