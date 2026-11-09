package cmdb

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "easy.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	if err := Initialize(ctx, db); err != nil {
		t.Fatalf("initialize database: %v", err)
	}
	// Applying migrations again must be a no-op.
	if err := Initialize(ctx, db); err != nil {
		t.Fatalf("re-initialize database: %v", err)
	}
	return db
}

func baseFields(kind, name string) Fields {
	return Fields{
		Kind: kind, Name: name, Status: "unknown", Lifecycle: "active",
		Attributes: json.RawMessage(`{}`),
	}
}

func TestAssetLifecycle(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	fields := Fields{
		Kind: "host", Name: "lab-host-01", Status: "online", Lifecycle: "active",
		CPU: 8, MemoryMiB: 16384, Attributes: json.RawMessage(`{"rack":"A"}`),
	}
	asset, err := SaveAsset(ctx, db, 0, 0, fields, "tester")
	if err != nil {
		t.Fatalf("create asset: %v", err)
	}
	if asset.ID == 0 || asset.Version != 1 || asset.UpdatedAt.IsZero() {
		t.Fatalf("unexpected created asset: %+v", asset)
	}
	if string(asset.Attributes) != `{"rack":"A"}` {
		t.Fatalf("attributes = %s", asset.Attributes)
	}

	assets, err := ListAssets(ctx, db)
	if err != nil || len(assets) != 1 {
		t.Fatalf("list assets: %v, %d", err, len(assets))
	}

	update := asset.Fields
	update.Owner = "ops"
	update.Notes = "updated"
	update.Attributes = json.RawMessage(`{"rack":"B"}`)
	updated, err := SaveAsset(ctx, db, asset.ID, asset.Version, update, "tester")
	if err != nil {
		t.Fatalf("update asset: %v", err)
	}
	if updated.Version != 2 || updated.Owner != "ops" || string(updated.Attributes) != `{"rack":"B"}` {
		t.Fatalf("unexpected updated asset: %+v", updated)
	}

	if _, err := SaveAsset(ctx, db, asset.ID, 1, update, "tester"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale update error = %v, want ErrConflict", err)
	}

	changes, err := ListChanges(ctx, db, asset.ID)
	if err != nil {
		t.Fatalf("list changes: %v", err)
	}
	if len(changes) != 2 {
		t.Fatalf("changes = %d, want 2", len(changes))
	}
	if string(changes[1].Before) != "null" || changes[0].Before == nil || changes[0].After == nil {
		t.Fatalf("unexpected change snapshots: %+v", changes)
	}
	if changes[0].CreatedAt.IsZero() {
		t.Fatal("change timestamp not parsed")
	}
}

func TestLinks(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	host, err := SaveAsset(ctx, db, 0, 0, baseFields("host", "lab-host-01"), "tester")
	if err != nil {
		t.Fatalf("create host: %v", err)
	}
	vm, err := SaveAsset(ctx, db, 0, 0, baseFields("vm", "lab-vm-01"), "tester")
	if err != nil {
		t.Fatalf("create vm: %v", err)
	}
	link := Link{Kind: "hosts", FromID: host.ID, ToID: vm.ID}
	if err := ChangeLink(ctx, db, link, false, "tester"); err != nil {
		t.Fatalf("link: %v", err)
	}
	if err := ChangeLink(ctx, db, link, false, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate link error = %v, want ErrInvalid", err)
	}

	links, err := ListLinks(ctx, db, host.ID)
	if err != nil || len(links) != 1 {
		t.Fatalf("list links: %v, %d", err, len(links))
	}
	if links[0].FromName != host.Name || links[0].ToName != vm.Name {
		t.Fatalf("unexpected link: %+v", links[0])
	}

	if err := ChangeLink(ctx, db, links[0], true, "tester"); err != nil {
		t.Fatalf("unlink: %v", err)
	}
	links, err = ListLinks(ctx, db, 0)
	if err != nil || len(links) != 0 {
		t.Fatalf("links after removal: %v, %d", err, len(links))
	}
}

