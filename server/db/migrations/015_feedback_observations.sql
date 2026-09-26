-- Independent of identity eligibility, organization/search rows and provider availability.
CREATE TABLE feedback_sources (
  source_id text COLLATE "C" PRIMARY KEY CHECK (source_id ~ '^sha256:[0-9a-f]{64}$'),
  source_fingerprint text NOT NULL,
  source_json text NOT NULL,
  state_version numeric(78,0) NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  generation numeric(78,0) NOT NULL DEFAULT 0 CHECK (generation >= 0),
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','unavailable')),
  checkpoint_json text,
  checkpoint_number numeric(78,0) CHECK (checkpoint_number >= 0),
  head_json text,
  finalized_json text,
  rebuilding_through numeric(78,0) CHECK (rebuilding_through >= 0),
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  CHECK ((checkpoint_json IS NULL) = (checkpoint_number IS NULL)),
  CHECK (checkpoint_json IS NULL OR (checkpoint_json::jsonb->>'number')::numeric = checkpoint_number)
);
CREATE TABLE feedback_events (
  event_id text COLLATE "C" PRIMARY KEY CHECK (event_id ~ '^sha256:[0-9a-f]{64}$'),
  source_id text COLLATE "C" NOT NULL REFERENCES feedback_sources(source_id),
  insertion_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  block_number numeric(78,0) NOT NULL CHECK (block_number BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_index numeric(20,0) NOT NULL CHECK (transaction_index BETWEEN 0 AND 18446744073709551615),
  log_index numeric(20,0) NOT NULL CHECK (log_index BETWEEN 0 AND 18446744073709551615),
  agent_id numeric(78,0) NOT NULL CHECK (agent_id BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935),
  reviewer text NOT NULL CHECK (reviewer ~ '^0x[0-9a-f]{40}$'),
  feedback_index numeric(20,0) NOT NULL CHECK (feedback_index BETWEEN 1 AND 18446744073709551615),
  kind text NOT NULL CHECK (kind IN ('NewFeedback','FeedbackRevoked','ResponseAppended')),
  raw_json text NOT NULL,
  decoded_json text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, event_id),
  UNIQUE (source_id, block_hash, log_index)
);
CREATE INDEX feedback_events_history ON feedback_events(source_id, agent_id, block_number, transaction_index, log_index, event_id);
CREATE TABLE feedback_membership (
  source_id text COLLATE "C" NOT NULL,
  event_id text COLLATE "C" NOT NULL,
  generation numeric(78,0) NOT NULL CHECK (generation >= 0),
  status text NOT NULL CHECK (status IN ('canonical','withdrawn','orphaned')),
  PRIMARY KEY (source_id, event_id, generation),
  FOREIGN KEY (source_id, event_id) REFERENCES feedback_events(source_id, event_id)
);
CREATE INDEX feedback_membership_current ON feedback_membership(source_id, generation, status, event_id);
CREATE TABLE feedback_documents (
  document_hash text PRIMARY KEY CHECK (document_hash ~ '^0x[0-9a-f]{64}$' AND document_hash <> '0x' || repeat('0',64)),
  bytes bytea NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 6144 AND byte_length = octet_length(bytes)),
  retained_at timestamptz NOT NULL
);
CREATE TABLE feedback_fetch_jobs (
  event_id text COLLATE "C" PRIMARY KEY,
  source_id text COLLATE "C" NOT NULL,
  -- JSON text retains every UTF-8 string, including NUL, without PostgreSQL text loss.
  feedback_uri_json text NOT NULL,
  feedback_hash text NOT NULL CHECK (feedback_hash ~ '^0x[0-9a-f]{64}$'),
  job_version numeric(78,0) NOT NULL DEFAULT 0 CHECK (job_version >= 0),
  attempts numeric(78,0) NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT 'epoch',
  last_attempt_at timestamptz,
  lease_until timestamptz,
  state text NOT NULL CHECK (state IN ('pending','retained','blocked')),
  reason text CHECK (reason ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  actual_hash text CHECK (actual_hash ~ '^0x[0-9a-f]{64}$'),
  actual_size numeric(78,0) CHECK (actual_size >= 0),
  retained_hash text REFERENCES feedback_documents(document_hash),
  FOREIGN KEY (source_id, event_id) REFERENCES feedback_events(source_id, event_id),
  CHECK ((state = 'retained') = (retained_hash IS NOT NULL)),
  CHECK (retained_hash IS NULL OR retained_hash = feedback_hash),
  CHECK (lease_until IS NULL OR (state = 'pending' AND last_attempt_at IS NOT NULL)),
  CHECK (state <> 'blocked' OR reason IS NOT NULL)
);
CREATE INDEX feedback_jobs_due ON feedback_fetch_jobs(source_id, next_attempt_at, event_id) WHERE state = 'pending';
