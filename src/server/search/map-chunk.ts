export type ChunkCitation = Readonly<{
  chunkId: string;
  sourceId: string;
  fileId: string;
  text: string;
  quoteText: string;
  sectionHeading: string | null;
  pageNumber: number | null;
  edition: string;
  language: string;
  sourceTitle: string;
  sourceCategory: string;
  accessTier: string;
}>;

export type SearchChunkRow = Readonly<{
  id: string;
  source_id: string;
  file_id: string;
  text: string;
  quote_text: string;
  section_heading: string | null;
  page_number: number | null;
  title: string;
  category: string;
  edition: string;
  language: string;
  access_tier: string;
}>;

export function mapSearchChunk(row: SearchChunkRow): ChunkCitation {
  return {
    chunkId: row.id,
    sourceId: row.source_id,
    fileId: row.file_id,
    text: row.text,
    quoteText: row.quote_text,
    sectionHeading: row.section_heading,
    pageNumber: row.page_number,
    edition: row.edition,
    language: row.language,
    sourceTitle: row.title,
    sourceCategory: row.category,
    accessTier: row.access_tier,
  };
}
