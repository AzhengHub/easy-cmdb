package cmdb

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

// sqliteOptions keeps a single writer at a time, uses WAL for concurrent
// readers, and makes every transaction an immediate write transaction so the
// cross-row checks in the API cannot interleave with another writer.
const sqliteOptions = "?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)" +
	"&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)&_txlock=immediate"

// Open opens the SQLite database file used by the application. A relative path
// is resolved against the working directory. The parent directory is created
// when it does not exist.
func Open(path string) (*sql.DB, error) {
	if path == "" {
		path = "dc-db.db"
	}
	if dir := filepath.Dir(path); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("创建数据库目录: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path+sqliteOptions)
	if err != nil {
		return nil, err
	}
	// SQLite permits one writer. Serializing the pool also keeps reads and
	// writes in one process deterministic without SQLITE_BUSY failures.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

func Initialize(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var initialized bool
	if err := tx.QueryRowContext(ctx,
		"SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='assets')").Scan(&initialized); err != nil {
		return err
	}
	if !initialized {
		if _, err := tx.ExecContext(ctx, schemaSQL); err != nil {
			return fmt.Errorf("初始化表结构: %w", err)
		}
	}
	// Tag tables were added after the initial schema. Running the idempotent
	// DDL keeps existing databases upgrade-safe without a separate migration
	// tool or overwriting any data.
	if err := ensureTagSchema(ctx, tx); err != nil {
		return fmt.Errorf("初始化标签表: %w", err)
	}
	if err := ensureIPAMSchema(ctx, tx); err != nil {
		return fmt.Errorf("初始化 IPAM 表: %w", err)
	}
	if err := ensureFacilitySchema(ctx, tx); err != nil {
		return fmt.Errorf("初始化机柜字段: %w", err)
	}
	return tx.Commit()
}

// ensureFacilitySchema adds the rack face and mounting depth fields to an
// existing database. The placements table is absent in a few partial test
// fixtures, so a missing table is treated as nothing to upgrade.
func ensureFacilitySchema(ctx context.Context, tx *sql.Tx) error {
	exists, err := tableExists(ctx, tx, "rack_placements")
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	if err := ensureColumn(ctx, tx, "rack_placements", "face", "TEXT NOT NULL DEFAULT 'front'"); err != nil {
		return err
	}
	return ensureColumn(ctx, tx, "rack_placements", "depth", "TEXT NOT NULL DEFAULT 'full'")
}

func tableExists(ctx context.Context, tx *sql.Tx, table string) (bool, error) {
	var exists bool
	err := tx.QueryRowContext(ctx,
		"SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name=$1)", table).Scan(&exists)
	return exists, err
}

// ensureIPAMSchema adds the IPAM inventory fields introduced after the first
// release. Every statement is idempotent so opening an older database upgrades
// it in place without a separate migration command.
func ensureIPAMSchema(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS vlans (
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
		CREATE UNIQUE INDEX IF NOT EXISTS vlans_vid_idx ON vlans (vid);
		CREATE UNIQUE INDEX IF NOT EXISTS vlans_name_idx ON vlans (lower(name));
	`); err != nil {
		return err
	}
	columns := []struct {
		table      string
		name       string
		definition string
	}{
		{"subnets", "status", "TEXT NOT NULL DEFAULT 'active'"},
		{"subnets", "role", "TEXT NOT NULL DEFAULT ''"},
		{"ip_allocations", "status", "TEXT NOT NULL DEFAULT 'active'"},
		{"ip_allocations", "dns_name", "TEXT NOT NULL DEFAULT ''"},
		{"ip_allocations", "role", "TEXT NOT NULL DEFAULT ''"},
	}
	for _, column := range columns {
		if err := ensureColumn(ctx, tx, column.table, column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func ensureColumn(ctx context.Context, tx *sql.Tx, table, name, definition string) error {
	rows, err := tx.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var columnName, columnType string
		var notNull, primaryKey int
		var defaultValue any
		if err := rows.Scan(&cid, &columnName, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return err
		}
		if columnName == name {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "ALTER TABLE "+table+" ADD COLUMN "+name+" "+definition)
	return err
}

// isUniqueViolation reports whether err is an SQLite uniqueness error.
func isUniqueViolation(err error) bool {
	var sqliteErr *sqlite.Error
	if !errors.As(err, &sqliteErr) {
		return false
	}
	// SQLITE_CONSTRAINT_PRIMARYKEY and SQLITE_CONSTRAINT_UNIQUE.
	return sqliteErr.Code() == 1555 || sqliteErr.Code() == 2067
}

// isForeignKeyViolation reports whether err is an SQLite foreign key error.
func isForeignKeyViolation(err error) bool {
	var sqliteErr *sqlite.Error
	return errors.As(err, &sqliteErr) && sqliteErr.Code() == 787
}
