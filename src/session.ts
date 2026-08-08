import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalLine } from "./terminal.ts";

export interface SessionMessageSummary {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface SessionOverview {
  name?: string;
  title: string;
  userTurns: number;
  assistantMessages: number;
  images: number;
  messages: readonly SessionMessageSummary[];
}

export const EMPTY_SESSION_OVERVIEW: SessionOverview = {
  title: "New conversation",
  userTurns: 0,
  assistantMessages: 0,
  images: 0,
  messages: [],
};

const clean = (value: string, max: number): string => {
  const text = sanitizeTerminalLine(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

const messageText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join(" ");
};

const imageCount = (content: unknown): number => Array.isArray(content)
  ? content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "image").length
  : 0;

export function summarizeSession(entries: readonly SessionEntry[], name?: string): SessionOverview {
  const messages: SessionMessageSummary[] = [];
  let userTurns = 0;
  let assistantMessages = 0;
  let images = 0;
  let firstUserText = "";

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "user") userTurns++;
    else assistantMessages++;
    images += imageCount(message.content);
    const text = clean(messageText(message.content), 8_000);
    if (message.role === "user" && !firstUserText && text) firstUserText = text;
    if (text) messages.push({
      id: entry.id,
      role: message.role,
      text,
      timestamp: Number.isFinite(Date.parse(entry.timestamp)) ? Date.parse(entry.timestamp) : 0,
    });
  }

  const safeName = clean(name ?? "", 72);
  // ponytail: bound rail search to recent messages; paginate only if long-session search proves necessary.
  const recentMessages = messages.slice(-200);
  return {
    ...(safeName ? { name: safeName } : {}),
    title: safeName || clean(firstUserText, 72) || EMPTY_SESSION_OVERVIEW.title,
    userTurns,
    assistantMessages,
    images,
    messages: recentMessages,
  };
}
