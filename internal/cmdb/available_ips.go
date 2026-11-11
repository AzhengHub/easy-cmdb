package cmdb

import (
	"context"
	"database/sql"
	"net/netip"
)

// AvailableIPs is one page of unallocated addresses in a subnet. Free
// addresses are calculated from the same usage model as the subnet detail
// view, so gateways, asset addresses, and manual allocations are all skipped.
type AvailableIPs struct {
	Items  []string `json:"items"`
	Total  int64    `json:"total"`
	Offset int      `json:"offset"`
	Limit  int      `json:"limit"`
}

func ListAvailableIPs(ctx context.Context, db *sql.DB, subnetID int64, offset, limit int) (AvailableIPs, error) {
	if offset < 0 {
		offset = 0
	}
	if limit < 1 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	detail, err := GetSubnet(ctx, db, subnetID)
	if err != nil {
		return AvailableIPs{}, err
	}
	page := AvailableIPs{Items: make([]string, 0, limit), Total: detail.Free, Offset: offset, Limit: limit}
	if int64(offset) >= detail.Free {
		return page, nil
	}
	prefix, err := parseSubnet(detail.CIDR)
	if err != nil {
		return AvailableIPs{}, err
	}
	used := make(map[netip.Addr]struct{}, len(detail.UsedIPs))
	for _, item := range detail.UsedIPs {
		if addr, err := netip.ParseAddr(item.IP); err == nil {
			used[addr] = struct{}{}
		}
	}
	network, broadcast := subnetBounds(prefix)
	seen := 0
	for addr := network.Next(); addr.IsValid() && addr.Compare(broadcast) < 0; addr = addr.Next() {
		if _, exists := used[addr]; exists {
			continue
		}
		if seen < offset {
			seen++
			continue
		}
		page.Items = append(page.Items, addr.String())
		if len(page.Items) >= limit {
			break
		}
	}
	return page, nil
}
