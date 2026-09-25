import { test } from "vitest";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mts";
import { renderWebSearchProgress } from "../plugins/codex/scripts/lib/codex.mts";

test("web search progress renders action query and open-page URL", () => {
  const search = { type: "webSearch", id: "web_1", query: "", action: { type: "search", query: "GPT-6 model guidance", queries: null }, results: null };
  assert.equal(renderWebSearchProgress(search), "Searching: GPT-6 model guidance");
  const open = { type: "webSearch", id: "web_2", query: "", action: { type: "openPage", url: "https://example.com/docs" }, results: null };
  assert.equal(renderWebSearchProgress(open), "Opening: https://example.com/docs");
  assert.equal(renderWebSearchProgress({ ...search, action: { type: "search", query: "q".repeat(140), queries: null } }).length, "Searching: ".length + 120);
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});
