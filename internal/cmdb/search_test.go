package cmdb

import (
	"context"
	"encoding/json"
	"testing"
)

func TestSearch(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	hostFields := baseFields("host", "核心主机-01")
	hostFields.Address = "10.20.30.40"
	hostFields.Owner = "平台组"
	hostFields.Notes = "数据库节点"
	hostFields.Attributes = json.RawMessage(`{"角色":"数据库"}`)
	host, err := SaveAsset(ctx, db, 0, 0, hostFields, "tester")
	if err != nil {
		t.Fatalf("save host: %v", err)
	}

	room, err := SaveRoom(ctx, db, 0, RoomFields{Name: "北京数据中心", Columns: 8, Rows: 6}, 0, "tester")
	if err != nil {
		t.Fatalf("save room: %v", err)
	}
	rack, err := SaveRack(ctx, db, 0, room.ID, RackFields{Name: "A-01", HeightU: 42, Column: 1, Row: 1}, 0, "tester")
	if err != nil {
		t.Fatalf("save rack: %v", err)
	}
	subnet, err := SaveSubnet(ctx, db, 0, SubnetFields{
		Name: "业务网", CIDR: "10.20.30.0/24", Gateway: "10.20.30.1",
	}, 0, "tester")
	if err != nil {
		t.Fatalf("save subnet: %v", err)
	}
	if _, err := SaveAllocation(ctx, db, subnet.ID, AllocationFields{
		IP: "10.20.30.10", AssetID: host.ID, Label: "数据库 VIP",
	}, "tester"); err != nil {
		t.Fatalf("save allocation: %v", err)
	}
	tag, err := SaveTag(ctx, db, 0, TagFields{Name: "生产标签", Color: "#1677ff", Description: "生产环境"})
	if err != nil {
		t.Fatalf("save tag: %v", err)
	}
	if _, err := SetAssetTags(ctx, db, host.ID, []int64{tag.ID}, "tester"); err != nil {
		t.Fatalf("set tag: %v", err)
	}

	assertTypes := func(query string, expected ...string) {
		t.Helper()
		results, err := Search(ctx, db, query)
		if err != nil {
			t.Fatalf("search %q: %v", query, err)
		}
		got := map[string]bool{}
		for _, result := range results {
			got[result.Type] = true
		}
		for _, kind := range expected {
			if !got[kind] {
				t.Fatalf("search %q missing %s: %+v", query, kind, results)
			}
		}
	}

	assertTypes("核心主机", "asset")
	assertTypes("10.20.30.40", "asset")
	assertTypes("数据库 VIP", "ip")
	assertTypes("北京数据中心", "room", "rack")
	assertTypes("A-01", "rack")
	assertTypes("10.20.30.0/24", "subnet")
	assertTypes("生产标签", "tag")
	assertTypes("生产环境", "tag")

	if rack.RoomID != room.ID {
		t.Fatalf("rack room = %d, want %d", rack.RoomID, room.ID)
	}
	noResults, err := Search(ctx, db, "%%")
	if err != nil {
		t.Fatalf("search escaped wildcard: %v", err)
	}
	if len(noResults) != 0 {
		t.Fatalf("wildcard should be escaped, got %+v", noResults)
	}
	short, err := Search(ctx, db, "x")
	if err != nil {
		t.Fatalf("search short query: %v", err)
	}
	if len(short) != 0 {
		t.Fatalf("short query should be empty, got %+v", short)
	}
}
