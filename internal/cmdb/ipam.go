package cmdb

import (
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	subnetColumns = `s.id,s.name,s.cidr,s.gateway,s.vlan,s.notes,s.status,s.role,s.version,
		COALESCE(v.name,''),COALESCE(v.status,'')`
	subnetFrom  = `subnets s LEFT JOIN vlans v ON v.vid = CAST(s.vlan AS INTEGER)`
	freeIPLimit = 50
)

var (
	subnetStatuses = map[string]bool{
		"container": true, "active": true, "reserved": true, "deprecated": true,
	}
	allocationStatuses = map[string]bool{
		"active": true, "reserved": true, "deprecated": true, "dhcp": true, "slaac": true,
	}
	allocationRoles = map[string]bool{
		"": true, "loopback": true, "secondary": true, "vip": true,
		"vrrp": true, "hsrp": true, "glbp": true, "anycast": true,
	}
	dnsNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,62})(\.[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,62}))*\.?$`)
)

type SubnetFields struct {
	Name    string `json:"name"`
	CIDR    string `json:"cidr"`
	Gateway string `json:"gateway"`
	VLAN    string `json:"vlan"`
	Notes   string `json:"notes"`
	Status  string `json:"status"`
	Role    string `json:"role"`
}

type Subnet struct {
	SubnetFields
	ID         int64  `json:"id"`
	Version    int    `json:"version"`
	VLANName   string `json:"vlanName,omitempty"`
	VLANStatus string `json:"vlanStatus,omitempty"`
	Usable     int64  `json:"usable"`
	Used       int64  `json:"used"`
	Free       int64  `json:"free"`
}

type AllocationFields struct {
	IP      string `json:"ip"`
	AssetID int64  `json:"assetId,omitempty"`
	Label   string `json:"label"`
	Notes   string `json:"notes"`
	Status  string `json:"status"`
	DNSName string `json:"dnsName"`
	Role    string `json:"role"`
}

type Allocation struct {
	AllocationFields
	ID         int64  `json:"id"`
	SubnetID   int64  `json:"subnetId"`
	SubnetName string `json:"subnetName,omitempty"`
	Version    int    `json:"version"`
	AssetName  string `json:"assetName,omitempty"`
}

type IPUsage struct {
	IP           string `json:"ip"`
	Source       string `json:"source"`
	State        string `json:"state"`
	AssetID      int64  `json:"assetId,omitempty"`
	AssetName    string `json:"assetName,omitempty"`
	AllocationID int64  `json:"allocationId,omitempty"`
	Label        string `json:"label,omitempty"`
	DNSName      string `json:"dnsName,omitempty"`
	Role         string `json:"role,omitempty"`
	Notes        string `json:"notes,omitempty"`
	Version      int    `json:"version,omitempty"`
}

type SubnetDetail struct {
	Subnet
	UsedIPs []IPUsage `json:"usedIps"`
	FreeIPs []string  `json:"freeIps"`
}

type assetRef struct {
	ID   int64
	Name string
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readSubnet(row scanner) (Subnet, error) {
	var subnet Subnet
	err := row.Scan(&subnet.ID, &subnet.Name, &subnet.CIDR, &subnet.Gateway, &subnet.VLAN,
		&subnet.Notes, &subnet.Status, &subnet.Role, &subnet.Version, &subnet.VLANName, &subnet.VLANStatus)
	return subnet, err
}

func ListSubnets(ctx context.Context, db *sql.DB) ([]Subnet, error) {
	rows, err := db.QueryContext(ctx, "SELECT "+subnetColumns+" FROM "+subnetFrom+" ORDER BY lower(s.name), s.id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	subnets := make([]Subnet, 0)
	for rows.Next() {
		subnet, err := readSubnet(rows)
		if err != nil {
			return nil, err
		}
		subnets = append(subnets, subnet)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	allocations, err := loadAllocationIPs(ctx, db)
	if err != nil {
		return nil, err
	}
	assets, err := loadAssetIPs(ctx, db)
	if err != nil {
		return nil, err
	}
	for i := range subnets {
		prefix, err := parseSubnet(subnets[i].CIDR)
		if err != nil {
			return nil, err
		}
		addSubnetUsage(&subnets[i], prefix, allocations[subnets[i].ID], assets)
	}
	return subnets, nil
}

func GetSubnet(ctx context.Context, db *sql.DB, id int64) (SubnetDetail, error) {
	subnet, err := readSubnet(db.QueryRowContext(ctx,
		"SELECT "+subnetColumns+" FROM "+subnetFrom+" WHERE s.id=$1", id))
	if err != nil {
		return SubnetDetail{}, err
	}
	prefix, err := parseSubnet(subnet.CIDR)
	if err != nil {
		return SubnetDetail{}, err
	}
	network, broadcast := subnetBounds(prefix)
	assets, err := loadAssetIPs(ctx, db)
	if err != nil {
		return SubnetDetail{}, err
	}
	allocations, err := loadSubnetAllocations(ctx, db, id)
	if err != nil {
		return SubnetDetail{}, err
	}

	used := make(map[netip.Addr]IPUsage)
	for addr, refs := range assets {
		if !prefix.Contains(addr) || addr == network || addr == broadcast || len(refs) == 0 {
			continue
		}
		used[addr] = IPUsage{
			IP: addr.String(), Source: "asset", State: "active",
			AssetID: refs[0].ID, AssetName: refs[0].Name,
		}
	}
	for _, allocation := range allocations {
		addr, err := netip.ParseAddr(allocation.IP)
		if err != nil || !prefix.Contains(addr) || addr == network || addr == broadcast {
			continue
		}
		used[addr] = IPUsage{
			IP: addr.String(), Source: "allocated", State: allocation.Status,
			AssetID: allocation.AssetID, AssetName: allocation.AssetName,
			AllocationID: allocation.ID, Label: allocation.Label, DNSName: allocation.DNSName,
			Role: allocation.Role, Notes: allocation.Notes, Version: allocation.Version,
		}
	}
	if subnet.Gateway != "" {
		if gateway, err := netip.ParseAddr(subnet.Gateway); err == nil {
			used[gateway] = IPUsage{IP: gateway.String(), Source: "gateway", State: "active", Label: "网关"}
		}
	}

	addresses := make([]netip.Addr, 0, len(used))
	for addr := range used {
		addresses = append(addresses, addr)
	}
	sort.Slice(addresses, func(i, j int) bool { return addresses[i].Compare(addresses[j]) < 0 })
	detail := SubnetDetail{Subnet: subnet, UsedIPs: make([]IPUsage, 0, len(addresses))}
	for _, addr := range addresses {
		detail.UsedIPs = append(detail.UsedIPs, used[addr])
	}
	detail.Usable = usableCount(prefix)
	detail.Used = int64(len(used))
	detail.Free = detail.Usable - detail.Used
	if detail.Free < 0 {
		detail.Free = 0
	}
	detail.FreeIPs = freeIPs(prefix, used, freeIPLimit)
	return detail, nil
}

func SaveSubnet(ctx context.Context, db *sql.DB, id int64, fields SubnetFields, version int, actor string) (Subnet, error) {
	prefix, err := normalizeSubnetFields(&fields)
	if err != nil {
		return Subnet{}, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return Subnet{}, err
	}
	defer tx.Rollback()

	if err := checkSubnetOverlap(ctx, tx, id, prefix); err != nil {
		return Subnet{}, err
	}
	vlan, err := canonicalVLAN(ctx, tx, fields.VLAN)
	if err != nil {
		return Subnet{}, err
	}
	fields.VLAN = vlan

	var before Subnet
	action := "subnet_create"
	subnet := Subnet{SubnetFields: fields, Usable: usableCount(prefix)}
	if id == 0 {
		err = tx.QueryRowContext(ctx, `
			INSERT INTO subnets (name,cidr,gateway,vlan,notes,status,role)
			VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,version`,
			fields.Name, fields.CIDR, fields.Gateway, fields.VLAN, fields.Notes,
			fields.Status, fields.Role).Scan(&subnet.ID, &subnet.Version)
	} else {
		before, err = readSubnet(tx.QueryRowContext(ctx,
			"SELECT "+subnetColumns+" FROM "+subnetFrom+" WHERE s.id=$1", id))
		if err != nil {
			return Subnet{}, err
		}
		if before.Version != version {
			return Subnet{}, ErrConflict
		}
		if before.CIDR != fields.CIDR {
			var allocations int
			if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM ip_allocations WHERE subnet_id=$1", id).Scan(&allocations); err != nil {
				return Subnet{}, err
			}
			if allocations > 0 {
				return Subnet{}, invalidFacility("修改网段前请先释放已分配的 IP")
			}
		}
		action = "subnet_update"
		err = tx.QueryRowContext(ctx, `
			UPDATE subnets SET name=$2,cidr=$3,gateway=$4,vlan=$5,notes=$6,status=$7,role=$8,
				version=version+1
			WHERE id=$1 RETURNING version`,
			id, fields.Name, fields.CIDR, fields.Gateway, fields.VLAN, fields.Notes,
			fields.Status, fields.Role).Scan(&subnet.Version)
		subnet.ID = id
	}
	if err != nil {
		return Subnet{}, err
	}
	if fields.VLAN != "" {
		if vlanErr := tx.QueryRowContext(ctx,
			"SELECT name,status FROM vlans WHERE vid=$1", fields.VLAN).Scan(&subnet.VLANName, &subnet.VLANStatus); vlanErr != nil && !errors.Is(vlanErr, sql.ErrNoRows) {
			return Subnet{}, vlanErr
		}
	}
	old := any(nil)
	if id != 0 {
		old = before.SubnetFields
	}
	if err := writeNamedChange(ctx, tx, nil, subnet.Name, actor, action, old, subnet.SubnetFields); err != nil {
		return Subnet{}, err
	}
	if err := tx.Commit(); err != nil {
		return Subnet{}, err
	}
	if detail, detailErr := GetSubnet(ctx, db, subnet.ID); detailErr == nil {
		subnet.Usable, subnet.Used, subnet.Free = detail.Usable, detail.Used, detail.Free
	}
	return subnet, nil
}

func DeleteSubnet(ctx context.Context, db *sql.DB, id int64, version int, actor string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	subnet, err := readSubnet(tx.QueryRowContext(ctx,
		"SELECT "+subnetColumns+" FROM "+subnetFrom+" WHERE s.id=$1", id))
	if err != nil {
		return err
	}
	if subnet.Version != version {
		return ErrConflict
	}
	var allocations int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM ip_allocations WHERE subnet_id=$1", id).Scan(&allocations); err != nil {
		return err
	}
	if allocations > 0 {
		return invalidFacility("请先释放该网段中已分配的 IP")
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM subnets WHERE id=$1", id); err != nil {
		return err
	}
	if err := writeNamedChange(ctx, tx, nil, subnet.Name, actor, "subnet_delete", subnet.SubnetFields, nil); err != nil {
		return err
	}
	return tx.Commit()
}

func SaveAllocation(ctx context.Context, db *sql.DB, subnetID int64, fields AllocationFields, actor string) (Allocation, error) {
	fields.IP = strings.TrimSpace(fields.IP)
	if err := normalizeAllocationFields(&fields); err != nil {
		return Allocation{}, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return Allocation{}, err
	}
	defer tx.Rollback()

	subnet, err := readSubnet(tx.QueryRowContext(ctx,
		"SELECT "+subnetColumns+" FROM "+subnetFrom+" WHERE s.id=$1", subnetID))
	if err != nil {
		return Allocation{}, err
	}
	prefix, err := parseSubnet(subnet.CIDR)
	if err != nil {
		return Allocation{}, err
	}
	network, broadcast := subnetBounds(prefix)
	addr, err := netip.ParseAddr(fields.IP)
	if err != nil || !addr.Is4() {
		return Allocation{}, invalidFacility("IP 地址无效")
	}
	if !prefix.Contains(addr) || addr == network || addr == broadcast {
		return Allocation{}, invalidFacility("IP 地址不在该网段的可用范围内")
	}
	if subnet.Gateway != "" {
		if gateway, parseErr := netip.ParseAddr(subnet.Gateway); parseErr == nil && gateway == addr {
			return Allocation{}, invalidFacility("网关地址不能分配给其他资源")
		}
	}
	assets, err := loadAssetIPs(ctx, tx)
	if err != nil {
		return Allocation{}, err
	}
	if refs := assets[addr]; len(refs) > 0 {
		return Allocation{}, invalidFacility("该 IP 已在资产地址中使用，无需重复分配")
	}
	var exists bool
	if err := tx.QueryRowContext(ctx,
		"SELECT EXISTS (SELECT 1 FROM ip_allocations WHERE ip=$1)",
		addr.String()).Scan(&exists); err != nil {
		return Allocation{}, err
	}
	if exists {
		return Allocation{}, invalidFacility("该 IP 已分配")
	}

	allocation := Allocation{
		AllocationFields: fields, SubnetID: subnetID, SubnetName: subnet.Name, Version: 1,
	}
	if fields.AssetID != 0 {
		var name string
		if err := tx.QueryRowContext(ctx, "SELECT name FROM assets WHERE id=$1", fields.AssetID).Scan(&name); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return Allocation{}, invalidFacility("关联资产不存在")
			}
			return Allocation{}, err
		}
		allocation.AssetName = name
	}
	allocation.IP = addr.String()
	err = tx.QueryRowContext(ctx, `
		INSERT INTO ip_allocations (subnet_id,ip,asset_id,label,notes,status,dns_name,role)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		allocation.SubnetID, allocation.IP, nullID(allocation.AssetID), allocation.Label,
		allocation.Notes, allocation.Status, allocation.DNSName, allocation.Role).Scan(&allocation.ID)
	if err != nil {
		if isUniqueViolation(err) {
			return Allocation{}, invalidFacility("该 IP 已分配")
		}
		return Allocation{}, err
	}
	if err := writeNamedChange(ctx, tx, nil, subnet.Name, actor, "ip_allocate", nil, allocation); err != nil {
		return Allocation{}, err
	}
	return allocation, tx.Commit()
}

