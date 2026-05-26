import type { UserRole } from "../auth/types";
import { query } from "../db/client";

export type { UserRole } from "../auth/types";

export const ACCESS_TIERS = ["open", "premium", "personal"] as const;
export type AccessTier = (typeof ACCESS_TIERS)[number];

export const SOURCE_CATEGORIES = [
  "core_rules",
  "official_supplement",
  "homebrew",
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

export const SOURCE_EDITIONS = ["5e", "5.5e"] as const;
export type SourceEdition = (typeof SOURCE_EDITIONS)[number];

export const SOURCE_LANGUAGES = ["en", "ru"] as const;
export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number];

export type RetrievalUser = Readonly<{
  role: UserRole;
  userId?: string;
}>;

export type RetrievalSelection = Readonly<{
  edition?: SourceEdition;
  language?: SourceLanguage;
  category?: SourceCategory;
}>;

export type SourceAccessClause =
  | Readonly<{ accessTier: "open" }>
  | Readonly<{ accessTier: "premium"; shared: true }>
  | Readonly<{ accessTier: "personal"; ownerUserId: string }>;

export type RetrievalAuthorizationFilter = Readonly<{
  edition?: SourceEdition;
  language?: SourceLanguage;
  category?: SourceCategory;
  access:
    | Readonly<{ kind: "all" }>
    | Readonly<{ kind: "anyOf"; clauses: readonly SourceAccessClause[] }>;
}>;

type CorpusMetadata = Readonly<{
  edition?: SourceEdition;
  language?: SourceLanguage;
  category?: SourceCategory;
}>;

export type SourceAccessMetadata = CorpusMetadata &
  (
    | Readonly<{ accessTier: "open"; shared?: false; ownerUserId?: null }>
    | Readonly<{ accessTier: "premium"; shared: boolean; ownerUserId?: null }>
    | Readonly<{ accessTier: "personal"; shared?: false; ownerUserId: string }>
  );

/**
 * Builds the server-owned retrieval authorization filter.
 *
 * Client/search input is deliberately limited to corpus narrowing fields
 * (edition, language, category). Role, premium sharing, and ownership are
 * derived only from the authenticated server-side user context so callers
 * cannot widen access by passing arbitrary filter params.
 */
export function buildRetrievalAuthorizationFilter(
  user: RetrievalUser,
  selection: RetrievalSelection = {},
): RetrievalAuthorizationFilter {
  return {
    ...copySelectedCorpusFilters(selection),
    access: buildAccessFilter(user),
  };
}

function copySelectedCorpusFilters(
  selection: RetrievalSelection,
): Pick<RetrievalAuthorizationFilter, "edition" | "language" | "category"> {
  return {
    ...(selection.edition ? { edition: selection.edition } : {}),
    ...(selection.language ? { language: selection.language } : {}),
    ...(selection.category ? { category: selection.category } : {}),
  };
}

function buildAccessFilter(
  user: RetrievalUser,
): RetrievalAuthorizationFilter["access"] {
  if (user.role === "admin") {
    return { kind: "all" };
  }

  if (user.role === "premium") {
    return {
      kind: "anyOf",
      clauses: [
        { accessTier: "open" },
        { accessTier: "premium", shared: true },
        ...(user.userId
          ? ([{ accessTier: "personal", ownerUserId: user.userId }] as const)
          : []),
      ],
    };
  }

  return {
    kind: "anyOf",
    clauses: [{ accessTier: "open" }],
  };
}

export function sourceMatchesRetrievalAuthorizationFilter(
  source: SourceAccessMetadata,
  filter: RetrievalAuthorizationFilter,
): boolean {
  if (filter.edition && source.edition !== filter.edition) {
    return false;
  }

  if (filter.language && source.language !== filter.language) {
    return false;
  }

  if (filter.category && source.category !== filter.category) {
    return false;
  }

  if (filter.access.kind === "all") {
    return true;
  }

  return filter.access.clauses.some((clause) => sourceMatchesAccessClause(source, clause));
}

function sourceMatchesAccessClause(
  source: SourceAccessMetadata,
  clause: SourceAccessClause,
): boolean {
  if (clause.accessTier === "open") {
    return source.accessTier === "open";
  }

  if (clause.accessTier === "premium") {
    return source.accessTier === "premium" && source.shared === true;
  }

  return source.accessTier === "personal" && source.ownerUserId === clause.ownerUserId;
}

export async function getAccessibleSourceIds(
  user: RetrievalUser,
): Promise<string[]> {
  if (user.role === "admin") {
    const result = await query<{ id: string }>(
      "SELECT id FROM sources WHERE deleted_at IS NULL",
    );
    return result.rows.map((r) => r.id);
  }

  const clauses = buildAccessFilter(user);
  if (clauses.kind === "all") {
    const result = await query<{ id: string }>(
      "SELECT id FROM sources WHERE deleted_at IS NULL",
    );
    return result.rows.map((r) => r.id);
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const clause of clauses.clauses) {
    if (clause.accessTier === "open") {
      conditions.push(`(access_tier = 'open')`);
    } else if (clause.accessTier === "premium") {
      conditions.push(`(access_tier = 'premium' AND shared = true)`);
    } else if (clause.accessTier === "personal" && user.userId) {
      conditions.push(`(access_tier = 'personal' AND owner_user_id = $${paramIdx++})`);
      values.push(user.userId);
    }
  }

  if (conditions.length === 0) return [];

  const sql = `SELECT id FROM sources WHERE deleted_at IS NULL AND (${conditions.join(" OR ")})`;
  const result = await query<{ id: string }>(sql, values);
  return result.rows.map((r) => r.id);
}
