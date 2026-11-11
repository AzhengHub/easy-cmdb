package cmdb

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestIPAM(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	if _, err := SaveVLAN(ctx, db, 0, VLANFields{VID: 100, Name: "办公", Status: "active"}, 0, "tester"); err != nil {
		t.Fatalf("create vlan: %v", err)
	}
	subnet, err := SaveSubnet(ctx, db, 0, SubnetFields{
		Name: "办公网", CIDR: "192.168.10.0/24", Gateway: "192.168.10.1", VLAN: "100",
		Status: "active", Role: "办公网",
	}, 0, "tester")
	if err != nil {
		t.Fatalf("create subnet: %v", err)
	}
	if subnet.ID == 0 || subnet.Version != 1 || subnet.Usable != 254 {
		t.Fatalf("unexpected subnet: %+v", subnet)
	}
	if subnet.Status != "active" || subnet.Role != "办公网" || subnet.VLANName != "办公" {
		t.Fatalf("unexpected subnet metadata: %+v", subnet)
	}
	if _, err := SaveSubnet(ctx, db, 0, SubnetFields{
		Name: "未登记 VLAN", CIDR: "192.168.30.0/24", VLAN: "300",
	}, 0, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown vlan error = %v, want ErrInvalid", err)
	}

	host, err := SaveAsset(ctx, db, 0, 0, Fields{
		Kind: "host", Name: "lab-host-01", Status: "online", Lifecycle: "active",
		Address: "192.168.10.10, 10.0.0.5", Attributes: []byte(`{}`),
	}, "tester")
	if err != nil {
		t.Fatalf("create asset: %v", err)
	}

	list, err := ListSubnets(ctx, db)
	if err != nil || len(list) != 1 {
		t.Fatalf("list subnets: %v, %d", err, len(list))
	}
	if list[0].Used != 2 || list[0].Free != 252 {
		t.Fatalf("unexpected subnet usage: %+v", list[0])
	}

	detail, err := GetSubnet(ctx, db, subnet.ID)
	if err != nil {
		t.Fatalf("subnet detail: %v", err)
	}
	if len(detail.FreeIPs) == 0 || detail.FreeIPs[0] != "192.168.10.2" {
		t.Fatalf("unexpected free IPs: %v", detail.FreeIPs)
	}
	if !usageHas(detail.UsedIPs, "192.168.10.1", "gateway") || !usageHas(detail.UsedIPs, "192.168.10.10", "asset") {
		t.Fatalf("missing automatic usage: %+v", detail.UsedIPs)
	}

	allocation, err := SaveAllocation(ctx, db, subnet.ID, AllocationFields{
		IP: "192.168.10.20", AssetID: host.ID, Label: "gateway-vip",
		Status: "reserved", DNSName: "vip.example.test", Role: "vip",
	}, "tester")
	if err != nil {
		t.Fatalf("allocate IP: %v", err)
	}
	if allocation.ID == 0 || allocation.Version != 1 || allocation.AssetName != host.Name {
		t.Fatalf("unexpected allocation: %+v", allocation)
	}
	if allocation.Status != "reserved" || allocation.DNSName != "vip.example.test" || allocation.Role != "vip" {
		t.Fatalf("unexpected allocation metadata: %+v", allocation)
	}

	detail, err = GetSubnet(ctx, db, subnet.ID)
	if err != nil {
		t.Fatalf("subnet detail after allocation: %v", err)
	}
	if detail.Used != 3 || !usageHas(detail.UsedIPs, "192.168.10.20", "allocated") {
		t.Fatalf("allocation not reflected: %+v", detail)
	}
	if !usageHasState(detail.UsedIPs, "192.168.10.20", "reserved") {
		t.Fatalf("allocation state not reflected: %+v", detail.UsedIPs)
	}

	addresses, err := ListIPAddresses(ctx, db)
	if err != nil {
		t.Fatalf("list ip addresses: %v", err)
	}
	if len(addresses) != 3 || !addressHas(addresses, "192.168.10.20", "allocated", "reserved") {
		t.Fatalf("unexpected address inventory: %+v", addresses)
	}

	updated, err := UpdateAllocation(ctx, db, allocation.ID, allocation.Version, AllocationFields{
		IP: "192.168.10.99", AssetID: host.ID, Label: "gateway-vip", Status: "active",
		DNSName: "vip.example.test", Role: "vip",
	}, "tester")
	if err != nil {
		t.Fatalf("update allocation: %v", err)
	}
	if updated.Version != 2 || updated.IP != "192.168.10.20" || updated.Status != "active" {
		t.Fatalf("unexpected updated allocation: %+v", updated)
	}
	cleared, err := UpdateAllocation(ctx, db, allocation.ID, updated.Version, AllocationFields{
		Label: "gateway-vip", Status: "active", DNSName: "vip.example.test", Role: "vip",
	}, "tester")
	if err != nil {
		t.Fatalf("clear allocation asset: %v", err)
	}
	if cleared.AssetID != 0 || cleared.AssetName != "" || cleared.Version != 3 {
		t.Fatalf("unexpected cleared allocation: %+v", cleared)
	}
	restored, err := UpdateAllocation(ctx, db, allocation.ID, cleared.Version, AllocationFields{
		AssetID: host.ID, Label: "gateway-vip", Status: "active", DNSName: "vip.example.test", Role: "vip",
	}, "tester")
	if err != nil {
		t.Fatalf("restore allocation asset: %v", err)
	}
	if restored.AssetID != host.ID || restored.AssetName != host.Name || restored.Version != 4 {
		t.Fatalf("unexpected restored allocation: %+v", restored)
	}
	if _, err := UpdateAllocation(ctx, db, allocation.ID, allocation.Version, AllocationFields{Status: "active"}, "tester"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale allocation update error = %v, want ErrConflict", err)
	}

	if _, err := SaveAllocation(ctx, db, subnet.ID, AllocationFields{IP: "192.168.10.20"}, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate allocation error = %v, want ErrInvalid", err)
	}
	if _, err := SaveAllocation(ctx, db, subnet.ID, AllocationFields{IP: "192.168.10.1"}, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("gateway allocation error = %v, want ErrInvalid", err)
	}
	if _, err := SaveAllocation(ctx, db, subnet.ID, AllocationFields{IP: "192.168.10.10"}, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("asset-address allocation error = %v, want ErrInvalid", err)
	}
	if _, err := SaveAllocation(ctx, db, subnet.ID, AllocationFields{IP: "192.168.11.20"}, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("out-of-subnet allocation error = %v, want ErrInvalid", err)
	}

	nested, err := SaveSubnet(ctx, db, 0, SubnetFields{Name: "办公网子网", CIDR: "192.168.10.0/25"}, 0, "tester")
	if err != nil {
		t.Fatalf("nested subnet should be allowed: %v", err)
	}
	second, err := SaveSubnet(ctx, db, 0, SubnetFields{Name: "服务器网", CIDR: "192.168.20.0/24"}, 0, "tester")
	if err != nil {
		t.Fatalf("create second subnet: %v", err)
	}

	if err := DeleteSubnet(ctx, db, subnet.ID, subnet.Version, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("delete subnet with allocation error = %v, want ErrInvalid", err)
	}
	vlan := vlanOf(t, ctx, db, 100)
	if err := DeleteVLAN(ctx, db, vlan.ID, vlan.Version, "tester"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("delete vlan in use error = %v, want ErrInvalid", err)
	}
	if err := DeleteAllocation(ctx, db, allocation.ID, restored.Version, "tester"); err != nil {
		t.Fatalf("release allocation: %v", err)
	}
	if err := DeleteSubnet(ctx, db, subnet.ID, subnet.Version, "tester"); err != nil {
		t.Fatalf("delete subnet: %v", err)
	}
	if err := DeleteSubnet(ctx, db, nested.ID, nested.Version, "tester"); err != nil {
		t.Fatalf("delete nested subnet: %v", err)
	}
	if err := DeleteSubnet(ctx, db, second.ID, second.Version, "tester"); err != nil {
		t.Fatalf("delete second subnet: %v", err)
	}
	vlan = vlanOf(t, ctx, db, 100)
	if err := DeleteVLAN(ctx, db, vlan.ID, vlan.Version, "tester"); err != nil {
		t.Fatalf("delete vlan: %v", err)
	}
}

func vlanOf(t *testing.T, ctx context.Context, db *sql.DB, vid int) VLAN {
	t.Helper()
	vlans, err := ListVLANs(ctx, db)
	if err != nil {
		t.Fatalf("list vlans: %v", err)
	}
	for _, vlan := range vlans {
		if vlan.VID == vid {
			return vlan
		}
	}
	t.Fatalf("vlan %d not found", vid)
	return VLAN{}
}

func usageHas(usages []IPUsage, ip, source string) bool {
	for _, usage := range usages {
		if usage.IP == ip && usage.Source == source {
			return true
		}
	}
	return false
}

func usageHasState(usages []IPUsage, ip, state string) bool {
	for _, usage := range usages {
		if usage.IP == ip && usage.State == state {
			return true
		}
	}
	return false
}

func addressHas(addresses []IPAddress, ip, source, state string) bool {
	for _, address := range addresses {
		if address.IP == ip && address.Source == source && address.State == state {
			return true
		}
	}
	return false
}
