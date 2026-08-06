import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const Id = Type.String({ minLength: 1, maxLength: 80 });
const Text = Type.String({ minLength: 1, maxLength: 240 });
const EvidenceIds = Type.Optional(Type.Array(Id, { maxItems: 4 }));

const SemanticGoalSchema = Type.Object({
  id: Id,
  text: Text,
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("completed"),
    Type.Literal("paused"),
  ]),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const SemanticDecisionSchema = Type.Object({
  id: Id,
  decision: Text,
  rationale: Type.Optional(Text),
  status: Type.Union([
    Type.Literal("proposed"),
    Type.Literal("tested"),
    Type.Literal("active"),
    Type.Literal("superseded"),
  ]),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const RejectedApproachSchema = Type.Object({
  id: Id,
  approach: Text,
  reason: Type.Optional(Text),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const OpenQuestionSchema = Type.Object({
  id: Id,
  question: Text,
  status: Type.Union([Type.Literal("open"), Type.Literal("resolved")]),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const BlockerSchema = Type.Object({
  id: Id,
  text: Text,
  status: Type.Union([Type.Literal("active"), Type.Literal("resolved")]),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const UserPreferenceSchema = Type.Object({
  id: Id,
  text: Text,
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const CurrentStateSchema = Type.Optional(Type.Object({
  summary: Text,
  lastValidatedResult: Type.Optional(Text),
  nextAction: Type.Optional(Text),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false }));

export const SemanticMemorySchema = Type.Object({
  schemaVersion: Type.Literal(1),
  updatedAt: Type.String({ minLength: 1, maxLength: 40 }),
  currentState: CurrentStateSchema,
  goals: Type.Array(SemanticGoalSchema, { maxItems: 3 }),
  decisions: Type.Array(SemanticDecisionSchema, { maxItems: 5 }),
  rejectedApproaches: Type.Array(RejectedApproachSchema, { maxItems: 3 }),
  openQuestions: Type.Array(OpenQuestionSchema, { maxItems: 3 }),
  blockers: Type.Array(BlockerSchema, { maxItems: 3 }),
  preferences: Type.Array(UserPreferenceSchema, { maxItems: 5 }),
}, { additionalProperties: false });

export type SemanticMemory = Static<typeof SemanticMemorySchema>;

export const parseSemanticMemory = (value: unknown): SemanticMemory | null =>
  Check(SemanticMemorySchema, value) ? value : null;

export const emptySemanticMemory = (updatedAt = new Date().toISOString()): SemanticMemory => ({
  schemaVersion: 1,
  updatedAt,
  currentState: undefined,
  goals: [],
  decisions: [],
  rejectedApproaches: [],
  openQuestions: [],
  blockers: [],
  preferences: [],
});
