import { describe, expect, test } from "bun:test";
import { buildSemanticInput } from "../src/semantic/input";

const source = (entryId: string, message: any) => ({ entryId, message });

describe("semantic input builder", () => {
  test("keeps user and assistant prose but excludes thinking and large tool output", () => {
    const huge = "SECRET_FILE_CONTENT".repeat(1000);
    const input = buildSemanticInput({
      previousMemoryJson: "{}",
      maxInputChars: 5000,
      includeToolMetadata: true,
      sources: [
        source("u1", { role: "user", content: "Please use approach B" }),
        source("a1", {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden chain" },
            { type: "text", text: "Approach B is safer." },
            { type: "toolCall", name: "read", arguments: { path: "src/config.ts" } },
          ],
        }),
        source("t1", {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: huge }],
          isError: false,
        }),
      ],
    });

    expect(input.text).toContain("Please use approach B");
    expect(input.text).toContain("Approach B is safer.");
    expect(input.text).toContain("Tool call: read");
    expect(input.text).toContain("completed successfully");
    expect(input.text).not.toContain("hidden chain");
    expect(input.text).not.toContain("SECRET_FILE_CONTENT");
  });

  test("can disable all tool metadata", () => {
    const input = buildSemanticInput({
      previousMemoryJson: "{}",
      maxInputChars: 2000,
      includeToolMetadata: false,
      sources: [
        source("a1", {
          role: "assistant",
          content: [
            { type: "text", text: "Short prose" },
            { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
          ],
        }),
        source("t1", {
          role: "toolResult",
          toolName: "bash",
          content: "failed",
          isError: true,
        }),
      ],
    });
    expect(input.text).toContain("Short prose");
    expect(input.text).not.toContain("Tool");
    expect(input.entries.every((entry) => entry.role !== "tool")).toBe(true);
  });

  test("prioritizes recent user input and stays inside the combined budget", () => {
    const previous = JSON.stringify({ state: "x".repeat(100) });
    const input = buildSemanticInput({
      previousMemoryJson: previous,
      maxInputChars: previous.length + 150,
      includeToolMetadata: true,
      sources: [
        source("a1", { role: "assistant", content: "assistant ".repeat(50) }),
        source("u1", { role: "user", content: "old user message" }),
        source("u2", { role: "user", content: `latest ${"x".repeat(300)}` }),
      ],
    });
    expect(input.text).toContain("latest");
    expect(input.text.length + previous.length).toBeLessThanOrEqual(previous.length + 150);
    expect(input.entries.every((entry, index, entries) =>
      index === 0 || ["u1", "u2"].indexOf(entries[index - 1].entryId ?? "") <=
        ["u1", "u2"].indexOf(entry.entryId ?? ""),
    )).toBe(true);
  });

  test("includes non-redacted thinking last, inside its own budget", () => {
    const sources = [
      source("u1", { role: "user", content: "Fix the cache bug" }),
      source("a1", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `old ${"o".repeat(300)}` },
          { type: "text", text: "Looking at it." },
        ],
      }),
      source("a2", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
          { type: "thinking", thinking: "Rejected LRU because keys are unbounded" },
          { type: "text", text: "Using a TTL map." },
        ],
      }),
    ];
    const input = buildSemanticInput({
      previousMemoryJson: "{}",
      maxInputChars: 5000,
      maxThinkingChars: 100,
      includeToolMetadata: true,
      sources,
    });

    expect(input.text).toContain(
      '<entry role="thinking" id="a2">Rejected LRU because keys are unbounded</entry>',
    );
    expect(input.text).not.toContain("old o");
    expect(input.text).not.toContain("opaque");
    const thinkingChars = input.entries
      .filter((entry) => entry.role === "thinking")
      .reduce((sum, entry) => sum + entry.text.length, 0);
    expect(thinkingChars).toBeLessThanOrEqual(100);
    // Chronological order is preserved: a2's thinking precedes a2's prose.
    expect(input.text.indexOf("Rejected LRU")).toBeLessThan(input.text.indexOf("TTL map"));

    const off = buildSemanticInput({
      previousMemoryJson: "{}",
      maxInputChars: 5000,
      maxThinkingChars: 0,
      includeToolMetadata: true,
      sources,
    });
    expect(off.entries.some((entry) => entry.role === "thinking")).toBe(false);
  });

  test("rejects a previous memory that already exceeds the budget", () => {
    expect(() => buildSemanticInput({
      previousMemoryJson: "x".repeat(101),
      maxInputChars: 100,
      includeToolMetadata: true,
      sources: [],
    })).toThrow("previous-memory-too-large");
  });
});