func UpdateAllocation(ctx context.Context, db *sql.DB, id int64, version int, fields AllocationFields, actor string) (Allocation, error) {
	if err := normalizeAllocationFields(&fields); err != nil {
		return Allocation{}, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return Allocation{}, err
	}
	defer tx.Rollback()

	before, err := readAllocation(tx.QueryRowContext(ctx, `
		SELECT a.id,a.subnet_id,a.ip,COALESCE(a.asset_id,0),COALESCE(b.name,''),a.label,a.notes,
			a.status,a.dns_name,a.role,a.version,s.name
		FROM ip_allocations a
		JOIN subnets s ON s.id=a.subnet_id
		LEFT JOIN assets b ON b.id=a.asset_id
		WHERE a.id=$1`, id))
	if err != nil {
		return Allocation{}, err
	}
	if before.Version != version {
		return Allocation{}, ErrConflict
	}
	if fields.AssetID != 0 {
		var name string
		if err := tx.QueryRowContext(ctx, "SELECT name FROM assets WHERE id=$1", fields.AssetID).Scan(&name); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return Allocation{}, invalidFacility("关联资产不存在")
			}
			return Allocation{}, err
		}
	}
	fields.IP = before.IP
	if fields.AssetID == before.AssetID && fields.Label == before.Label && fields.Notes == before.Notes &&
		fields.Status == before.Status && fields.DNSName == before.DNSName && fields.Role == before.Role {
		return before, tx.Commit()
	}
	allocation, err := readAllocation(tx.QueryRowContext(ctx, `
		UPDATE ip_allocations SET asset_id=$2,label=$3,notes=$4,status=$5,dns_name=$6,role=$7,
			version=version+1 WHERE id=$1
		RETURNING id,subnet_id,ip,COALESCE(asset_id,0),
			COALESCE((SELECT name FROM assets WHERE id=asset_id),''),label,notes,status,dns_name,role,version,
			COALESCE((SELECT name FROM subnets WHERE id=subnet_id),'')`,
		id, nullID(fields.AssetID), fields.Label, fields.Notes, fields.Status, fields.DNSName, fields.Role))
	if err != nil {
		return Allocation{}, err
	}
	if err := writeNamedChange(ctx, tx, nil, allocation.SubnetName, actor, "ip_update", before, allocation); err != nil {
		return Allocation{}, err
	}
	return allocation, tx.Commit()
}

