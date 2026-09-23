CREATE TABLE identity_sources (
  source_id text COLLATE "C" PRIMARY KEY,
  source_fingerprint text NOT NULL,
  confirmations integer NOT NULL CHECK (confirmations >= 0),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'unavailable')),
  rebuilding boolean NOT NULL DEFAULT false,
  checkpoint_number bigint, checkpoint_hash text, checkpoint_timestamp bigint,
  head_number bigint, head_hash text, head_timestamp bigint,
  finalized_number bigint, finalized_hash text, finalized_timestamp bigint,
  last_success_at timestamptz, last_attempt_at timestamptz,
  CHECK ((checkpoint_number IS NULL) = (checkpoint_hash IS NULL)
    AND (checkpoint_number IS NULL) = (checkpoint_timestamp IS NULL)),
  CHECK ((head_number IS NULL) = (head_hash IS NULL)
    AND (head_number IS NULL) = (head_timestamp IS NULL)),
  CHECK ((finalized_number IS NULL) = (finalized_hash IS NULL)
    AND (finalized_number IS NULL) = (finalized_timestamp IS NULL))
);

CREATE TABLE identity_observations (
  observation_id text PRIMARY KEY CHECK (observation_id ~ '^sha256:[0-9a-f]{64}$'),
  source_id text COLLATE "C" NOT NULL REFERENCES identity_sources(source_id),
  generation bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  agent_id text COLLATE "C" NOT NULL,
  observation_json text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, generation, block_hash, agent_id),
  UNIQUE (source_id, observation_id)
);

CREATE TABLE identity_latest (
  source_id text COLLATE "C" NOT NULL REFERENCES identity_sources(source_id),
  agent_id text COLLATE "C" NOT NULL,
  observation_id text NOT NULL,
  PRIMARY KEY (source_id, agent_id),
  FOREIGN KEY (source_id, observation_id)
    REFERENCES identity_observations(source_id, observation_id)
);

ALTER TABLE service_projections ADD COLUMN observation_id text;
ALTER TABLE service_projections ADD CONSTRAINT service_projection_writer_shape CHECK (
  (source_kind = 'organization-declaration' AND org_id IS NOT NULL
    AND source_id = 'org:' || org_id AND observation_id IS NULL)
  OR
  (source_kind = 'erc8004-identity' AND org_id IS NULL
    AND source_id LIKE 'erc8004-identity:%' AND observation_id IS NOT NULL)
);
ALTER TABLE service_projections ADD CONSTRAINT service_projection_identity_observation_fk
  FOREIGN KEY (source_id, observation_id)
  REFERENCES identity_observations(source_id, observation_id);

CREATE INDEX identity_observations_subject ON identity_observations(source_id, agent_id, block_number);
