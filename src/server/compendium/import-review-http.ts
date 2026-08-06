import { ImportReviewError, type ReviewAction } from "./import-review.ts";

export type ImportReviewActionRequest = Readonly<{
  action: ReviewAction;
  candidateIds: readonly string[];
  activeRevisionTokens?: Readonly<Record<string, string | null>>;
  resolvedContent?: Record<string, unknown>;
  resolvedContents?: Readonly<Record<string, Record<string, unknown>>>;
}>;

const ACTIONS = new Set<ReviewAction>(["approve", "reject", "merge", "unpublish", "retry"]);
const ALLOWED_KEYS = new Set(["action", "candidateIds", "activeRevisionTokens", "resolvedContent", "resolvedContents"]);

export function parseImportReviewActionRequest(value: unknown): ImportReviewActionRequest {
  if (!isRecord(value) || Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new ImportReviewError("Review action payload contains unknown or malformed fields.");
  }
  if (typeof value.action !== "string" || !ACTIONS.has(value.action as ReviewAction)) {
    throw new ImportReviewError("action must be approve, reject, merge, unpublish, or retry.");
  }
  if (!Array.isArray(value.candidateIds) || value.candidateIds.length < 1 || value.candidateIds.length > 200
      || value.candidateIds.some((id) => typeof id !== "string")) {
    throw new ImportReviewError("candidateIds must contain between 1 and 200 string IDs.");
  }
  const candidateIds = value.candidateIds as string[];
  if (new Set(candidateIds).size !== candidateIds.length) throw new ImportReviewError("candidateIds must not contain duplicates.");
  const hasResolvedContent = Object.hasOwn(value, "resolvedContent");
  const hasResolvedContents = Object.hasOwn(value, "resolvedContents");
  if (value.action !== "merge" && (hasResolvedContent || hasResolvedContents)) {
    throw new ImportReviewError("Resolved content is only accepted for merge actions.");
  }
  if (value.action === "merge" && hasResolvedContent === hasResolvedContents) {
    throw new ImportReviewError("Merge requires exactly one resolvedContent or resolvedContents payload.");
  }
  if (hasResolvedContent && (!isRecord(value.resolvedContent) || candidateIds.length !== 1)) {
    throw new ImportReviewError("resolvedContent is only valid for a single candidate merge.");
  }
  if (hasResolvedContents) {
    if (!isRecordOfRecords(value.resolvedContents)) throw new ImportReviewError("resolvedContents must map candidate IDs to objects.");
    const keys = Object.keys(value.resolvedContents).sort();
    const expected = [...candidateIds].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new ImportReviewError("resolvedContents must contain exactly every selected candidate ID.");
    }
  }
  const hasTokens = Object.hasOwn(value, "activeRevisionTokens");
  if (value.action === "reject" && hasTokens) throw new ImportReviewError("Active revision tokens are not accepted for reject actions.");
  if (value.action !== "reject") {
    if (!isRecord(value.activeRevisionTokens)) throw new ImportReviewError("activeRevisionTokens must map every candidate ID to a revision token or null.");
    const keys = Object.keys(value.activeRevisionTokens).sort();
    const expected = [...candidateIds].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
        || Object.values(value.activeRevisionTokens).some((token) => token !== null && (typeof token !== "string" || !/^rev-[0-9a-f]{64}$/.test(token)))) {
      throw new ImportReviewError("activeRevisionTokens must contain exactly every candidate with a revision ID or null.");
    }
  }
  return {
    action: value.action as ReviewAction,
    candidateIds,
    ...(hasTokens ? { activeRevisionTokens: value.activeRevisionTokens as Record<string, string | null> } : {}),
    ...(hasResolvedContent ? { resolvedContent: value.resolvedContent as Record<string, unknown> } : {}),
    ...(hasResolvedContents ? { resolvedContents: value.resolvedContents as Record<string, Record<string, unknown>> } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordOfRecords(value: unknown): value is Record<string, Record<string, unknown>> {
  return isRecord(value) && Object.values(value).every(isRecord);
}