func DeleteAllocation(ctx context.Context, db *sql.DB, id int64, version int, actor string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	allocation, err := readAllocation(tx.QueryRowContext(ctx, `
		SELECT a.id,a.subnet_id,a.ip,COALESCE(a.asset_id,0),COALESCE(b.name,''),a.label,a.notes,
			a.status,a.dns_name,a.role,a.version,s.name
		FROM ip_allocations a
		JOIN subnets s ON s.id=a.subnet_id
		LEFT JOIN assets b ON b.id=a.asset_id
		WHERE a.id=$1`, id))
	if err != nil {
		return err
	}
	if allocation.Version != version {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM ip_allocations WHERE id=$1", id); err != nil {
		return err
	}
	if err := writeNamedChange(ctx, tx, nil, allocation.SubnetName, actor, "ip_release", allocation, nil); err != nil {
		return err
	}
	return tx.Commit()
}

func readAllocation(row scanner) (Allocation, error) {
	var allocation Allocation
	err := row.Scan(&allocation.ID, &allocation.SubnetID, &allocation.IP, &allocation.AssetID,
		&allocation.AssetName, &allocation.Label, &allocation.Notes, &allocation.Status,
		&allocation.DNSName, &allocation.Role, &allocation.Version, &allocation.SubnetName)
	return allocation, err
}

