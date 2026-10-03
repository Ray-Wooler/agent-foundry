BEGIN;

CREATE TABLE frankai_registration_attempts (
  publication_record_id uuid PRIMARY KEY REFERENCES publication_records(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  request_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'IN_FLIGHT'
    CHECK (status IN ('IN_FLIGHT','REGISTERED','FAILED')),
  response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  registration_reference text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
