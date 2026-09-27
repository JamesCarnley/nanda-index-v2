-- Opt-in opaque origin evidence retention. Independent of organizations,
-- service projections, ERC-8004 observations and provider liveness.
CREATE TABLE origin_archive_sources (
  source_id text COLLATE "C" PRIMARY KEY CHECK (source_id ~ '^sha256:[0-9a-f]{64}$'),
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  config_json text NOT NULL,
  availability text NOT NULL DEFAULT 'pending' CHECK (availability IN ('pending','available','unavailable')),
  last_attempt_at timestamptz,
  last_result text CHECK (last_result ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

CREATE TABLE origin_archive_blobs (
  digest text PRIMARY KEY CHECK (digest ~ '^0x[0-9a-f]{64}$' AND digest <> ('0x' || repeat('0',64))),
  bytes bytea NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 32768 AND byte_length = octet_length(bytes)),
  retained_at timestamptz NOT NULL
);

CREATE TABLE origin_archive_fetch_jobs (
  source_id text COLLATE "C" NOT NULL REFERENCES origin_archive_sources(source_id),
  kind text NOT NULL CHECK (kind IN ('snapshot','document')),
  digest text NOT NULL CHECK (digest ~ '^0x[0-9a-f]{64}$' AND digest <> ('0x' || repeat('0',64))),
  job_version numeric(78,0) NOT NULL DEFAULT 0 CHECK (job_version >= 0),
  attempts numeric(78,0) NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT 'epoch',
  last_attempt_at timestamptz,
  lease_until timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','retained')),
  reason text CHECK (reason ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  actual_hash text CHECK (actual_hash ~ '^0x[0-9a-f]{64}$'),
  actual_size numeric(78,0) CHECK (actual_size >= 0),
  retained_digest text REFERENCES origin_archive_blobs(digest),
  PRIMARY KEY (source_id, kind, digest),
  CHECK ((state = 'retained') = (retained_digest IS NOT NULL)),
  CHECK (retained_digest IS NULL OR retained_digest = digest),
  CHECK (lease_until IS NULL OR (state = 'pending' AND last_attempt_at IS NOT NULL))
);
CREATE INDEX origin_archive_jobs_due ON origin_archive_fetch_jobs(source_id, next_attempt_at, kind, digest)
  WHERE state = 'pending';

CREATE TABLE origin_archive_snapshots (
  digest text PRIMARY KEY REFERENCES origin_archive_blobs(digest),
  shape_status text NOT NULL CHECK (shape_status IN ('valid','invalid')),
  shape_reason text,
  claimed_json text,
  CHECK ((shape_status = 'valid') = (claimed_json IS NOT NULL)),
  CHECK ((shape_status = 'invalid') = (shape_reason IS NOT NULL))
);

CREATE TABLE origin_archive_snapshot_entries (
  snapshot_digest text NOT NULL REFERENCES origin_archive_snapshots(digest),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
  document_digest text NOT NULL CHECK (document_digest ~ '^0x[0-9a-f]{64}$' AND document_digest <> ('0x' || repeat('0',64))),
  PRIMARY KEY (snapshot_digest, ordinal),
  UNIQUE (snapshot_digest, document_digest)
);
CREATE INDEX origin_archive_entries_document ON origin_archive_snapshot_entries(document_digest, snapshot_digest);