func normalizeSubnetFields(fields *SubnetFields) (netip.Prefix, error) {
	fields.Name = strings.TrimSpace(fields.Name)
	fields.CIDR = strings.TrimSpace(fields.CIDR)
	fields.Gateway = strings.TrimSpace(fields.Gateway)
	fields.VLAN = strings.TrimSpace(fields.VLAN)
	fields.Notes = strings.TrimSpace(fields.Notes)
	fields.Status = strings.TrimSpace(fields.Status)
	fields.Role = strings.TrimSpace(fields.Role)
	if nameLen := utf8.RuneCountInString(fields.Name); nameLen < 1 || nameLen > 160 {
		return netip.Prefix{}, invalidFacility("网段名称须为 1–160 个字符")
	}
	if fields.Status == "" {
		fields.Status = "active"
	}
	if !subnetStatuses[fields.Status] {
		return netip.Prefix{}, invalidFacility("网段状态无效")
	}
	if utf8.RuneCountInString(fields.Role) > 80 {
		return netip.Prefix{}, invalidFacility("网段用途不能超过 80 个字符")
	}
	prefix, err := parseSubnet(fields.CIDR)
	if err != nil {
		return netip.Prefix{}, err
	}
	fields.CIDR = prefix.String()
	if len(fields.VLAN) > 80 || len(fields.Notes) > 2000 {
		return netip.Prefix{}, invalidFacility("VLAN 或备注超出长度限制")
	}
	if fields.Gateway != "" {
		gateway, err := netip.ParseAddr(fields.Gateway)
		if err != nil || !gateway.Is4() {
			return netip.Prefix{}, invalidFacility("网关地址无效")
		}
		network, broadcast := subnetBounds(prefix)
		if !prefix.Contains(gateway) || gateway == network || gateway == broadcast {
			return netip.Prefix{}, invalidFacility("网关地址须位于该网段的可用范围内")
		}
		fields.Gateway = gateway.String()
	}
	return prefix, nil
}

