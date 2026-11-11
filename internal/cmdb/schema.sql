-- dc-db SQLite schema.
--
-- Executed once when a database file is created. This project is still in
-- development; after changing the schema, remove the local dc-db.db and let the
-- next start recreate it from this file.

CREATE TABLE assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('host','vm','switch')),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
    platform TEXT NOT NULL DEFAULT '' CHECK (platform IN ('','pve','kvm')),
    status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','online','offline','running','stopped','paused')),
    lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','retired')),
    owner TEXT NOT NULL DEFAULT '',
    environment TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    cpu INTEGER NOT NULL DEFAULT 0 CHECK (cpu >= 0),
    memory_mib INTEGER NOT NULL DEFAULT 0 CHECK (memory_mib >= 0),
    notes TEXT NOT NULL DEFAULT '',
    attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes) AND json_type(attributes) = 'object'),
    observed TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(observed) AND json_type(observed) = 'object'),
    source_key TEXT,
    external_key TEXT,
    last_seen_at TIMESTAMP,
    missing_count INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE (source_key, external_key),
    CHECK ((source_key IS NULL) = (external_key IS NULL))
);

CREATE INDEX assets_kind_name_idx ON assets (kind, lower(name), id);

CREATE TABLE asset_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL REFERENCES assets,
    to_id INTEGER NOT NULL REFERENCES assets,
    kind TEXT NOT NULL CHECK (kind IN ('hosts')),
    source_key TEXT,
    UNIQUE (from_id, to_id, kind),
    CHECK (from_id <> to_id)
);

CREATE UNIQUE INDEX asset_links_single_parent_idx
ON asset_links (to_id, kind) WHERE kind = 'hosts';
CREATE INDEX asset_links_to_idx ON asset_links (to_id);

CREATE TABLE vlans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vid INTEGER NOT NULL CHECK (vid BETWEEN 1 AND 4094),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reserved','deprecated')),
    description TEXT NOT NULL DEFAULT '',
    room_id INTEGER REFERENCES rooms ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX vlans_vid_idx ON vlans (vid);
CREATE UNIQUE INDEX vlans_name_idx ON vlans (lower(name));

CREATE TABLE subnets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
    cidr TEXT NOT NULL UNIQUE,
    gateway TEXT NOT NULL DEFAULT '',
    vlan TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('container','active','reserved','deprecated')),
    role TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE ip_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subnet_id INTEGER NOT NULL REFERENCES subnets ON DELETE CASCADE,
    ip TEXT NOT NULL,
    asset_id INTEGER REFERENCES assets,
    label TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reserved','deprecated','dhcp','slaac')),
    dns_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '' CHECK (role IN ('','loopback','secondary','vip','vrrp','hsrp','glbp','anycast')),
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE (subnet_id, ip)
);

CREATE INDEX ip_allocations_subnet_idx ON ip_allocations (subnet_id, ip);

CREATE TABLE changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER REFERENCES assets,
    asset_name TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    before_data TEXT,
    after_data TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX changes_asset_id_idx ON changes (asset_id, id DESC);

CREATE TABLE users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer'))
);

CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY,
    username TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
    expires_at TIMESTAMP NOT NULL
);

CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
    grid_columns INTEGER NOT NULL CHECK (grid_columns BETWEEN 1 AND 24),
    grid_rows INTEGER NOT NULL CHECK (grid_rows BETWEEN 1 AND 24),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX rooms_name_idx ON rooms (lower(name));

CREATE TABLE racks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    height_u INTEGER NOT NULL CHECK (height_u BETWEEN 1 AND 80),
    grid_col INTEGER NOT NULL CHECK (grid_col BETWEEN 1 AND 24),
    grid_row INTEGER NOT NULL CHECK (grid_row BETWEEN 1 AND 24),
    rotation INTEGER NOT NULL CHECK (rotation IN (0, 90, 180, 270)),
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE (room_id, grid_col, grid_row)
);

CREATE UNIQUE INDEX racks_room_name_idx ON racks (room_id, lower(name));

CREATE TABLE rack_placements (
    asset_id INTEGER PRIMARY KEY REFERENCES assets,
    rack_id INTEGER NOT NULL REFERENCES racks,
    start_u INTEGER NOT NULL CHECK (start_u BETWEEN 1 AND 80),
    units INTEGER NOT NULL CHECK (units BETWEEN 1 AND 80),
    face TEXT NOT NULL DEFAULT 'front' CHECK (face IN ('front','rear')),
    depth TEXT NOT NULL DEFAULT 'full' CHECK (depth IN ('full','half')),
    version INTEGER NOT NULL DEFAULT 1,
    CHECK (start_u + units - 1 <= 80)
);

CREATE INDEX rack_placements_rack_idx ON rack_placements (rack_id, start_u);
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    color TEXT NOT NULL DEFAULT '#1677ff',
    description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX tags_name_idx ON tags (lower(name));

CREATE TABLE asset_tags (
    asset_id INTEGER NOT NULL REFERENCES assets ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags ON DELETE CASCADE,
    PRIMARY KEY (asset_id, tag_id)
);

CREATE INDEX asset_tags_tag_idx ON asset_tags (tag_id);
