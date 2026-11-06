ALTER TABLE assets DROP CONSTRAINT assets_kind_check;
ALTER TABLE assets ADD CONSTRAINT assets_kind_check
    CHECK (kind IN ('chassis','host','cluster','vm','business','switch'));

ALTER TABLE changes ALTER COLUMN asset_id DROP NOT NULL;

CREATE TABLE rooms (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
    grid_columns integer NOT NULL CHECK (grid_columns BETWEEN 1 AND 24),
    grid_rows integer NOT NULL CHECK (grid_rows BETWEEN 1 AND 24),
    version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX rooms_name_idx ON rooms (lower(name));

CREATE TABLE racks (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id bigint NOT NULL REFERENCES rooms,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    height_u integer NOT NULL CHECK (height_u BETWEEN 1 AND 80),
    grid_col integer NOT NULL CHECK (grid_col BETWEEN 1 AND 24),
    grid_row integer NOT NULL CHECK (grid_row BETWEEN 1 AND 24),
    rotation integer NOT NULL CHECK (rotation IN (0, 90, 180, 270)),
    version integer NOT NULL DEFAULT 1,
    UNIQUE (room_id, grid_col, grid_row)
);

CREATE UNIQUE INDEX racks_room_name_idx ON racks (room_id, lower(name));

CREATE SEQUENCE rack_placement_versions;

CREATE TABLE rack_placements (
    asset_id bigint PRIMARY KEY REFERENCES assets,
    rack_id bigint NOT NULL REFERENCES racks,
    start_u integer NOT NULL CHECK (start_u BETWEEN 1 AND 80),
    units integer NOT NULL CHECK (units BETWEEN 1 AND 80),
    version bigint NOT NULL DEFAULT nextval('rack_placement_versions'),
    CHECK (start_u + units - 1 <= 80)
);

ALTER SEQUENCE rack_placement_versions OWNED BY rack_placements.version;
CREATE INDEX rack_placements_rack_idx ON rack_placements (rack_id, start_u);