func normalizeAllocationFields(fields *AllocationFields) error {
	fields.Label = strings.TrimSpace(fields.Label)
	fields.Notes = strings.TrimSpace(fields.Notes)
	fields.Status = strings.TrimSpace(fields.Status)
	fields.DNSName = strings.TrimSpace(fields.DNSName)
	fields.Role = strings.TrimSpace(fields.Role)
	if fields.Status == "" {
		fields.Status = "active"
	}
	if !allocationStatuses[fields.Status] {
		return invalidFacility("IP 地址状态无效")
	}
	if !allocationRoles[fields.Role] {
		return invalidFacility("IP 地址角色无效")
	}
	if len(fields.Label) > 160 || len(fields.Notes) > 2000 {
		return invalidFacility("标签或备注超出长度限制")
	}
	if len(fields.DNSName) > 255 {
		return invalidFacility("DNS 名称不能超过 255 个字符")
	}
	if fields.DNSName != "" && !dnsNamePattern.MatchString(fields.DNSName) {
		return invalidFacility("DNS 名称格式无效，请填写主机名或完整域名")
	}
	return nil
}

func canonicalVLAN(ctx context.Context, q queryer, value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	vid, err := strconv.Atoi(value)
	if err != nil {
		vid = 0
	}
	var matched int
	err = q.QueryRowContext(ctx,
		`SELECT vid FROM vlans WHERE vid=$1 OR lower(name)=lower($2) ORDER BY vid LIMIT 1`,
		vid, value).Scan(&matched)
	if errors.Is(err, sql.ErrNoRows) {
		return "", invalidFacility("VLAN " + value + " 未登记，请先在 VLAN 管理中创建")
	}
	if err != nil {
		return "", err
	}
	return strconv.Itoa(matched), nil
}

