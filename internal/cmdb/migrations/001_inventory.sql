CREATE TABLE assets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('chassis','host','cluster','vm','business')),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
    platform text NOT NULL DEFAULT '' CHECK (platform IN ('','pve','kvm')),
    status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','online','offline','running','stopped','paused')),
    lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','retired')),
    owner text NOT NULL DEFAULT '',
    environment text NOT NULL DEFAULT '',
    address text NOT NULL DEFAULT '',
    cpu integer NOT NULL DEFAULT 0 CHECK (cpu >= 0),
    memory_mib bigint NOT NULL DEFAULT 0 CHECK (memory_mib >= 0),
    notes text NOT NULL DEFAULT '',
    attributes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object'),
    observed jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(observed) = 'object'),
    source_key text,
    external_key text,
    last_seen_at timestamptz,
    missing_count integer NOT NULL DEFAULT 0,
    version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_key, external_key),
    CHECK ((source_key IS NULL) = (external_key IS NULL))
);

CREATE INDEX assets_kind_name_idx ON assets (kind, lower(name), id);
CREATE INDEX assets_attributes_idx ON assets USING GIN (attributes);

CREATE TABLE asset_links (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_id bigint NOT NULL REFERENCES assets,
    to_id bigint NOT NULL REFERENCES assets,
    kind text NOT NULL CHECK (kind IN ('contains','member','hosts','uses')),
    source_key text,
    UNIQUE (from_id, to_id, kind),
    CHECK (from_id <> to_id)
);

CREATE UNIQUE INDEX asset_links_single_parent_idx
ON asset_links (to_id, kind) WHERE kind IN ('contains','member','hosts');
CREATE INDEX asset_links_to_idx ON asset_links (to_id);

CREATE TABLE changes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id bigint NOT NULL REFERENCES assets,
    asset_name text NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    before_data jsonb,
    after_data jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX changes_asset_id_idx ON changes (asset_id, id DESC);

CREATE TABLE users (
    username text PRIMARY KEY,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin','operator','viewer'))
);

CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY,
    username text NOT NULL REFERENCES users ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

CREATE TABLE sync_runs (
    source_key text PRIMARY KEY,
    platform text NOT NULL CHECK (platform IN ('pve','kvm')),
    status text NOT NULL CHECK (status IN ('ok','failed')),
    message text NOT NULL DEFAULT '',
    resource_count integer NOT NULL DEFAULT 0,
    finished_at timestamptz NOT NULL DEFAULT now(),
    last_success_at timestamptz
);