func TestFacilities(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	host, err := SaveAsset(ctx, db, 0, 0, baseFields("host", "lab-host-01"), "tester")
	if err != nil {
		t.Fatalf("create host: %v", err)
	}
	room, err := SaveRoom(ctx, db, 0, RoomFields{Name: "lab-room", Columns: 6, Rows: 6}, 0, "tester")
	if err != nil {
		t.Fatalf("create room: %v", err)
	}
	rack, err := SaveRack(ctx, db, 0, room.ID, RackFields{Name: "R01", HeightU: 42, Column: 1, Row: 1}, 0, "tester")
	if err != nil {
		t.Fatalf("create rack: %v", err)
	}
	placement, err := SavePlacement(ctx, db, host.ID, nil, PlacementFields{RackID: rack.ID, StartU: 1, Units: 2}, 0, "tester")
	if err != nil {
		t.Fatalf("place host: %v", err)
	}
	if placement.Version != 1 {
		t.Fatalf("placement version = %d, want 1", placement.Version)
	}

	facilities, err := ListFacilities(ctx, db)
	if err != nil || len(facilities.Rooms) != 1 || len(facilities.Racks) != 1 || len(facilities.Placements) != 1 {
		t.Fatalf("facilities: %v, %+v", err, facilities)
	}

	moved, err := SavePlacement(ctx, db, host.ID, nil, PlacementFields{RackID: rack.ID, StartU: 3, Units: 2}, placement.Version, "tester")
	if err != nil {
		t.Fatalf("move host: %v", err)
	}
	if moved.StartU != 3 || moved.Version != 2 {
		t.Fatalf("unexpected moved placement: %+v", moved)
	}

	if err := DeleteRoom(ctx, db, room.ID, room.Version, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("delete occupied room error = %v, want ErrInvalid", err)
	}
	if err := DeleteRack(ctx, db, rack.ID, rack.Version, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("delete occupied rack error = %v, want ErrInvalid", err)
	}
	if err := DeletePlacement(ctx, db, host.ID, moved.Version, "tester"); err != nil {
		t.Fatalf("remove placement: %v", err)
	}
	if err := DeleteRack(ctx, db, rack.ID, rack.Version, "tester"); err != nil {
		t.Fatalf("delete rack: %v", err)
	}
	if err := DeleteRoom(ctx, db, room.ID, room.Version, "tester"); err != nil {
		t.Fatalf("delete room: %v", err)
	}
}

func TestImportAssets(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	var buf bytes.Buffer
	writer := csv.NewWriter(&buf)
	header := []string{"资源名称", "类型", "平台", "状态", "生命周期", "地址 / IP", "CPU", "内存 MiB", "负责人", "环境", "备注", "扩展属性"}
	if err := writer.Write(header); err != nil {
		t.Fatal(err)
	}
	if err := writer.Write([]string{"lab-vm-01", "虚拟机", "KVM", "运行中", "在册", "192.0.2.10", "4", "8192", "运维组", "测试", "导入测试", `{"位置":"A01"}`}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Write([]string{"lab-host-01", "物理机", "", "在线", "在册", "192.0.2.11", "16", "65536", "", "", "", ""}); err != nil {
		t.Fatal(err)
	}
	writer.Flush()
	withBOM := append([]byte{0xEF, 0xBB, 0xBF}, buf.Bytes()...)
	result, err := ImportAssets(ctx, db, bytes.NewReader(withBOM), "tester")
	if err != nil {
		t.Fatalf("import assets: %v", err)
	}
	if result.Imported != 2 {
		t.Fatalf("imported = %d, want 2", result.Imported)
	}

	assets, err := ListAssets(ctx, db)
	if err != nil || len(assets) != 2 {
		t.Fatalf("list assets: %v, %d", err, len(assets))
	}
	var vm Asset
	for _, asset := range assets {
		if asset.Name == "lab-vm-01" {
			vm = asset
		}
	}
	if vm.Kind != "vm" || vm.Platform != "kvm" || vm.Status != "running" || vm.CPU != 4 || vm.MemoryMiB != 8192 {
		t.Fatalf("unexpected imported vm: %+v", vm)
	}
	if string(vm.Attributes) != `{"位置":"A01"}` {
		t.Fatalf("attributes = %s", vm.Attributes)
	}

	if _, err := ImportAssets(ctx, db, bytes.NewReader(withBOM), "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate import error = %v, want ErrInvalid", err)
	}
	badKind := strings.NewReader("资源名称,类型\nbad,unknown\n")
	if _, err := ImportAssets(ctx, db, badKind, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad kind error = %v, want ErrInvalid", err)
	}
	if _, err := ImportAssets(ctx, db, strings.NewReader("资源名称,类型\n"), "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty import error = %v, want ErrInvalid", err)
	}
}
func TestUsers(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	if err := EnsureUser(ctx, db, "", "", "admin"); err != nil {
		t.Fatalf("ensure admin: %v", err)
	}
	if err := EnsureUser(ctx, db, "", "", "admin"); err != nil {
		t.Fatalf("ensure admin again: %v", err)
	}
	user, valid, err := authenticate(ctx, db, "admin", "default")
	if err != nil || !valid || user.Role != "admin" {
		t.Fatalf("authenticate: %v, %v, %+v", err, valid, user)
	}
	if _, valid, err := authenticate(ctx, db, "admin", "wrong-password"); err != nil || valid {
		t.Fatalf("wrong password: %v, %v", err, valid)
	}
}
