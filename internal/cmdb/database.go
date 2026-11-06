package cmdb

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
)

//go:embed migrations/*.sql
var schema embed.FS

func Initialize(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(5843201)"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY)`); err != nil {
		return err
	}
	entries, err := schema.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := applySQL(ctx, tx, "migrations/"+entry.Name()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func applySQL(ctx context.Context, tx *sql.Tx, path string) error {
	var applied bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM migrations WHERE name=$1)", path).Scan(&applied); err != nil {
		return err
	}
	if applied {
		return nil
	}
	body, err := schema.ReadFile(path)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, string(body)); err != nil {
		return fmt.Errorf("apply %s: %w", path, err)
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO migrations (name) VALUES ($1)", path)
	return err
}
