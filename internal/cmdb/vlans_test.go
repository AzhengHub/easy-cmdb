package cmdb

import (
	"context"
	"errors"
	"testing"
)

func TestVLANLifecycle(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	room, err := SaveRoom(ctx, db, 0, RoomFields{Name: "测试机房", Columns: 4, Rows: 2}, 0, "tester")
	if err != nil {
		t.Fatalf("create room: %v", err)
	}
	vlan, err := SaveVLAN(ctx, db, 0, VLANFields{
		VID: 120, Name: "服务器", Status: "active", Description: "服务器区", RoomID: room.ID,
	}, 0, "tester")
	if err != nil {
		t.Fatalf("create vlan: %v", err)
	}
	if vlan.ID == 0 || vlan.Version != 1 || vlan.RoomName != room.Name || vlan.PrefixCount != 0 {
		t.Fatalf("unexpected vlan: %+v", vlan)
	}

	if _, err := SaveVLAN(ctx, db, 0, VLANFields{VID: 120, Name: "另一个", Status: "active"}, 0, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate vid error = %v, want ErrInvalid", err)
	}
	if _, err := SaveVLAN(ctx, db, 0, VLANFields{VID: 121, Name: "服务器", Status: "active"}, 0, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate name error = %v, want ErrInvalid", err)
	}
	if _, err := SaveVLAN(ctx, db, 0, VLANFields{VID: 5000, Name: "越界", Status: "active"}, 0, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid vid error = %v, want ErrInvalid", err)
	}
	if _, err := SaveVLAN(ctx, db, 0, VLANFields{VID: 122, Name: "无主", Status: "unknown"}, 0, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid status error = %v, want ErrInvalid", err)
	}

	updated, err := SaveVLAN(ctx, db, vlan.ID, VLANFields{
		VID: 120, Name: "服务器区", Status: "reserved", Description: "调整", RoomID: room.ID,
	}, vlan.Version, "tester")
	if err != nil {
		t.Fatalf("update vlan: %v", err)
	}
	if updated.Version != 2 || updated.Name != "服务器区" || updated.Status != "reserved" {
		t.Fatalf("unexpected updated vlan: %+v", updated)
	}
	if _, err := SaveVLAN(ctx, db, vlan.ID, VLANFields{
		VID: 120, Name: "服务器区", Status: "active",
	}, vlan.Version, "tester"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale vlan update error = %v, want ErrConflict", err)
	}

	subnet, err := SaveSubnet(ctx, db, 0, SubnetFields{
		Name: "服务器网", CIDR: "10.20.0.0/24", VLAN: "120",
	}, 0, "tester")
	if err != nil {
		t.Fatalf("create subnet with vlan: %v", err)
	}
	vlans, err := ListVLANs(ctx, db)
	if err != nil || len(vlans) != 1 || vlans[0].PrefixCount != 1 {
		t.Fatalf("list vlans: %+v, %v", vlans, err)
	}
	if _, err := SaveVLAN(ctx, db, updated.ID, VLANFields{
		VID: 123, Name: "服务器区", Status: "reserved",
	}, updated.Version, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("change referenced vid error = %v, want ErrInvalid", err)
	}
	if err := DeleteVLAN(ctx, db, updated.ID, updated.Version, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("delete referenced vlan error = %v, want ErrInvalid", err)
	}
	if err := DeleteSubnet(ctx, db, subnet.ID, subnet.Version, "tester"); err != nil {
		t.Fatalf("delete subnet: %v", err)
	}
	if err := DeleteVLAN(ctx, db, updated.ID, updated.Version, "tester"); err != nil {
		t.Fatalf("delete vlan: %v", err)
	}
}

func TestVLANSearch(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	if _, err := SaveVLAN(ctx, db, 0, VLANFields{VID: 200, Name: "管理网", Status: "active", Description: "设备管理"}, 0, "tester"); err != nil {
		t.Fatalf("create vlan: %v", err)
	}
	results, err := Search(ctx, db, "管理")
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	found := false
	for _, result := range results {
		if result.Type == "vlan" && result.VLANID != 0 && result.Label == "VLAN 200 · 管理网" {
			found = true
		}
	}
	if !found {
		t.Fatalf("vlan search result missing: %+v", results)
	}
}
