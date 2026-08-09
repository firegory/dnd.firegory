-- Historical canonical species revisions can predate the explicit hierarchy
-- discriminator. A non-empty exact parent list is the legacy variant encoding.
CREATE OR REPLACE FUNCTION nfs_index_validate_option_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actual_kind text; source_kind text; valid_trait_override boolean;
  target_is_species boolean; target_kind_present boolean; source_is_species boolean; source_kind_present boolean;
BEGIN
  SELECT CASE
    WHEN target.entry_id LIKE 'class-%' THEN coalesce(fields.values->>'kind','class')
    WHEN target.entry_id LIKE 'species-%' THEN CASE
      WHEN fields.values ? 'kind' THEN fields.values->>'kind'
      WHEN jsonb_typeof(fields.values->'parent-species-ids') = 'array'
        AND jsonb_array_length(fields.values->'parent-species-ids') > 0 THEN 'variant'
      ELSE 'species' END
    WHEN target.entry_id LIKE 'feature-%' THEN 'feature'
    ELSE 'other' END,
    CASE WHEN source.entry_id LIKE 'class-%' THEN coalesce(source_fields.values->>'kind','class')
      WHEN source.entry_id LIKE 'species-%' THEN CASE
        WHEN source_fields.values ? 'kind' THEN source_fields.values->>'kind'
        WHEN jsonb_typeof(source_fields.values->'parent-species-ids') = 'array'
          AND jsonb_array_length(source_fields.values->'parent-species-ids') > 0 THEN 'variant'
        ELSE 'species' END
      ELSE 'other' END,
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(coalesce(source_fields.values->'traits','[]'::jsonb)) source_trait(value)
      JOIN LATERAL jsonb_array_elements_text(coalesce(fields.values->'traits','[]'::jsonb)) target_trait(value)
        ON (target_trait.value::jsonb)->>'key' = (source_trait.value::jsonb)->>'overrides'
      WHERE (source_trait.value::jsonb)->>'anchor' = NEW.source_anchor
        AND (target_trait.value::jsonb)->>'anchor' = NEW.anchor
    ), target.entry_id LIKE 'species-%', fields.values ? 'kind', source.entry_id LIKE 'species-%', source_fields.values ? 'kind'
    INTO actual_kind, source_kind, valid_trait_override, target_is_species, target_kind_present, source_is_species, source_kind_present
  FROM nfs_index_entries source
  JOIN sources source_meta ON source_meta.id = source.source_id
  JOIN nfs_index_entries target ON target.repository_id = NEW.repository_id
    AND target.entry_id = NEW.target_entry_id AND target.revision_id = NEW.target_revision_id
    AND target.source_id = NEW.target_source_id AND target.file_id = NEW.target_file_id
  JOIN sources target_meta ON target_meta.id = target.source_id
  CROSS JOIN LATERAL (SELECT coalesce(jsonb_object_agg(field->>'key',field->'value'),'{}') AS values
    FROM jsonb_array_elements(target.typed_fields) field) fields
  CROSS JOIN LATERAL (SELECT coalesce(jsonb_object_agg(field->>'key',field->'value'),'{}') AS values
    FROM jsonb_array_elements(source.typed_fields) field) source_fields
  WHERE source.repository_id = NEW.repository_id AND source.entry_id = NEW.source_entry_id
    AND source.revision_id = NEW.source_revision_id AND source.source_id = NEW.source_id AND source.file_id = NEW.source_file_id
    AND source.lifecycle = 'active' AND target.lifecycle = 'active'
    AND source.source_id = target.source_id AND source_meta.edition = target_meta.edition
    AND source_meta.language = target_meta.language AND source_meta.edition = NEW.edition
    AND source_meta.language = NEW.language;
  IF target_is_species AND target_kind_present AND (actual_kind IS NULL OR actual_kind NOT IN ('species','variant')) THEN
    RAISE EXCEPTION 'NFS option relation target must be an exact active same-corpus version with matching kind';
  END IF;
  IF source_is_species AND source_kind_present AND (source_kind IS NULL OR source_kind NOT IN ('species','variant')) THEN
    RAISE EXCEPTION 'NFS option relation source has an invalid explicit species kind';
  END IF;
  IF actual_kind IS NULL OR actual_kind <> NEW.target_kind THEN
    RAISE EXCEPTION 'NFS option relation target must be an exact active same-corpus version with matching kind';
  END IF;
  IF NEW.relation_kind = 'parent' AND NOT (
    source_kind = 'subclass' AND actual_kind = 'class' OR source_kind = 'variant' AND actual_kind = 'species'
  ) THEN RAISE EXCEPTION 'NFS hierarchy parents must directly target a base class or species'; END IF;
  IF NEW.relation_kind = 'trait_override' AND NOT (
    source_kind = 'variant' AND actual_kind = 'species' AND valid_trait_override
  ) THEN RAISE EXCEPTION 'NFS trait overrides must link an exact child trait to its exact base parent trait anchor'; END IF;
  RETURN NEW;
END $$;
