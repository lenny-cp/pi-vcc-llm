import type { SemanticCompactionSettings } from "../core/settings";
import {
  SemanticClientError,
  requestSemanticCompletion,
  type SemanticClientFailure,
} from "./client";
import {
  SemanticMemorySchema,
  emptySemanticMemory,
  parseSemanticMemory,
  type SemanticMemory,
} from "./schema";
import {
  buildSemanticInput,
  type SemanticMessageSource,
} from "./input";

export const SEMANTIC_MEMORY_CUSTOM_TYPE = "pi-vcc-semantic-memory-v1";
const SEMANTIC_SUMMARY_MARKER = "<!-- pi-vcc-semantic:v1 -->";

export type SemanticFailureCode =
  | SemanticClientFailure
  | "insufficient-context"
  | "invalid-json"
  | "schema-validation"
  | "persistence"
  | "internal";

export class SemanticCompactionError extends Error {
  constructor(public readonly code: SemanticFailureCode) {
    super(code);
    this.name = "SemanticCompactionError";
  }
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const evidence = (ids: string[] | undefined, knownIds: Set<string>): string[] | undefined => {
  if (!ids) return undefined;
  const normalized = [...new Set(ids.map(oneLine).filter((id) => knownIds.has(id)))]
    .sort(compareText);
  return normalized.length ? normalized : undefined;
};

const dedupeById = <T extends { id: string }>(items: T[]): T[] => {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()];
};

const normalizeSemanticMemory = (
  memory: SemanticMemory,
  updatedAt: string,
  knownIds: Set<string>,
): SemanticMemory => {
  const currentState = memory.currentState
    ? {
        summary: oneLine(memory.currentState.summary),
        lastValidatedResult: memory.currentState.lastValidatedResult
          ? oneLine(memory.currentState.lastValidatedResult) || undefined
          : undefined,
        nextAction: memory.currentState.nextAction
          ? oneLine(memory.currentState.nextAction) || undefined
          : undefined,
        evidenceEntryIds: evidence(memory.currentState.evidenceEntryIds, knownIds),
      }
    : undefined;
  const goals = dedupeById(memory.goals.map((item) => ({
    ...item,
    id: oneLine(item.id),
    text: oneLine(item.text),
    evidenceEntryIds: evidence(item.evidenceEntryIds, knownIds),
  })).filter((item) => item.id && item.text))
    .sort((a, b) => compareText(a.text, b.text) || compareText(a.id, b.id));

  const decisions = dedupeById(memory.decisions.map((item) => ({
    ...item,
    id: oneLine(item.id),
    decision: oneLine(item.decision),
    rationale: item.rationale ? oneLine(item.rationale) || undefined : undefined,
    evidenceEntryIds: evidence(item.evidenceEntryIds, knownIds),
  })).filter((item) => item.id && item.decision))
    .sort((a, b) => compareText(a.decision, b.decision) || compareText(a.id, b.id));

  const rejectedApproaches = dedupeById(memory.rejectedApproaches.map((item) => ({
    ...item,
    id: oneLine(item.id),
    approach: oneLine(item.approach),
    reason: item.reason ? oneLine(item.reason) || undefined : undefined,
    evidenceEntryIds: evidence(item.evidenceEntryIds, knownIds),
  })).filter((item) => item.id && item.approach))
    .sort((a, b) => compareText(a.approach, b.approach) || compareText(a.id, b.id));

  const openQuestions = dedupeById(memory.openQuestions.map((item) => ({
    ...item,
    id: oneLine(item.id),
    question: oneLine(item.question),
    evidenceEntryIds: evidence(item.evidenceEntryIds, knownIds),
  })).filter((item) => item.id && item.question))
    .sort((a, b) => compareText(a.question, b.question) || compareText(a.id, b.id));

  const blockers = dedupeById(memory.blockers.map((item) => ({
    ...item,
    id: oneLine(item.id),
    text: oneLine(item.text),
    evidenceEntryIds: evidence(item.evidenceEntryIds, knownIds),
  })).filter((item) => item.id && item.text))
    .sort((a, b) => compareText(a.text, b.text) || compareText(a.id, b.id));

  const preferences = dedupeById(memory.preferences.map((item) => ({
    ...item,
    id: oneLine(item.id),
    text: oneLine(item.text),
    evidenceEntryIds: evidence(item.evidenceEntryIds, knownIds),
  })).filter((item) => item.id && item.text))
    .sort((a, b) => compareText(a.text, b.text) || compareText(a.id, b.id));

  return {
    schemaVersion: 1,
    updatedAt,
    ...(currentState?.summary ? { currentState } : {}),
    goals,
    decisions,
    rejectedApproaches,
    openQuestions,
    blockers,
    preferences,
  };
};

