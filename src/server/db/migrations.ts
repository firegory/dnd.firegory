export const MIGRATION_FILENAMES = [
  "0001_initial_schema.sql",
  "0002_telegram_links.sql",
  "0003_source_publication_metadata.sql",
  "0004_source_publication_constraints.sql",
  "0005_ingestion_generations.sql",
  "0006_ingestion_generation_integrity.sql",
  "0007_compendium_relational_core.sql",
  // 0008 and 0009 are reserved by issues #75 and #81.
  "0010_nfs_content_index_sync.sql",
] as const;

export type MigrationFilename = (typeof MIGRATION_FILENAMES)[number];
