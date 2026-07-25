import type { Message } from "@earendil-works/pi-ai";
import { textOf } from "../core/content";
import { sanitize } from "../core/sanitize";

export interface SemanticMessageSource {
  entryId?: string;
  message: Message;
}

interface SemanticInputEntry {
  entryId?: string;
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface SemanticInput {
  entries: SemanticInputEntry[];
  text: string;
}

interface Candidate extends SemanticInputEntry {
  order: number;
}

const compactWhitespace = (text: string): string =>
  sanitize(text).replace(/\s+/g, " ").trim();

const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  if (max <= 5) return text.slice(0, max);
  const marker = " … ";
  const available = max - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
};

const toolCallMetadata = (part: any): string => {
  const args = part.arguments ?? part.input;
  const fields = ["path", "file", "command", "pattern", "query"];
  const metadata: string[] = [];
  if (args && typeof args === "object") {
    for (const field of fields) {
      const value = (args as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim()) {
        metadata.push(`${field}=${JSON.stringify(clip(compactWhitespace(value), 200))}`);
      }
    }
  }
  return compactWhitespace(
    `Tool call: ${typeof part.name === "string" ? part.name : "unknown"}${metadata.length ? ` ${metadata.join(" ")}` : ""}`,
  );
};

const candidatesOf = (
  sources: SemanticMessageSource[],
  includeToolMetadata: boolean,
): Candidate[] => {
  const candidates: Candidate[] = [];
  let order = 0;

  for (const source of sources) {
    const message = source.message as any;
    if (message.role === "user") {
      const text = compactWhitespace(textOf(message.content));
      if (text) candidates.push({ entryId: source.entryId, role: "user", text, order: order++ });
      continue;
    }

    if (message.role === "assistant") {
      const prose = typeof message.content === "string"
        ? compactWhitespace(message.content)
        : Array.isArray(message.content)
          ? compactWhitespace(
              message.content
                .filter((part: any) => part?.type === "text" && typeof part.text === "string")
                .map((part: any) => part.text)
                .join("\n"),
            )
          : "";
      if (prose) {
        candidates.push({ entryId: source.entryId, role: "assistant", text: prose, order: order++ });
      }
      if (includeToolMetadata && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type !== "toolCall") continue;
          candidates.push({
            entryId: source.entryId,
            role: "tool",
            text: toolCallMetadata(part),
            order: order++,
          });
        }
      }
      continue;
    }

    if (includeToolMetadata && message.role === "toolResult") {
      const name = typeof message.toolName === "string" ? message.toolName : "unknown";
      const errorText = message.isError
        ? compactWhitespace(textOf(message.content)).slice(0, 200)
        : "";
      candidates.push({
        entryId: source.entryId,
        role: "tool",
        text: errorText
          ? `Tool result: ${name} failed: ${errorText}`
          : `Tool result: ${name} completed successfully`,
        order: order++,
      });
    }
  }

  return candidates;
};

const renderEntry = (entry: SemanticInputEntry): string => {
  const id = entry.entryId ? ` id=${JSON.stringify(entry.entryId)}` : "";
  return `<entry role=${JSON.stringify(entry.role)}${id}>${entry.text}</entry>`;
};

export const buildSemanticInput = (options: {
  sources: SemanticMessageSource[];
  includeToolMetadata: boolean;
  maxInputChars: number;
  previousMemoryJson: string;
}): SemanticInput => {
  const remainingInitial = options.maxInputChars - options.previousMemoryJson.length;
  if (remainingInitial < 0) {
    throw new Error("previous-memory-too-large");
  }

  const candidates = candidatesOf(options.sources, options.includeToolMetadata);
  const priorities: SemanticInputEntry["role"][] = ["user", "assistant", "tool"];
  const selected: Candidate[] = [];
  let remaining = remainingInitial;

  for (const role of priorities) {
    const tier = candidates.filter((candidate) => candidate.role === role).reverse();
    for (const candidate of tier) {
      if (remaining <= 0) break;
      const rendered = renderEntry(candidate);
      const separatorCost = selected.length > 0 ? 1 : 0;
      if (rendered.length + separatorCost <= remaining) {
        selected.push(candidate);
        remaining -= rendered.length + separatorCost;
        continue;
      }

      const fixedCost = renderEntry({ ...candidate, text: "" }).length + separatorCost;
      const textBudget = remaining - fixedCost;
      if (textBudget > 0) {
        const clipped = { ...candidate, text: clip(candidate.text, textBudget) };
        selected.push(clipped);
        remaining = 0;
      }
      break;
    }
  }

  selected.sort((a, b) => a.order - b.order);
  const entries = selected.map(({ order: _, ...entry }) => entry);
  return {
    entries,
    text: entries.map(renderEntry).join("\n"),
  };
};