func parseSubnet(value string) (netip.Prefix, error) {
	prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
	if err != nil || !prefix.Addr().Is4() {
		return netip.Prefix{}, invalidFacility("网段须为 IPv4 CIDR，例如 192.168.1.0/24")
	}
	prefix = prefix.Masked()
	if bits := prefix.Bits(); bits < 8 || bits > 30 {
		return netip.Prefix{}, invalidFacility("网段前缀须在 /8 到 /30 之间")
	}
	return prefix, nil
}

func subnetBounds(prefix netip.Prefix) (netip.Addr, netip.Addr) {
	a4 := prefix.Masked().Addr().As4()
	network := binary.BigEndian.Uint32(a4[:])
	hostBits := uint32(32 - prefix.Bits())
	broadcast := network | (uint32(1)<<hostBits - 1)
	var last [4]byte
	binary.BigEndian.PutUint32(last[:], broadcast)
	return prefix.Masked().Addr(), netip.AddrFrom4(last)
}

func usableCount(prefix netip.Prefix) int64 {
	return (int64(1) << uint(32-prefix.Bits())) - 2
}

func addSubnetUsage(subnet *Subnet, prefix netip.Prefix, allocations []netip.Addr, assets map[netip.Addr][]assetRef) {
	network, broadcast := subnetBounds(prefix)
	used := make(map[netip.Addr]struct{})
	if subnet.Gateway != "" {
		if gateway, err := netip.ParseAddr(subnet.Gateway); err == nil && prefix.Contains(gateway) && gateway != network && gateway != broadcast {
			used[gateway] = struct{}{}
		}
	}
	for _, addr := range allocations {
		if prefix.Contains(addr) && addr != network && addr != broadcast {
			used[addr] = struct{}{}
		}
	}
	for addr := range assets {
		if prefix.Contains(addr) && addr != network && addr != broadcast {
			used[addr] = struct{}{}
		}
	}
	subnet.Usable = usableCount(prefix)
	subnet.Used = int64(len(used))
	subnet.Free = subnet.Usable - subnet.Used
	if subnet.Free < 0 {
		subnet.Free = 0
	}
}

