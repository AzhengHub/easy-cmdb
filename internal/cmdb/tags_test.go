package cmdb

import (
	"context"
	"errors"
	"testing"
)

func TestTags(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	prod, err := SaveTag(ctx, db, 0, TagFields{Name: "生产", Color: "#1677ff", Description: "生产环境"})
	if err != nil {
		t.Fatalf("create tag: %v", err)
	}
	if prod.ID == 0 || prod.Color != "#1677ff" {
		t.Fatalf("unexpected tag: %+v", prod)
	}
	if _, err := SaveTag(ctx, db, 0, TagFields{Name: "生产"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate tag error = %v, want ErrInvalid", err)
	}
	if _, err := SaveTag(ctx, db, 0, TagFields{Name: "坏颜色", Color: "red"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid color error = %v, want ErrInvalid", err)
	}
	updated, err := SaveTag(ctx, db, prod.ID, TagFields{Name: "生产", Color: "#52c41a", Description: "已更新"})
	if err != nil {
		t.Fatalf("update tag: %v", err)
	}
	if updated.Color != "#52c41a" {
		t.Fatalf("color = %s", updated.Color)
	}

	asset, err := SaveAsset(ctx, db, 0, 0, baseFields("host", "标签主机"), "tester")
	if err != nil {
		t.Fatalf("create asset: %v", err)
	}
	tags, err := SetAssetTags(ctx, db, asset.ID, []int64{prod.ID}, "tester")
	if err != nil {
		t.Fatalf("set tags: %v", err)
	}
	if len(tags) != 1 || tags[0].Name != "生产" {
		t.Fatalf("tags = %+v", tags)
	}
	listed, err := ListTags(ctx, db)
	if err != nil {
		t.Fatalf("list tags: %v", err)
	}
	if len(listed) != 1 || listed[0].AssetCount != 1 {
		t.Fatalf("tag counts = %+v", listed)
	}
	assets, err := ListAssets(ctx, db)
	if err != nil {
		t.Fatalf("list assets: %v", err)
	}
	if len(assets) != 1 || len(assets[0].Tags) != 1 {
		t.Fatalf("asset tags = %+v", assets)
	}
	changes, err := ListChanges(ctx, db, asset.ID)
	if err != nil {
		t.Fatalf("list changes: %v", err)
	}
	if len(changes) != 2 || changes[0].Action != "tags" {
		t.Fatalf("tag change not recorded: %+v", changes)
	}
	if _, err := SetAssetTags(ctx, db, asset.ID, []int64{999999}, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing tag error = %v, want ErrInvalid", err)
	}
	if err := DeleteTag(ctx, db, prod.ID); err != nil {
		t.Fatalf("delete tag: %v", err)
	}
	tags, err = ListAssetTags(ctx, db, asset.ID)
	if err != nil {
		t.Fatalf("list asset tags: %v", err)
	}
	if len(tags) != 0 {
		t.Fatalf("asset tags after delete = %+v", tags)
	}
}
