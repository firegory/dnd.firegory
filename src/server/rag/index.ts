/**
 * RAG answer pipeline — re-exports for public API.
 */

export { generateAnswer, type AnswerRequest, type AnswerPipelineResult, type RagAnswer } from "./answer";

export {
  buildSystemPrompt,
  buildUserMessage,
  formatRetrievalContext,
  parseLlmResponse,
  resolveContextReferences,
  type AnswerLanguage,
  type SourceCitation,
  type RawLlmClaim,
  type RawLlmResponse,
} from "./format";
