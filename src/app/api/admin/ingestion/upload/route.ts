import { NextResponse } from "next/server";

import { requireAdmin } from "../../../../../server/auth/session";
import { startIngestion } from "../../../../../server/ingestion/lifecycle";
import {
  ACCESS_TIERS,
  SOURCE_CATEGORIES,
  SOURCE_EDITIONS,
  SOURCE_LANGUAGES,
  type AccessTier,
  type SourceCategory,
  type SourceEdition,
  type SourceLanguage,
} from "../../../../../server/access/retrieval-filter";
import { ContentMetadataValidationError } from "../../../../../server/content/metadata";

const VALID_CATEGORIES = new Set<string>(SOURCE_CATEGORIES);
const VALID_EDITIONS = new Set<string>(SOURCE_EDITIONS);
const VALID_LANGUAGES = new Set<string>(SOURCE_LANGUAGES);
const VALID_TIERS = new Set<string>(ACCESS_TIERS);

const MAX_PDF_SIZE = 1024 * 1024 * 1024; // 1 GB

export async function POST(request: Request) {
  let user;
  try {
    user = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart form data." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "PDF file is required." }, { status: 400 });
  }

  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
  }

  if (file.size > MAX_PDF_SIZE) {
    return NextResponse.json({ error: `File too large. Maximum size is ${MAX_PDF_SIZE / (1024 * 1024 * 1024)} GB.` }, { status: 400 });
  }

  const title = formData.get("title");
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json({ error: "Title is required." }, { status: 400 });
  }

  const category = formData.get("category");
  if (!category || typeof category !== "string" || !VALID_CATEGORIES.has(category)) {
    return NextResponse.json({ error: `Category must be one of: ${SOURCE_CATEGORIES.join(", ")}.` }, { status: 400 });
  }

  const edition = formData.get("edition");
  if (!edition || typeof edition !== "string" || !VALID_EDITIONS.has(edition)) {
    return NextResponse.json({ error: `Edition must be one of: ${SOURCE_EDITIONS.join(", ")}.` }, { status: 400 });
  }

  const language = formData.get("language");
  if (!language || typeof language !== "string" || !VALID_LANGUAGES.has(language)) {
    return NextResponse.json({ error: `Language must be one of: ${SOURCE_LANGUAGES.join(", ")}.` }, { status: 400 });
  }

  const accessTier = formData.get("accessTier");
  if (!accessTier || typeof accessTier !== "string" || !VALID_TIERS.has(accessTier)) {
    return NextResponse.json({ error: `Access tier must be one of: ${ACCESS_TIERS.join(", ")}.` }, { status: 400 });
  }

  try {
    const releaseYear = optionalInteger(formData, "releaseYear");
    const sourcePriority = optionalInteger(formData, "sourcePriority") ?? 0;
    const pdfData = Buffer.from(await file.arrayBuffer());
    const result = await startIngestion({
      title: title.trim(),
      category: category as SourceCategory,
      edition: edition as SourceEdition,
      language: language as SourceLanguage,
      accessTier: accessTier as AccessTier,
      ownerUserId: accessTier === "personal" ? user.id : null,
      canonicalSourceId: optionalText(formData, "canonicalSourceId"),
      publication: {
        code: optionalText(formData, "publicationCode"),
        title: optionalText(formData, "publicationTitle") ?? title.trim(),
        publisher: optionalText(formData, "publisher"),
        releaseYear,
        revision: optionalText(formData, "revision"),
        origin: optionalText(formData, "originUrl") || optionalText(formData, "originId")
          ? { url: optionalText(formData, "originUrl"), id: optionalText(formData, "originId") }
          : null,
        attribution: optionalText(formData, "attribution"),
        sourcePriority,
        canonicalBookId: optionalText(formData, "canonicalBookId"),
      },
      license: optionalText(formData, "license"),
      requestedByUserId: user.id,
      originalFilename: file.name,
      pdfData,
      kind: "upload",
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingestion failed.";
    if (error instanceof ContentMetadataValidationError) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error("Upload ingestion error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function optionalText(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new ContentMetadataValidationError(`${name} must be text.`);
  return value;
}

function optionalInteger(formData: FormData, name: string): number | null {
  const value = optionalText(formData, name);
  if (value === null) return null;
  if (!/^-?\d+$/.test(value)) throw new ContentMetadataValidationError(`${name} must be an integer.`);
  return Number(value);
}
