export type SearchKind = "file" | "activity" | "check";

export interface SearchDocument<T = unknown> {
  id: string;
  kind: SearchKind;
  title: string;
  detail: string;
  keywords?: string;
  value: T;
}

export interface RankedSearchDocument<T = unknown> extends SearchDocument<T> {
  score: number;
}

const normalize = (value: string): string => value.normalize("NFKD").toLowerCase();

function tokenScore(haystack: string, token: string): number | undefined {
  const exact = haystack.indexOf(token);
  if (exact >= 0) {
    const boundary = exact === 0 || /[\s/_.:@-]/.test(haystack[exact - 1] ?? "");
    return (boundary ? 240 : 190) - Math.min(80, exact);
  }
  let cursor = 0;
  let first = -1;
  let gaps = 0;
  for (const character of token) {
    const index = haystack.indexOf(character, cursor);
    if (index < 0) return undefined;
    if (first < 0) first = index;
    else gaps += index - cursor;
    cursor = index + 1;
  }
  return 120 - Math.min(70, Math.max(0, first)) - Math.min(40, gaps);
}

export function parseSearchQuery(query: string): { kind?: SearchKind; text: string } {
  const match = /^\s*(file|activity|checks?|[fac]):\s*/i.exec(query);
  if (!match) return { text: query.trim() };
  const key = match[1]!.toLowerCase();
  const kind: SearchKind = key === "f" || key === "file" ? "file" : key === "a" || key === "activity" ? "activity" : "check";
  return { kind, text: query.slice(match[0].length).trim() };
}

export function fuzzySearch<T>(documents: readonly SearchDocument<T>[], query: string, limit = 50): RankedSearchDocument<T>[] {
  const parsed = parseSearchQuery(query);
  const tokens = normalize(parsed.text).split(/\s+/).filter(Boolean);
  const ranked: RankedSearchDocument<T>[] = [];
  for (let index = 0; index < documents.length; index++) {
    const document = documents[index]!;
    if (parsed.kind && document.kind !== parsed.kind) continue;
    const title = normalize(document.title);
    const haystack = `${title} ${normalize(document.detail)} ${normalize(document.keywords ?? "")}`;
    let score = parsed.kind ? 20 : 0;
    let matches = true;
    for (const token of tokens) {
      const value = tokenScore(haystack, token);
      if (value === undefined) {
        matches = false;
        break;
      }
      score += value + (title.includes(token) ? 35 : 0);
    }
    if (matches) ranked.push({ ...document, score: tokens.length ? score : -index });
  }
  return ranked
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, Math.max(0, limit));
}
