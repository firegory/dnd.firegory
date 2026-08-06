export const MIGRATION_FILENAMES = [
  "0001_initial_schema.sql",
  "0002_telegram_links.sql",
  "0003_source_publication_metadata.sql",
  "0004_source_publication_constraints.sql",
  "0005_ingestion_generations.sql",
  "0006_ingestion_generation_integrity.sql",
] as const;

export type MigrationFilename = (typeof MIGRATION_FILENAMES)[number];
