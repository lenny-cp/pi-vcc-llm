import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PI_VCC_COMPACT_INSTRUCTION,
  registerBeforeCompactHook,
} from "../src/hooks/before-compact";
import {
  SEMANTIC_MEMORY_CUSTOM_TYPE,
} from "../src/semantic/memory";

const SEMANTIC_SUMMARY_MARKER = "<!-- pi-vcc-semantic:v1 -->";

let directory: string;
let configPath: string;
let originalFetch: typeof fetch;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-vcc-semantic-hook-"));
  configPath = join(directory, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = configPath;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  globalThis.fetch = originalFetch;
  rmSync(directory, { recursive: true, force: true });
});

const messages = () => [
  { id: "u1", type: "message", message: { role: "user", content: "I propose approach A." } },
  { id: "a1", type: "message", message: { role: "assistant", content: "Approach B may be safer." } },
  { id: "u2", type: "message", message: { role: "user", content: "Use approach B. That is the decision." } },
  { id: "a2", type: "message", message: { role: "assistant", content: "Implementing B." } },
  { id: "u3", type: "message", message: { role: "user", content: "Continue." } },
];

const event = (branchEntries = messages(), previousSummary?: string) => ({
  type: "session_before_compact",
  customInstructions: PI_VCC_COMPACT_INSTRUCTION,
  branchEntries,
  preparation: {
    previousSummary,
    fileOps: { read: [], written: [], edited: [] },
    tokensBefore: 1000,
  },
  signal: new AbortController().signal,
});

const createMock = (options?: { appendThrows?: boolean }) => {
  let handler: ((event: any, ctx: any) => any) | undefined;
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    on: (name: string, next: (event: any, ctx: any) => any) => {
      if (name === "session_before_compact") handler = next;
    },
    appendEntry: (customType: string, data: unknown) => {
      if (options?.appendThrows) throw new Error("disk contained a secret");
      appended.push({ customType, data });
    },
  } as any;
  registerBeforeCompactHook(pi);
  const ctx = {
    model: {
      id: "active-test-model",
      contextWindow: 100000,
      maxTokens: 10000,
    },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  };
  return {
    invoke: (input = event()) => handler!(input, ctx),
    appended,
    notifications,
  };
};

const writeConfig = (semanticCompaction: Record<string, unknown>) => {
  writeFileSync(configPath, JSON.stringify({
    overrideDefaultCompaction: true,
    debug: false,
    semanticCompaction,
  }));
};

const semanticResponse = {
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  goals: [],
  decisions: [{
    id: "decision-b",
    decision: "Use approach B",
    rationale: "The user explicitly selected it",
    status: "active",
    evidenceEntryIds: ["u2"],
  }],
  rejectedApproaches: [{
    id: "rejected-a",
    approach: "Approach A",
    reason: "It was proposed but not selected",
    evidenceEntryIds: ["u1"],
  }],
  openQuestions: [],
  blockers: [],
  preferences: [],
};

describe("semantic compaction hook integration", () => {
  test("disabled mode stays synchronous and performs no semantic side effects", () => {
    writeConfig({ enabled: false });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("must not run");
    }) as typeof fetch;
    const mock = createMock();
    const result = mock.invoke();
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.compaction.summary).not.toContain(SEMANTIC_SUMMARY_MARKER);
    expect(fetchCalls).toBe(0);
    expect(mock.appended).toHaveLength(0);
  });

  test("appends validated B-active memory and deterministic Markdown", async () => {
    writeConfig({ enabled: true });
    let requestBody: any;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(semanticResponse) } }],
      }), { status: 200 });
    }) as typeof fetch;

    const mock = createMock();
    const result = await mock.invoke();
    expect(requestBody.model).toBe("active-test-model");
    expect(requestBody.response_format.type).toBe("json_schema");
    expect(requestBody.response_format.json_schema.strict).toBe(true);
    expect(requestBody.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(requestBody.messages[1].content).toContain("Use approach B. That is the decision.");
    expect(requestBody.messages[1].content).not.toContain("Continue.");
    expect(result.compaction.summary).toContain(SEMANTIC_SUMMARY_MARKER);
    expect(result.compaction.summary.startsWith(SEMANTIC_SUMMARY_MARKER)).toBe(true);
    expect(result.compaction.summary).toContain("[active] Decision: Use approach B");
    expect(result.compaction.summary).not.toContain("[active] Decision: Approach A");
    expect(mock.appended).toHaveLength(1);
    expect(mock.appended[0].customType).toBe(SEMANTIC_MEMORY_CUSTOM_TYPE);
    expect((mock.appended[0].data as any).decisions[0].status).toBe("active");
    expect(result.compaction.details.semanticCompaction).toMatchObject({
      status: "success",
      model: "active-test-model",
    });
  });

  test("invalid model JSON fails open without persisting or exposing response text", async () => {
    writeConfig({ enabled: true });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "SECRET invalid markdown" } }],
    }), { status: 200 })) as typeof fetch;
    const mock = createMock();
    const result = await mock.invoke();
    expect(result.compaction.summary).not.toContain(SEMANTIC_SUMMARY_MARKER);
    expect(mock.appended).toHaveLength(0);
    expect(mock.notifications[0]).toEqual({
      message: "pi-vcc: semantic compaction failed (invalid-json); using VCC-only output",
      level: "warning",
    });
    expect(mock.notifications[0].message).not.toContain("SECRET");
    expect(result.compaction.details.semanticCompaction).toMatchObject({
      status: "failed",
      failureCode: "invalid-json",
      model: "active-test-model",
    });
  });

  test("persistence failure discards the semantic suffix and fails open", async () => {
    writeConfig({ enabled: true });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(semanticResponse) } }],
    }), { status: 200 })) as typeof fetch;
    const mock = createMock({ appendThrows: true });
    const result = await mock.invoke();
    expect(result.compaction.summary).not.toContain(SEMANTIC_SUMMARY_MARKER);
    expect(mock.notifications[0].message).toContain("(persistence)");
    expect(mock.notifications[0].message).not.toContain("secret");
  });

  test("replaces rather than stacks the semantic suffix across compactions", async () => {
    writeConfig({ enabled: true });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(semanticResponse) } }],
    }), { status: 200 })) as typeof fetch;
    const first = createMock();
    const firstResult = await first.invoke();
    const priorState = first.appended[0].data;

    const second = createMock();
    const branch = [
      ...messages(),
      {
        id: "semantic-1",
        type: "custom",
        customType: SEMANTIC_MEMORY_CUSTOM_TYPE,
        data: priorState,
      },
    ];
    const secondResult = await second.invoke(event(
      branch,
      firstResult.compaction.summary,
    ));
    expect(
      secondResult.compaction.summary.split(SEMANTIC_SUMMARY_MARKER).length - 1,
    ).toBe(1);
  });

  test("does not take over a pi-core compaction when override is false", () => {
    writeFileSync(configPath, JSON.stringify({
      overrideDefaultCompaction: false,
      semanticCompaction: { enabled: true },
    }));
    const mock = createMock();
    const coreEvent = { ...event(), customInstructions: undefined };
    expect(mock.invoke(coreEvent)).toBeUndefined();
    expect(mock.appended).toHaveLength(0);
  });
});
