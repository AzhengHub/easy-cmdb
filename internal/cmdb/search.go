package cmdb

import (
	"context"
	"database/sql"
	"strconv"
	"strings"
	"unicode/utf8"
)

type SearchResult struct {
	Type     string `json:"type"`
	ID       int64  `json:"id"`
	Label    string `json:"label"`
	Detail   string `json:"detail"`
	Kind     string `json:"kind,omitempty"`
	Status   string `json:"status,omitempty"`
	Address  string `json:"address,omitempty"`
	AssetID  int64  `json:"assetId,omitempty"`
	RoomID   int64  `json:"roomId,omitempty"`
	RackID   int64  `json:"rackId,omitempty"`
	SubnetID int64  `json:"subnetId,omitempty"`
	VLANID   int64  `json:"vlanId,omitempty"`
	TagID    int64  `json:"tagId,omitempty"`
	Color    string `json:"color,omitempty"`
}

const (
	searchPerType = 5
	searchMaxRune = 80
)

func escapeSearchLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

func searchLike(query string) (pattern, prefix string) {
	escaped := strings.ToLower(escapeSearchLike(query))
	return "%" + escaped + "%", escaped + "%"
}

// Search performs a small, typo-friendly lookup across the objects a CMDB user
// tends to search for. Each object type is capped independently so one large
// table cannot drown out the others.
func Search(ctx context.Context, db *sql.DB, raw string) ([]SearchResult, error) {
	query := strings.TrimSpace(raw)
	if utf8.RuneCountInString(query) < 2 {
		return []SearchResult{}, nil
	}
	if utf8.RuneCountInString(query) > searchMaxRune {
		query = string([]rune(query)[:searchMaxRune])
	}
	pattern, prefix := searchLike(query)

	results := make([]SearchResult, 0, searchPerType*6)
	assets, err := searchAssets(ctx, db, query, pattern, prefix)
	if err != nil {
		return nil, err
	}
	results = append(results, assets...)

	tags, err := searchTags(ctx, db, query, pattern, prefix)
	if err != nil {
		return nil, err
	}
	results = append(results, tags...)

	rooms, err := searchRooms(ctx, db, query, pattern, prefix)
	if err != nil {
		return nil, err
	}
	results = append(results, rooms...)

	racks, err := searchRacks(ctx, db, pattern, prefix)
	if err != nil {
		return nil, err
	}
	results = append(results, racks...)

	subnets, err := searchSubnets(ctx, db, pattern, prefix)
	if err != nil {
		return nil, err
	}
	results = append(results, subnets...)

	vlans, err := searchVLANs(ctx, db, pattern, prefix)
	if err != nil {
		return nil, err
	}
	results = append(results, vlans...)

	ips, err := searchIPs(ctx, db, query, pattern)
	if err != nil {
		return nil, err
	}
	results = append(results, ips...)
	return results, nil
}

func searchAssets(ctx context.Context, db *sql.DB, query, pattern, prefix string) ([]SearchResult, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, name, kind, status, address, owner
		FROM assets
		WHERE lower(name) LIKE ? ESCAPE '\'
		   OR lower(address) LIKE ? ESCAPE '\'
		   OR lower(owner) LIKE ? ESCAPE '\'
		   OR lower(notes) LIKE ? ESCAPE '\'
		   OR lower(attributes) LIKE ? ESCAPE '\'
		ORDER BY CASE
			WHEN lower(name) = ? THEN 0
			WHEN lower(name) LIKE ? ESCAPE '\' THEN 1
			ELSE 2
		END, lower(name)
		LIMIT ?`,
		pattern, pattern, pattern, pattern, pattern,
		strings.ToLower(query), prefix, searchPerType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SearchResult
	for rows.Next() {
		var result SearchResult
		var address, owner string
		if err := rows.Scan(&result.ID, &result.Label, &result.Kind, &result.Status, &address, &owner); err != nil {
			return nil, err
		}
		result.Type = "asset"
		result.AssetID = result.ID
		result.Address = address
		parts := []string{}
		if address != "" {
			parts = append(parts, address)
		}
		if owner != "" {
			parts = append(parts, owner)
		}
		result.Detail = strings.Join(parts, " · ")
		out = append(out, result)
	}
	return out, rows.Err()
}

func searchTags(ctx context.Context, db *sql.DB, query, pattern, prefix string) ([]SearchResult, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT t.id, t.name, t.color, t.description,
			(SELECT count(*) FROM asset_tags at WHERE at.tag_id = t.id)
		FROM tags t
		WHERE lower(t.name) LIKE ? ESCAPE '\' OR lower(t.description) LIKE ? ESCAPE '\'
		ORDER BY CASE
			WHEN lower(t.name) = ? THEN 0
			WHEN lower(t.name) LIKE ? ESCAPE '\' THEN 1
			ELSE 2
		END, lower(t.name)
		LIMIT ?`,
		pattern, pattern, strings.ToLower(query), prefix, searchPerType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SearchResult
	for rows.Next() {
		var result SearchResult
		var description string
		var count int64
		if err := rows.Scan(&result.ID, &result.Label, &result.Color, &description, &count); err != nil {
			return nil, err
		}
		result.Type = "tag"
		result.TagID = result.ID
		parts := []string{"标签"}
		if count > 0 {
			parts = append(parts, strconv.FormatInt(count, 10)+" 个资产")
		}
		if description != "" {
			parts = append(parts, description)
		}
		result.Detail = strings.Join(parts, " · ")
		out = append(out, result)
	}
	return out, rows.Err()
}

