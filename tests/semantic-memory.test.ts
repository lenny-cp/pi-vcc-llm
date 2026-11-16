import { describe, expect, test } from "bun:test";
import {
  SEMANTIC_MEMORY_CUSTOM_TYPE,
  runSemanticCompaction,
  stripSemanticSummary,
} from "../src/semantic/memory";
import {
  emptySemanticMemory,
  parseSemanticMemory,
  type SemanticMemory,
} from "../src/semantic/schema";
import type { SemanticCompactionSettings } from "../src/core/settings";

const SEMANTIC_SUMMARY_MARKER = "<!-- pi-vcc-semantic:v1 -->";
const settings: SemanticCompactionSettings = {
  enabled: true,
  endpoint: "http://localhost/v1/chat/completions",
  model: "default",
  apiKey: "",
  timeoutMs: 1000,
  maxInputChars: 80000,
  maxOutputTokens: 1600,
  temperature: 0.1,
  disableThinking: true,
  includeToolMetadata: true,
  maxThinkingChars: 0,
  failureMode: "vcc-only",
};

const validMemory = (): SemanticMemory => ({
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  currentState: {
    summary: "Approach B is being implemented",
    lastValidatedResult: "The selection was confirmed",
    nextAction: "Finish the implementation",
  },
  goals: [{ id: "goal-1", text: "Ship MVP", status: "active" }],
  decisions: [{
    id: "decision-1",
    decision: "Use session entries",
    rationale: "Pi supports them",
    status: "active",
  }],
  rejectedApproaches: [],
  openQuestions: [],
  blockers: [],
  preferences: [],
});

const runWithResponse = async (
  responseMemory: SemanticMemory,
  branchEntries: unknown[] = [],
  captureBody?: (body: any) => void,
) => runSemanticCompaction({
  settings,
  branchEntries,
  sources: [{ entryId: "u1", message: { role: "user", content: "Update memory" } as any }],
  now: () => "2026-02-02T00:00:00.000Z",
  fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
    captureBody?.(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(responseMemory) } }],
    }), { status: 200 });
  }) as typeof fetch,
});

describe("semantic memory schema and normalization", () => {
  test("accepts the exact schema and rejects extra fields or statuses", () => {
    expect(parseSemanticMemory(validMemory())).not.toBeNull();
    expect(parseSemanticMemory({ ...validMemory(), extra: true })).toBeNull();
    expect(parseSemanticMemory({
      ...validMemory(),
      decisions: [{ id: "d", decision: "x", status: "accepted" }],
    })).toBeNull();
  });

  test("normalizes lines, deduplicates IDs, and sorts deterministically", async () => {
    const memory = validMemory();
    memory.goals = [
      { id: " z ", text: " Zebra\n goal ", status: "paused" },
      { id: "a", text: "Alpha goal", status: "active" },
      { id: "z", text: "Replacement goal", status: "completed" },
    ];
    const { memory: normalized } = await runWithResponse(memory);
    expect(normalized.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(normalized.goals.map((goal) => goal.text)).toEqual([
      "Alpha goal",
      "Replacement goal",
    ]);
  });
});

describe("semantic memory persistence and rendering", () => {
  test("falls back from an invalid latest custom entry to the last valid state", async () => {
    const valid = validMemory();
    let body: any;
    await runWithResponse(emptySemanticMemory(), [
      { type: "custom", customType: SEMANTIC_MEMORY_CUSTOM_TYPE, data: valid },
      { type: "custom", customType: SEMANTIC_MEMORY_CUSTOM_TYPE, data: { broken: true } },
    ], (captured) => { body = captured; });
    expect(body.messages[1].content).toContain("Ship MVP");
  });

  test("renders fixed Markdown without IDs and omits empty sections", async () => {
    const { rendered } = await runWithResponse(validMemory());
    expect(rendered).toContain(SEMANTIC_SUMMARY_MARKER);
    expect(rendered).toContain("# OPERATIONAL STATE");
    expect(rendered).toContain("Current state: Approach B is being implemented");
    expect(rendered).toContain("Next action: Finish the implementation");
    expect(rendered).toContain("## Current Goals");
    expect(rendered).toContain("Decision: Use session entries");
    expect(rendered).not.toContain("goal-1");
    expect(rendered).not.toContain("## Blockers");
    expect((await runWithResponse(emptySemanticMemory())).rendered).toBe("");
  });

  test("strips only the versioned semantic suffix before deterministic recompilation", async () => {
    const deterministic = "VCC summary\n\n[Earlier Turns]\n- work";
    const { rendered } = await runWithResponse(validMemory());
    const combined = `${rendered}\n\n---\n\n${deterministic}`;
    expect(stripSemanticSummary(combined)).toBe(deterministic);
    expect(stripSemanticSummary(`${deterministic}\n\n${rendered}`)).toBe(deterministic);
    expect(stripSemanticSummary(deterministic)).toBe(deterministic);
  });
});
