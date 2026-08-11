/**
 * RAG answer pipeline — re-exports for public API.
 */

export { generateAnswer, type AnswerRequest, type AnswerPipelineResult, type RagAnswer } from "./answer";

export {
  buildSystemPrompt,
  buildUserMessage,
  formatRetrievalContext,
  parseLlmResponse,
  evidenceSegments,
  resolveSegmentSelections,
  type AnswerLanguage,
  type EvidenceSegment,
  type SourceCitation,
  type RawLlmResponse,
} from "./format";
