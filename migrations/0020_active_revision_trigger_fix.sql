-- Branch before accessing table-specific NEW fields. A CASE expression resolves
-- both record fields and fails on compendium_versions, which has no version_id.
CREATE OR REPLACE FUNCTION compendium_validate_active_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_version uuid;
  version_lifecycle compendium_version_lifecycle;
  active_revision uuid;
  active_type compendium_entry_type;
  active_lifecycle compendium_revision_lifecycle;
BEGIN
  IF TG_TABLE_NAME = 'compendium_versions' THEN
    target_version := NEW.id;
  ELSE
    target_version := NEW.version_id;
  END IF;

  SELECT v.lifecycle, v.active_revision_id
    INTO version_lifecycle, active_revision
  FROM compendium_versions v WHERE v.id = target_version;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT r.entry_type, r.lifecycle INTO active_type, active_lifecycle
  FROM compendium_revisions r
  WHERE r.id = active_revision AND r.version_id = target_version;
  IF active_type IS NULL THEN
    RAISE EXCEPTION 'every compendium version requires its own active revision';
  END IF;
  IF (version_lifecycle = 'draft' AND active_lifecycle <> 'draft')
     OR (version_lifecycle IN ('published', 'retired') AND active_lifecycle <> 'published') THEN
    RAISE EXCEPTION 'active revision lifecycle must match its version lifecycle';
  END IF;
  IF NOT compendium_revision_has_projection(active_revision, active_type) THEN
    RAISE EXCEPTION 'an active revision requires its matching typed projection';
  END IF;
  RETURN NEW;
END $$;
