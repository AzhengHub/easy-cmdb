package cmdb

import (
	"context"
	"database/sql"
	"net/netip"
	"sort"
	"strconv"
)

// IPAddress is a read model across the address space managed by IPAM. Manual
// allocations, gateway addresses and addresses typed on assets are combined so
// the address inventory can be searched from one place. Only entries backed by
// an allocation can be edited.
type IPAddress struct {
	Key          string `json:"key"`
	IP           string `json:"ip"`
	Source       string `json:"source"`
	State        string `json:"state"`
	DNSName      string `json:"dnsName,omitempty"`
	Role         string `json:"role,omitempty"`
	SubnetID     int64  `json:"subnetId"`
	SubnetName   string `json:"subnetName"`
	AssetID      int64  `json:"assetId,omitempty"`
	AssetName    string `json:"assetName,omitempty"`
	AllocationID int64  `json:"allocationId,omitempty"`
	Label        string `json:"label,omitempty"`
	Notes        string `json:"notes,omitempty"`
	Version      int    `json:"version,omitempty"`
}

type subnetAddressScope struct {
	subnet    Subnet
	prefix    netip.Prefix
	network   netip.Addr
	broadcast netip.Addr
}

func ListIPAddresses(ctx context.Context, db *sql.DB) ([]IPAddress, error) {
	subnets, err := ListSubnets(ctx, db)
	if err != nil {
		return nil, err
	}
	scopes := make([]subnetAddressScope, 0, len(subnets))
	for _, subnet := range subnets {
		prefix, err := parseSubnet(subnet.CIDR)
		if err != nil {
			return nil, err
		}
		network, broadcast := subnetBounds(prefix)
		scopes = append(scopes, subnetAddressScope{subnet: subnet, prefix: prefix, network: network, broadcast: broadcast})
	}
	allocations, err := loadAllAllocations(ctx, db)
	if err != nil {
		return nil, err
	}
	assets, err := loadAssetIPs(ctx, db)
	if err != nil {
		return nil, err
	}

	entries := make(map[string]IPAddress)
	reserved := make(map[netip.Addr]struct{})
	for _, scope := range scopes {
		if scope.subnet.Gateway != "" {
			if gateway, err := netip.ParseAddr(scope.subnet.Gateway); err == nil && scope.prefix.Contains(gateway) {
				reserved[gateway] = struct{}{}
				key := "gw:" + strconv.FormatInt(scope.subnet.ID, 10)
				entries[key] = IPAddress{
					Key: key, IP: gateway.String(), Source: "gateway", State: "active",
					SubnetID: scope.subnet.ID, SubnetName: scope.subnet.Name, Label: "网关",
				}
			}
		}
	}
	for _, allocation := range allocations {
		key := "a:" + strconv.FormatInt(allocation.ID, 10)
		if addr, err := netip.ParseAddr(allocation.IP); err == nil {
			reserved[addr] = struct{}{}
		}
		entries[key] = IPAddress{
			Key: key, IP: allocation.IP, Source: "allocated", State: allocation.Status,
			DNSName: allocation.DNSName, Role: allocation.Role,
			SubnetID: allocation.SubnetID, SubnetName: allocation.SubnetName,
			AssetID: allocation.AssetID, AssetName: allocation.AssetName,
			AllocationID: allocation.ID, Label: allocation.Label, Notes: allocation.Notes,
			Version: allocation.Version,
		}
	}
	for addr, refs := range assets {
		scope, ok := mostSpecificScope(scopes, addr)
		if !ok || len(refs) == 0 {
			continue
		}
		if _, exists := reserved[addr]; exists {
			continue
		}
		for _, ref := range refs {
			key := "asset:" + strconv.FormatInt(ref.ID, 10) + ":" + addr.String()
			entries[key] = IPAddress{
				Key: key, IP: addr.String(), Source: "asset", State: "active",
				SubnetID: scope.subnet.ID, SubnetName: scope.subnet.Name,
				AssetID: ref.ID, AssetName: ref.Name,
			}
		}
	}

	result := make([]IPAddress, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry)
	}
	sort.Slice(result, func(i, j int) bool {
		left, leftErr := netip.ParseAddr(result[i].IP)
		right, rightErr := netip.ParseAddr(result[j].IP)
		if leftErr == nil && rightErr == nil && left != right {
			return left.Compare(right) < 0
		}
		if result[i].Source != result[j].Source {
			return result[i].Source < result[j].Source
		}
		return result[i].Key < result[j].Key
	})
	return result, nil
}

func loadAllAllocations(ctx context.Context, db *sql.DB) ([]Allocation, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT a.id,a.subnet_id,a.ip,COALESCE(a.asset_id,0),COALESCE(b.name,''),a.label,a.notes,
			a.status,a.dns_name,a.role,a.version,s.name
		FROM ip_allocations a
		JOIN subnets s ON s.id=a.subnet_id
		LEFT JOIN assets b ON b.id=a.asset_id
		ORDER BY a.ip, a.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	allocations := make([]Allocation, 0)
	for rows.Next() {
		allocation, err := readAllocation(rows)
		if err != nil {
			return nil, err
		}
		allocations = append(allocations, allocation)
	}
	return allocations, rows.Err()
}

func mostSpecificScope(scopes []subnetAddressScope, addr netip.Addr) (subnetAddressScope, bool) {
	var best subnetAddressScope
	found := false
	for _, scope := range scopes {
		if !scope.prefix.Contains(addr) || addr == scope.network || addr == scope.broadcast {
			continue
		}
		if !found || scope.prefix.Bits() > best.prefix.Bits() {
			best = scope
			found = true
		}
	}
	return best, found
}