// Closed items render once, in the compaction that closed them, then leave the
// memory the model sees, so they stop occupying the per-category item limits.
const withoutClosedItems = (memory: SemanticMemory): SemanticMemory => ({
  ...memory,
  goals: memory.goals.filter((item) => item.status !== "completed"),
  decisions: memory.decisions.filter((item) => item.status !== "superseded"),
  openQuestions: memory.openQuestions.filter((item) => item.status !== "resolved"),
  blockers: memory.blockers.filter((item) => item.status !== "resolved"),
});

const loadSemanticMemory = (branchEntries: unknown[]): SemanticMemory | null => {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index] as any;
    if (entry?.type !== "custom" || entry.customType !== SEMANTIC_MEMORY_CUSTOM_TYPE) continue;
    const parsed = parseSemanticMemory(entry.data);
    if (parsed) return parsed;
  }
  return null;
};

const section = (heading: string, lines: string[]): string =>
  lines.length ? `## ${heading}\n${lines.join("\n")}` : "";

const renderSemanticMemory = (memory: SemanticMemory): string => {
  const operationalState = memory.currentState
    ? [
        `- Current state: ${memory.currentState.summary}`,
        ...(memory.currentState.lastValidatedResult
          ? [`- Last validated result: ${memory.currentState.lastValidatedResult}`]
          : []),
        ...(memory.currentState.nextAction
          ? [`- Next action: ${memory.currentState.nextAction}`]
          : []),
      ]
    : [];
  const sections = [
    section("Operational State", operationalState),
    section("Current Goals", memory.goals.map((item) => `- [${item.status}] ${item.text}`)),
    section("Active Decisions", memory.decisions.flatMap((item) => [
      `- [${item.status}] Decision: ${item.decision}`,
      ...(item.rationale ? [`  Rationale: ${item.rationale}`] : []),
    ])),
    section("Rejected Approaches", memory.rejectedApproaches.flatMap((item) => [
      `- Approach: ${item.approach}`,
      ...(item.reason ? [`  Reason: ${item.reason}`] : []),
    ])),
    section("Open Questions", memory.openQuestions.map((item) => `- [${item.status}] ${item.question}`)),
    section("Blockers", memory.blockers.map((item) => `- [${item.status}] ${item.text}`)),
    section("User Preferences", memory.preferences.map((item) => `- ${item.text}`)),
  ].filter(Boolean);
  if (!sections.length) return "";
  return `${SEMANTIC_SUMMARY_MARKER}\n# OPERATIONAL STATE\n\n${sections.join("\n\n")}`;
};

export const stripSemanticSummary = (summary: string | undefined): string | undefined => {
  if (!summary) return summary;
  if (summary.startsWith(SEMANTIC_SUMMARY_MARKER)) {
    const separator = "\n\n---\n\n";
    const separatorIndex = summary.indexOf(separator);
    return separatorIndex >= 0
      ? summary.slice(separatorIndex + separator.length).trimStart()
      : "";
  }
  const markerIndex = summary.lastIndexOf(`\n\n${SEMANTIC_SUMMARY_MARKER}`);
  if (markerIndex < 0) return summary;
  return summary.slice(0, markerIndex).trimEnd();
};

const ITEM_LIMITS = Object.entries(SemanticMemorySchema.properties)
  .flatMap(([key, schema]) => {
    const maxItems = (schema as { maxItems?: number }).maxItems;
    return maxItems ? [`${key} ${maxItems}`] : [];
  })
  .join(", ");

