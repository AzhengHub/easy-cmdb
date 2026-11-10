package cmdb

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestBulkUpdateAssetTags(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	first, err := SaveAsset(ctx, db, 0, 0, baseFields("host", "批量标签主机-01"), "tester")
	if err != nil {
		t.Fatalf("create first asset: %v", err)
	}
	second, err := SaveAsset(ctx, db, 0, 0, baseFields("host", "批量标签主机-02"), "tester")
	if err != nil {
		t.Fatalf("create second asset: %v", err)
	}
	prod, err := SaveTag(ctx, db, 0, TagFields{Name: "生产", Color: "#1677ff"})
	if err != nil {
		t.Fatalf("create prod tag: %v", err)
	}
	core, err := SaveTag(ctx, db, 0, TagFields{Name: "核心", Color: "#f5222d"})
	if err != nil {
		t.Fatalf("create core tag: %v", err)
	}
	ids := []int64{first.ID, second.ID}

	updated, err := BulkUpdateAssetTags(ctx, db, ids, []int64{prod.ID}, "add", "tester")
	if err != nil || updated != 2 {
		t.Fatalf("add tags = %d, %v", updated, err)
	}
	updated, err = BulkUpdateAssetTags(ctx, db, ids, []int64{prod.ID}, "add", "tester")
	if err != nil || updated != 0 {
		t.Fatalf("idempotent add = %d, %v", updated, err)
	}
	updated, err = BulkUpdateAssetTags(ctx, db, ids, []int64{core.ID}, "replace", "tester")
	if err != nil || updated != 2 {
		t.Fatalf("replace tags = %d, %v", updated, err)
	}
	tags, err := ListAssetTags(ctx, db, first.ID)
	if err != nil || len(tags) != 1 || tags[0].Name != "核心" {
		t.Fatalf("replaced tags = %+v, %v", tags, err)
	}
	updated, err = BulkUpdateAssetTags(ctx, db, ids, []int64{prod.ID}, "remove", "tester")
	if err != nil || updated != 0 {
		t.Fatalf("remove missing tag = %d, %v", updated, err)
	}
	updated, err = BulkUpdateAssetTags(ctx, db, ids, []int64{core.ID}, "remove", "tester")
	if err != nil || updated != 2 {
		t.Fatalf("remove tags = %d, %v", updated, err)
	}
	updated, err = BulkUpdateAssetTags(ctx, db, ids, nil, "replace", "tester")
	if err != nil || updated != 0 {
		t.Fatalf("replace with empty already empty = %d, %v", updated, err)
	}
	if _, err := BulkUpdateAssetTags(ctx, db, ids, []int64{prod.ID}, "replace", "tester"); err != nil {
		t.Fatalf("replace with tags: %v", err)
	}
	if _, err := BulkUpdateAssetTags(ctx, db, []int64{first.ID, 999999}, []int64{core.ID}, "add", "tester"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing asset error = %v, want sql.ErrNoRows", err)
	}
	tags, err = ListAssetTags(ctx, db, first.ID)
	if err != nil || len(tags) != 1 || tags[0].Name != "生产" {
		t.Fatalf("rollback kept tags = %+v, %v", tags, err)
	}
	if _, err := BulkUpdateAssetTags(ctx, db, ids, []int64{core.ID}, "bogus", "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid mode error = %v, want ErrInvalid", err)
	}
	if _, err := BulkUpdateAssetTags(ctx, db, ids, []int64{999999}, "add", "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid tag error = %v, want ErrInvalid", err)
	}
}
