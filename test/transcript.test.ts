import assert from "node:assert/strict";
import test from "node:test";
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { decorateTranscriptMarkdown } from "../src/transcript.ts";

const context = (messageType: MarkdownTransformContext["messageType"], isStreaming = false): MarkdownTransformContext => ({ messageType, isStreaming, availableWidth: 80 });

test("transcript skin labels user and assistant messages without touching thinking", () => {
  assert.equal(decorateTranscriptMarkdown("Fix the validation", context("user")), "`U` **You**  \nFix the validation");
  assert.equal(decorateTranscriptMarkdown("Inspecting the flow", context("assistant", true)), "`π` **Pi** · _working_  \nInspecting the flow");
  assert.equal(decorateTranscriptMarkdown("Done", context("assistant")), "`π` **Pi**  \nDone");
  assert.equal(decorateTranscriptMarkdown("private thought", context("assistant-thinking")), "private thought");
  assert.equal(decorateTranscriptMarkdown("", context("assistant")), "");
  assert.equal(decorateTranscriptMarkdown("Done", context("assistant"), false), "Done");
});
