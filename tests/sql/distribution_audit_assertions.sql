-- Phase 6 post-live audit and immutability assertions.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_records WHERE action='release_package_created') THEN
    RAISE EXCEPTION 'missing release_package_created audit record';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_records WHERE action='release_published') THEN
    RAISE EXCEPTION 'missing release_published audit record';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_records WHERE action='frankai_release_registered') THEN
    RAISE EXCEPTION 'missing frankai_release_registered audit record';
  END IF;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE release_package_records SET package_location='tampered';
    RAISE EXCEPTION 'expected immutable release package record';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected immutable release package record' THEN RAISE; END IF;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE publication_records SET external_reference='tampered';
    RAISE EXCEPTION 'expected immutable publication record';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected immutable publication record' THEN RAISE; END IF;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE frankai_registration_records SET registration_reference='tampered';
    RAISE EXCEPTION 'expected immutable registration record';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='expected immutable registration record' THEN RAISE; END IF;
  END;
END $$;

DO $$ BEGIN
  IF (SELECT count(*) FROM release_package_records) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one package record after idempotent retries';
  END IF;
  IF (SELECT count(*) FROM publication_records) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one publication record after idempotent retries';
  END IF;
  IF (SELECT count(*) FROM frankai_registration_records) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one FrankAI registration record after idempotent retries';
  END IF;
END $$;
