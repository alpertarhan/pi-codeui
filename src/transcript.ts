import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";

export function decorateTranscriptMarkdown(markdown: string, context: MarkdownTransformContext, enabled = true): string {
  if (!enabled || !markdown.trim() || (context.messageType !== "user" && context.messageType !== "assistant")) return markdown;
  const identity = context.messageType === "user" ? "`U` **You**" : `\`π\` **Pi**${context.isStreaming ? " · _working_" : ""}`;
  return `${identity}  \n${markdown}`;
}