func searchRooms(ctx context.Context, db *sql.DB, query, pattern, prefix string) ([]SearchResult, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, name
		FROM rooms
		WHERE lower(name) LIKE ? ESCAPE '\'
		ORDER BY CASE
			WHEN lower(name) = ? THEN 0
			WHEN lower(name) LIKE ? ESCAPE '\' THEN 1
			ELSE 2
		END, lower(name)
		LIMIT ?`,
		pattern, strings.ToLower(query), prefix, searchPerType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SearchResult
	for rows.Next() {
		var result SearchResult
		if err := rows.Scan(&result.ID, &result.Label); err != nil {
			return nil, err
		}
		result.Type = "room"
		result.RoomID = result.ID
		result.Detail = "数据中心"
		out = append(out, result)
	}
	return out, rows.Err()
}

func searchRacks(ctx context.Context, db *sql.DB, pattern, prefix string) ([]SearchResult, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT r.id, r.name, r.room_id, rm.name, r.height_u
		FROM racks r
		JOIN rooms rm ON rm.id = r.room_id
		WHERE lower(r.name) LIKE ? ESCAPE '\' OR lower(rm.name) LIKE ? ESCAPE '\'
		ORDER BY CASE WHEN lower(r.name) LIKE ? ESCAPE '\' THEN 0 ELSE 1 END, lower(r.name)
		LIMIT ?`,
		pattern, pattern, prefix, searchPerType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SearchResult
	for rows.Next() {
		var result SearchResult
		var roomName string
		var height int
		if err := rows.Scan(&result.ID, &result.Label, &result.RoomID, &roomName, &height); err != nil {
			return nil, err
		}
		result.Type = "rack"
		result.RackID = result.ID
		result.Detail = roomName + " · " + strconv.Itoa(height) + "U"
		out = append(out, result)
	}
	return out, rows.Err()
}

func searchSubnets(ctx context.Context, db *sql.DB, pattern, prefix string) ([]SearchResult, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, name, cidr, vlan
		FROM subnets
		WHERE lower(name) LIKE ? ESCAPE '\' OR lower(cidr) LIKE ? ESCAPE '\' OR lower(vlan) LIKE ? ESCAPE '\'
		ORDER BY CASE WHEN lower(cidr) LIKE ? ESCAPE '\' THEN 0 ELSE 1 END, lower(name)
		LIMIT ?`,
		pattern, pattern, pattern, prefix, searchPerType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SearchResult
	for rows.Next() {
		var result SearchResult
		var cidr, vlan string
		if err := rows.Scan(&result.ID, &result.Label, &cidr, &vlan); err != nil {
			return nil, err
		}
		result.Type = "subnet"
		result.SubnetID = result.ID
		result.Detail = cidr
		if vlan != "" {
			result.Detail += " · VLAN " + vlan
		}
		out = append(out, result)
	}
	return out, rows.Err()
}

func searchVLANs(ctx context.Context, db *sql.DB, pattern, prefix string) ([]SearchResult, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, vid, name, status, description
		FROM vlans
		WHERE CAST(vid AS TEXT) LIKE ? ESCAPE '\'
		   OR lower(name) LIKE ? ESCAPE '\'
		   OR lower(description) LIKE ? ESCAPE '\'
		ORDER BY CASE WHEN CAST(vid AS TEXT) LIKE ? ESCAPE '\' THEN 0 ELSE 1 END, vid
		LIMIT ?`,
		pattern, pattern, pattern, prefix, searchPerType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SearchResult
	for rows.Next() {
		var result SearchResult
		var vid int
		var name, status, description string
		if err := rows.Scan(&result.ID, &vid, &name, &status, &description); err != nil {
			return nil, err
		}
		result.Type = "vlan"
		result.VLANID = result.ID
		result.Label = "VLAN " + strconv.Itoa(vid) + " · " + name
		result.Status = status
		parts := []string{"VLAN " + strconv.Itoa(vid)}
		if description != "" {
			parts = append(parts, description)
		}
		result.Detail = strings.Join(parts, " · ")
		out = append(out, result)
	}
	return out, rows.Err()
}

func searchIPs(ctx context.Context, db *sql.DB, query, pattern string) ([]SearchResult, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT a.id, a.ip, a.subnet_id, s.name, COALESCE(a.asset_id, 0), COALESCE(asset.name, ''),
			COALESCE(a.label, ''), a.status, COALESCE(a.dns_name, '')
		FROM ip_allocations a
		JOIN subnets s ON s.id = a.subnet_id
		LEFT JOIN assets asset ON asset.id = a.asset_id
		WHERE a.ip LIKE ? ESCAPE '\'
		   OR lower(a.label) LIKE ? ESCAPE '\'
		   OR lower(a.dns_name) LIKE ? ESCAPE '\'
		   OR lower(asset.name) LIKE ? ESCAPE '\'
		ORDER BY CASE WHEN a.ip = ? THEN 0 ELSE 1 END, a.ip
		LIMIT ?`,
		pattern, pattern, pattern, pattern, strings.TrimSpace(query), searchPerType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SearchResult
	for rows.Next() {
		var result SearchResult
		var subnetName, assetName, label, state, dnsName string
		if err := rows.Scan(&result.ID, &result.Label, &result.SubnetID, &subnetName,
			&result.AssetID, &assetName, &label, &state, &dnsName); err != nil {
			return nil, err
		}
		result.Type = "ip"
		result.Status = state
		parts := []string{}
		if dnsName != "" {
			parts = append(parts, dnsName)
		}
		if label != "" {
			parts = append(parts, label)
		}
		if assetName != "" {
			parts = append(parts, assetName)
		}
		if subnetName != "" {
			parts = append(parts, subnetName)
		}
		result.Detail = strings.Join(parts, " · ")
		out = append(out, result)
	}
	return out, rows.Err()
}
