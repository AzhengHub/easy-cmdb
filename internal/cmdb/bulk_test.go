package cmdb

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestBulkUpdateAssets(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	fields := baseFields("host", "批量主机-01")
	first, err := SaveAsset(ctx, db, 0, 0, fields, "tester")
	if err != nil {
		t.Fatalf("save first asset: %v", err)
	}
	fields = baseFields("host", "批量主机-02")
	second, err := SaveAsset(ctx, db, 0, 0, fields, "tester")
	if err != nil {
		t.Fatalf("save second asset: %v", err)
	}

	status := "online"
	owner := " 平台组 "
	updated, err := BulkUpdateAssets(ctx, db, []int64{first.ID, second.ID}, BulkAssetPatch{
		Status: &status, Owner: &owner,
	}, "tester")
	if err != nil {
		t.Fatalf("bulk update: %v", err)
	}
	if updated != 2 {
		t.Fatalf("updated = %d, want 2", updated)
	}

	var gotOwner string
	var gotVersion int
	if err := db.QueryRowContext(ctx, "SELECT owner, version FROM assets WHERE id=$1", first.ID).Scan(&gotOwner, &gotVersion); err != nil {
		t.Fatalf("read updated asset: %v", err)
	}
	if gotOwner != "平台组" || gotVersion != 2 {
		t.Fatalf("owner/version = %q/%d, want 平台组/2", gotOwner, gotVersion)
	}
	changes, err := ListChanges(ctx, db, first.ID)
	if err != nil {
		t.Fatalf("list changes: %v", err)
	}
	if len(changes) != 2 {
		t.Fatalf("changes = %d, want 2", len(changes))
	}
	if string(changes[0].After) == "" {
		t.Fatal("bulk update should record after state")
	}

	invalid := "not-a-status"
	if _, err := BulkUpdateAssets(ctx, db, []int64{first.ID}, BulkAssetPatch{Status: &invalid}, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid status error = %v, want ErrInvalid", err)
	}
	if _, err := BulkUpdateAssets(ctx, db, nil, BulkAssetPatch{Status: &status}, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty ids error = %v, want ErrInvalid", err)
	}
	if _, err := BulkUpdateAssets(ctx, db, []int64{first.ID}, BulkAssetPatch{}, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty patch error = %v, want ErrInvalid", err)
	}
	if _, err := BulkUpdateAssets(ctx, db, []int64{999999}, BulkAssetPatch{Status: &status}, "tester"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing asset error = %v, want sql.ErrNoRows", err)
	}
}

func TestBulkUpdateRollsBackOnInvalidRow(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	valid, err := SaveAsset(ctx, db, 0, 0, baseFields("host", "回滚主机"), "tester")
	if err != nil {
		t.Fatalf("save asset: %v", err)
	}
	// A valid first row followed by a missing row must leave the first untouched.
	status := "offline"
	if _, err := BulkUpdateAssets(ctx, db, []int64{valid.ID, 999999}, BulkAssetPatch{Status: &status}, "tester"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("error = %v, want sql.ErrNoRows", err)
	}
	var gotStatus string
	if err := db.QueryRowContext(ctx, "SELECT status FROM assets WHERE id=$1", valid.ID).Scan(&gotStatus); err != nil {
		t.Fatalf("read asset: %v", err)
	}
	if gotStatus != "unknown" {
		t.Fatalf("status = %q, want unknown after rollback", gotStatus)
	}
	changes, err := ListChanges(ctx, db, valid.ID)
	if err != nil {
		t.Fatalf("list changes: %v", err)
	}
	if len(changes) != 1 {
		t.Fatalf("changes = %d, want only create", len(changes))
	}
}