const SYSTEM_PROMPT = `You maintain a compact semantic memory for a software-development session.

Extract only information explicitly supported by the supplied conversation. Do not invent facts,
decisions, motivations, results, or user preferences. Distinguish carefully between proposed,
discussed, tested, accepted, active, rejected, superseded, and unresolved. A proposal is not a
decision. A test is not necessarily successful. A discussed configuration is not necessarily active.

Entries with role "thinking" are the assistant's private reasoning: hypotheses, not facts. Use them
only to recover rationales, rejected alternatives and their reasons, and open questions. Never treat
thinking alone as evidence that something was decided, done, validated, or preferred by the user.
When thinking conflicts with user, assistant, or tool entries, those entries win.

Do not rewrite exact technical records such as commands, paths, ports, model names, benchmark
values, error messages, or file contents. A separate deterministic compiler owns those facts.

Focus only on the current operational state, the last validated result, the next concrete action,
goals, decisions and rationales, rejected approaches and reasons, unresolved questions, blockers,
and durable user workflow preferences. Update the previous memory with the new entries, remove
duplicates, mark superseded or resolved items, and preserve still-relevant previous items.
Closed items (completed goals, superseded decisions, resolved questions and blockers) are shown
once and then removed from the previous memory you receive; do not re-add them. Hard item limits:
${ITEM_LIMITS}. When a category is full, keep the most relevant active items.

Return valid JSON only, with no Markdown or code fences. The API enforces the output schema.
Keep the memory sparse: omit unsupported optional fields and use empty arrays when a category has no durable item.`;

const buildSemanticPrompts = (
  previousMemoryJson: string,
  entriesText: string,
): { system: string; user: string } => ({
  system: SYSTEM_PROMPT,
  user: `Previous semantic memory:

<previous_memory>
${previousMemoryJson}
</previous_memory>

New session entries:

<new_entries>
${entriesText}
</new_entries>

Return the updated semantic memory as valid JSON only.`,
});

export const runSemanticCompaction = async (options: {
  settings: SemanticCompactionSettings;
  model?: string;
  branchEntries: unknown[];
  sources: SemanticMessageSource[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => string;
}): Promise<{ memory: SemanticMemory; rendered: string }> => {
  const now = options.now ?? (() => new Date().toISOString());
  const previous = withoutClosedItems(
    loadSemanticMemory(options.branchEntries) ?? emptySemanticMemory(now()),
  );
  const previousJson = JSON.stringify(previous);
  let input: ReturnType<typeof buildSemanticInput>;
  try {
    input = buildSemanticInput({
      sources: options.sources,
      includeToolMetadata: options.settings.includeToolMetadata,
      maxThinkingChars: options.settings.maxThinkingChars,
      maxInputChars: options.settings.maxInputChars,
      previousMemoryJson: previousJson,
    });
  } catch {
    throw new SemanticCompactionError("insufficient-context");
  }
  if (!input.entries.length) throw new SemanticCompactionError("insufficient-context");

  let content: string;
  try {
    content = await requestSemanticCompletion({
      settings: options.settings,
      model: options.model,
      prompts: buildSemanticPrompts(previousJson, input.text),
      jsonSchema: {
        name: "pi_vcc_semantic_memory",
        schema: SemanticMemorySchema as unknown as Record<string, unknown>,
      },
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    if (error instanceof SemanticClientError) {
      throw new SemanticCompactionError(error.code);
    }
    throw new SemanticCompactionError("network");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new SemanticCompactionError("invalid-json");
  }
  const parsed = parseSemanticMemory(decoded);
  if (!parsed) throw new SemanticCompactionError("schema-validation");
  // Evidence must point at real entries: drop IDs the model invented.
  const knownIds = new Set(
    [
      ...options.branchEntries.map((entry) => (entry as { id?: unknown })?.id),
      ...input.entries.map((entry) => entry.entryId),
    ].filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const memory = normalizeSemanticMemory(parsed, now(), knownIds);
  return { memory, rendered: renderSemanticMemory(memory) };
};

export const semanticFailureCode = (error: unknown): SemanticFailureCode =>
  error instanceof SemanticCompactionError ? error.code : "internal";
