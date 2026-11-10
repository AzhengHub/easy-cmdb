package cmdb

import (
	"context"
	"errors"
	"testing"
)

func TestIPAM(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	subnet, err := SaveSubnet(ctx, db, 0, SubnetFields{
		Name: "办公网", CIDR: "192.168.10.0/24", Gateway: "192.168.10.1", VLAN: "100",
	}, 0, "tester")
	if err != nil {
		t.Fatalf("create subnet: %v", err)
	}
	if subnet.ID == 0 || subnet.Version != 1 || subnet.Usable != 254 {
		t.Fatalf("unexpected subnet: %+v", subnet)
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
	}, "tester")
	if err != nil {
		t.Fatalf("allocate IP: %v", err)
	}
	if allocation.ID == 0 || allocation.Version != 1 || allocation.AssetName != host.Name {
		t.Fatalf("unexpected allocation: %+v", allocation)
	}

	detail, err = GetSubnet(ctx, db, subnet.ID)
	if err != nil {
		t.Fatalf("subnet detail after allocation: %v", err)
	}
	if detail.Used != 3 || !usageHas(detail.UsedIPs, "192.168.10.20", "allocated") {
		t.Fatalf("allocation not reflected: %+v", detail)
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
	if err := DeleteAllocation(ctx, db, allocation.ID, allocation.Version, "tester"); err != nil {
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
}

func usageHas(usages []IPUsage, ip, status string) bool {
	for _, usage := range usages {
		if usage.IP == ip && usage.Status == status {
			return true
		}
	}
	return false
}
