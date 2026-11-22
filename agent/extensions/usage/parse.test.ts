import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCodexStatus,
  formatGoStatus,
  parseCodexUsage,
  parseOpenCodeGoUsage,
} from "./parse.ts";

test("parses Codex 5-hour and weekly windows without assuming order", () => {
  const windows = parseCodexUsage({
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 9, limit_window_seconds: 604_800, reset_at: 1_700_000_000 },
      secondary_window: { used_percent: 41, limit_window_seconds: 18_000, reset_after_seconds: 120 },
    },
  }, 1_600_000_000_000);
  assert.deepEqual(windows?.map((window) => window.id), ["7d", "5h"]);
  assert.equal(windows?.[1]?.usedPercent, 41);
  assert.equal(formatCodexStatus(windows ?? []), "Codex 5h 41% 7d 9%");
});

test("shows a non-weekly Codex window when 5h and weekly are absent", () => {
  const windows = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 2_592_000, reset_at: 1_797_703_054 },
      secondary_window: null,
    },
  });
  assert.equal(windows?.[0]?.id, "30d");
  assert.equal(formatCodexStatus(windows ?? []), "Codex 30d 0%");
});

test("parses OpenCode Go used percentages", () => {
  const windows = parseOpenCodeGoUsage({
    usage: {
      rolling: { status: "ok", percent: 42, resetsAt: "2026-11-19T22:52:17.000Z" },
      weekly: { status: "ok", percent: 17, resetsAt: "2026-11-23T00:00:00.000Z" },
      monthly: { status: "rate-limited", percent: 91, resetsAt: "2026-11-20T05:32:10.000Z" },
    },
  });
  assert.equal(formatGoStatus(windows ?? []), "Go 5h 42% 7d 17% 30d 100%!");
});

test("marks only the exhausted Codex window as limited", () => {
  const windows = parseCodexUsage({
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_700_000_000 },
      secondary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: 1_700_000_000 },
    },
  });
  assert.equal(formatCodexStatus(windows ?? []), "Codex 5h 20% 7d 100%!");
});

test("marks every Codex window as limited when blocked with no exhausted window", () => {
  const windows = parseCodexUsage({
    rate_limit: {
      limit_reached: true,
      primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_700_000_000 },
      secondary_window: { used_percent: 30, limit_window_seconds: 604_800, reset_at: 1_700_000_000 },
    },
  });
  assert.equal(formatCodexStatus(windows ?? []), "Codex 5h 20%! 7d 30%!");
});
