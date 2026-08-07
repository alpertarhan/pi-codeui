import type { ContextUsage, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenTotals extends UsageLike {
  cached: number;
  total: number;
}

export interface UsageSnapshot {
  session: TokenTotals;
  turnNumber: number;
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
}

const empty = (): UsageLike => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const usageOf = (entry: SessionEntry): UsageLike | undefined => {
  if (entry.type === "message") {
    const message = entry.message as { role?: string; usage?: UsageLike };
    if ((message.role === "assistant" || message.role === "toolResult") && message.usage) return message.usage;
  }
  if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) return entry.usage;
  return undefined;
};

const add = (target: UsageLike, usage: UsageLike): void => {
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
};

const finish = (usage: UsageLike): TokenTotals => ({
  ...usage,
  cached: usage.cacheRead + usage.cacheWrite,
  total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
});

export function calculateUsageSnapshot(
  sessionManager: ReadonlySessionManager,
  context: ContextUsage | undefined,
  modelContextWindow = 0,
): UsageSnapshot {
  const session = empty();
  for (const entry of sessionManager.getEntries()) {
    const usage = usageOf(entry);
    if (usage) add(session, usage);
  }

  const turnNumber = sessionManager.getBranch().filter((entry) =>
    entry.type === "message" && (entry.message as { role?: string }).role === "user"
  ).length;

  return {
    session: finish(session),
    turnNumber,
    contextTokens: context?.tokens ?? null,
    contextWindow: context?.contextWindow ?? modelContextWindow,
    contextPercent: context?.percent ?? null,
  };
}

export function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}
