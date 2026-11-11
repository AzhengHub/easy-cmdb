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
	return tx.Commit()
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