func freeIPs(prefix netip.Prefix, used map[netip.Addr]IPUsage, limit int) []string {
	network, broadcast := subnetBounds(prefix)
	result := make([]string, 0, limit)
	for addr := network.Next(); addr.IsValid() && addr.Compare(broadcast) < 0 && len(result) < limit; addr = addr.Next() {
		if _, exists := used[addr]; !exists {
			result = append(result, addr.String())
		}
	}
	return result
}

func loadAssetIPs(ctx context.Context, q queryer) (map[netip.Addr][]assetRef, error) {
	rows, err := q.QueryContext(ctx, "SELECT id,name,address FROM assets")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[netip.Addr][]assetRef)
	for rows.Next() {
		var id int64
		var name, address string
		if err := rows.Scan(&id, &name, &address); err != nil {
			return nil, err
		}
		for _, addr := range parseAssetAddresses(address) {
			result[addr] = append(result[addr], assetRef{ID: id, Name: name})
		}
	}
	return result, rows.Err()
}

func parseAssetAddresses(value string) []netip.Addr {
	seen := make(map[netip.Addr]struct{})
	result := make([]netip.Addr, 0)
	for _, token := range strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == ';' || r == '，' || r == '；' || unicode.IsSpace(r)
	}) {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		var addr netip.Addr
		if parsed, err := netip.ParseAddr(token); err == nil {
			addr = parsed
		} else if parsed, err := netip.ParsePrefix(token); err == nil {
			addr = parsed.Addr()
		} else {
			continue
		}
		if !addr.Is4() {
			continue
		}
		if _, exists := seen[addr]; exists {
			continue
		}
		seen[addr] = struct{}{}
		result = append(result, addr)
	}
	return result
}

func loadAllocationIPs(ctx context.Context, q queryer) (map[int64][]netip.Addr, error) {
	rows, err := q.QueryContext(ctx, "SELECT subnet_id,ip FROM ip_allocations")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[int64][]netip.Addr)
	for rows.Next() {
		var subnetID int64
		var raw string
		if err := rows.Scan(&subnetID, &raw); err != nil {
			return nil, err
		}
		addr, err := netip.ParseAddr(raw)
		if err != nil {
			continue
		}
		result[subnetID] = append(result[subnetID], addr)
	}
	return result, rows.Err()
}

func loadSubnetAllocations(ctx context.Context, q queryer, subnetID int64) ([]Allocation, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT a.id,a.subnet_id,a.ip,COALESCE(a.asset_id,0),COALESCE(b.name,''),a.label,a.notes,
			a.status,a.dns_name,a.role,a.version,s.name
		FROM ip_allocations a
		JOIN subnets s ON s.id=a.subnet_id
		LEFT JOIN assets b ON b.id=a.asset_id
		WHERE a.subnet_id=$1 ORDER BY a.ip`, subnetID)
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

func checkSubnetOverlap(ctx context.Context, q queryer, id int64, prefix netip.Prefix) error {
	rows, err := q.QueryContext(ctx, "SELECT id,cidr FROM subnets WHERE id<>$1", id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var otherID int64
		var otherCIDR string
		if err := rows.Scan(&otherID, &otherCIDR); err != nil {
			return err
		}
		other, err := parseSubnet(otherCIDR)
		if err != nil {
			return err
		}
		if prefix.Overlaps(other) {
			// CIDR blocks are either disjoint or nested. A parent prefix may
			// aggregate child prefixes, but the same prefix cannot be added twice.
			if prefix.Addr() == other.Addr() && prefix.Bits() == other.Bits() {
				return invalidFacility(fmt.Sprintf("网段 %s 已存在", otherCIDR))
			}
			if prefix.Bits() < other.Bits() && prefix.Contains(other.Addr()) {
				continue
			}
			if other.Bits() < prefix.Bits() && other.Contains(prefix.Addr()) {
				continue
			}
			return invalidFacility(fmt.Sprintf("网段与已有网段 %s 重叠", otherCIDR))
		}
	}
	return rows.Err()
}

func nullID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}
