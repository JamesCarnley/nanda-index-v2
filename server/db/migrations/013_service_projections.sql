CREATE TABLE service_projections (
  source_id text COLLATE "C" NOT NULL,
  identifier text COLLATE "C" NOT NULL,
  source_kind text NOT NULL,
  org_id text REFERENCES organizations(org_id) ON DELETE CASCADE,
  display_name text NOT NULL,
  media_type text NOT NULL,
  url text NOT NULL,
  description text,
  capability_ids text[] NOT NULL DEFAULT '{}',
  area_served text[] NOT NULL DEFAULT '{}',
  interfaces text[] NOT NULL DEFAULT '{}',
  source_revision text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, identifier)
);

CREATE INDEX service_projection_page ON service_projections(identifier, source_id);
CREATE INDEX service_projection_capability ON service_projections USING gin(capability_ids);
CREATE INDEX service_projection_area ON service_projections USING gin(area_served);
CREATE INDEX service_projection_interface ON service_projections USING gin(interfaces);
