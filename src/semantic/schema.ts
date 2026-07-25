import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const EvidenceIds = Type.Optional(Type.Array(Type.String({ minLength: 1 })));

const SemanticGoalSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  text: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("completed"),
    Type.Literal("paused"),
  ]),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const SemanticDecisionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  decision: Type.String({ minLength: 1 }),
  rationale: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Union([
    Type.Literal("proposed"),
    Type.Literal("tested"),
    Type.Literal("active"),
    Type.Literal("superseded"),
  ]),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const RejectedApproachSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  approach: Type.String({ minLength: 1 }),
  reason: Type.Optional(Type.String({ minLength: 1 })),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const OpenQuestionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  question: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("open"), Type.Literal("resolved")]),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const BlockerSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  text: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("active"), Type.Literal("resolved")]),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

const UserPreferenceSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  text: Type.String({ minLength: 1 }),
  evidenceEntryIds: EvidenceIds,
}, { additionalProperties: false });

export const SemanticMemorySchema = Type.Object({
  schemaVersion: Type.Literal(1),
  updatedAt: Type.String({ minLength: 1 }),
  goals: Type.Array(SemanticGoalSchema),
  decisions: Type.Array(SemanticDecisionSchema),
  rejectedApproaches: Type.Array(RejectedApproachSchema),
  openQuestions: Type.Array(OpenQuestionSchema),
  blockers: Type.Array(BlockerSchema),
  preferences: Type.Array(UserPreferenceSchema),
}, { additionalProperties: false });

export type SemanticMemory = Static<typeof SemanticMemorySchema>;

export const parseSemanticMemory = (value: unknown): SemanticMemory | null =>
  Check(SemanticMemorySchema, value) ? value : null;

export const emptySemanticMemory = (updatedAt = new Date().toISOString()): SemanticMemory => ({
  schemaVersion: 1,
  updatedAt,
  goals: [],
  decisions: [],
  rejectedApproaches: [],
  openQuestions: [],
  blockers: [],
  preferences: [],
});
