package cmdb

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrConflict = errors.New("记录已被更新，请刷新后重试")

type Fields struct {
	Kind        string          `json:"kind"`
	Name        string          `json:"name"`
	Platform    string          `json:"platform"`
	Status      string          `json:"status"`
	Lifecycle   string          `json:"lifecycle"`
	Owner       string          `json:"owner"`
	Environment string          `json:"environment"`
	Address     string          `json:"address"`
	CPU         int             `json:"cpu"`
	MemoryMiB   int64           `json:"memoryMiB"`
	Notes       string          `json:"notes"`
	Attributes  json.RawMessage `json:"attributes"`
}

type Asset struct {
	Fields
	ID           int64           `json:"id"`
	Version      int             `json:"version"`
	UpdatedAt    time.Time       `json:"updatedAt"`
	SourceKey    string          `json:"sourceKey,omitempty"`
	ExternalKey  string          `json:"externalKey,omitempty"`
	LastSeenAt   *time.Time      `json:"lastSeenAt,omitempty"`
	MissingCount int             `json:"missingCount"`
	Observed     json.RawMessage `json:"observed"`
}

type Link struct {
	ID        int64  `json:"id"`
	Kind      string `json:"kind"`
	FromID    int64  `json:"fromId"`
	FromName  string `json:"fromName"`
	ToID      int64  `json:"toId"`
	ToName    string `json:"toName"`
	SourceKey string `json:"sourceKey,omitempty"`
}

type Change struct {
	ID        int64           `json:"id"`
	AssetID   int64           `json:"assetId"`
	AssetName string          `json:"assetName"`
	Actor     string          `json:"actor"`
	Action    string          `json:"action"`
	Before    json.RawMessage `json:"before"`
	After     json.RawMessage `json:"after"`
	CreatedAt time.Time       `json:"createdAt"`
}

const assetColumns = `id, kind, name, platform, status, lifecycle, owner, environment, address, cpu,
	memory_mib, notes, attributes, version, updated_at, COALESCE(source_key, ''),
	COALESCE(external_key, ''), last_seen_at, missing_count, observed`

type scanner interface{ Scan(...any) error }

func readAsset(row scanner) (Asset, error) {
	var a Asset
	var attributes, observed string
	err := row.Scan(&a.ID, &a.Kind, &a.Name, &a.Platform, &a.Status, &a.Lifecycle, &a.Owner,
		&a.Environment, &a.Address, &a.CPU, &a.MemoryMiB, &a.Notes, &attributes,
		&a.Version, &a.UpdatedAt, &a.SourceKey, &a.ExternalKey, &a.LastSeenAt, &a.MissingCount, &observed)
	a.Attributes = json.RawMessage(attributes)
	a.Observed = json.RawMessage(observed)
	return a, err
}

func ListAssets(ctx context.Context, db *sql.DB) ([]Asset, error) {
	rows, err := db.QueryContext(ctx, "SELECT "+assetColumns+" FROM assets ORDER BY lower(name), id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	assets := make([]Asset, 0)
	for rows.Next() {
		asset, err := readAsset(rows)
		if err != nil {
			return nil, err
		}
		assets = append(assets, asset)
	}
	return assets, rows.Err()
}

func ListLinks(ctx context.Context, db *sql.DB, assetID int64) ([]Link, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT l.id, l.kind, a.id, a.name, b.id, b.name, COALESCE(l.source_key, '')
		FROM asset_links l JOIN assets a ON a.id=l.from_id JOIN assets b ON b.id=l.to_id
		WHERE $1=0 OR a.id=$1 OR b.id=$1 ORDER BY l.kind, a.name, b.name, l.id`, assetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	links := make([]Link, 0)
	for rows.Next() {
		var link Link
		if err := rows.Scan(&link.ID, &link.Kind, &link.FromID, &link.FromName,
			&link.ToID, &link.ToName, &link.SourceKey); err != nil {
			return nil, err
		}
		links = append(links, link)
	}
	return links, rows.Err()
}

func ListChanges(ctx context.Context, db *sql.DB, assetID int64) ([]Change, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, COALESCE(asset_id, 0), asset_name, actor, action,
			COALESCE(before_data, 'null'), COALESCE(after_data, 'null'), created_at
		FROM changes WHERE $1=0 OR asset_id=$1 ORDER BY id DESC LIMIT 100`, assetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	changes := make([]Change, 0)
	for rows.Next() {
		var change Change
		var before, after string
		if err := rows.Scan(&change.ID, &change.AssetID, &change.AssetName, &change.Actor,
			&change.Action, &before, &after, &change.CreatedAt); err != nil {
			return nil, err
		}
		change.Before = json.RawMessage(before)
		change.After = json.RawMessage(after)
		changes = append(changes, change)
	}
	return changes, rows.Err()
}

func SaveAsset(ctx context.Context, db *sql.DB, id int64, version int, fields Fields, actor string) (Asset, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return Asset{}, err
	}
	defer tx.Rollback()

	if id == 0 {
		asset, err := createAsset(ctx, tx, fields, actor)
		if err != nil {
			return Asset{}, err
		}
		return asset, tx.Commit()
	}

	before, err := readAsset(tx.QueryRowContext(ctx, "SELECT "+assetColumns+" FROM assets WHERE id=$1", id))
	if err != nil {
		return Asset{}, err
	}
	if version != before.Version {
		return Asset{}, ErrConflict
	}
	if fields.Kind != before.Kind {
		return Asset{}, ErrConflict
	}
	if equalFields(fields, before.Fields) {
		return before, tx.Commit()
	}

	asset, err := readAsset(tx.QueryRowContext(ctx, `
		UPDATE assets SET name=$2, platform=$3, status=$4, lifecycle=$5, owner=$6, environment=$7,
			address=$8, cpu=$9, memory_mib=$10, notes=$11, attributes=$12, version=version+1, updated_at=$13
		WHERE id=$1 RETURNING `+assetColumns, id, fields.Name, fields.Platform, fields.Status,
		fields.Lifecycle, fields.Owner, fields.Environment, fields.Address, fields.CPU, fields.MemoryMiB,
		fields.Notes, string(fields.Attributes), nowText()))
	if err != nil {
		return Asset{}, err
	}
	if err := writeChange(ctx, tx, asset, actor, "update", before.Fields, asset.Fields); err != nil {
		return Asset{}, err
	}
	return asset, tx.Commit()
}

func createAsset(ctx context.Context, tx *sql.Tx, fields Fields, actor string) (Asset, error) {
	asset, err := readAsset(tx.QueryRowContext(ctx, `
		INSERT INTO assets (kind, name, platform, status, lifecycle, owner, environment, address,
			cpu, memory_mib, notes, attributes, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING `+assetColumns,
		fields.Kind, fields.Name, fields.Platform, fields.Status, fields.Lifecycle, fields.Owner,
		fields.Environment, fields.Address, fields.CPU, fields.MemoryMiB, fields.Notes,
		string(fields.Attributes), nowText()))
	if err != nil {
		return Asset{}, err
	}
	return asset, writeChange(ctx, tx, asset, actor, "create", nil, asset.Fields)
}

func equalFields(a, b Fields) bool {
	aJSON, err := json.Marshal(a)
	if err != nil {
		return false
	}
	bJSON, err := json.Marshal(b)
	if err != nil {
		return false
	}
	var left, right any
	leftDecoder := json.NewDecoder(strings.NewReader(string(aJSON)))
	rightDecoder := json.NewDecoder(strings.NewReader(string(bJSON)))
	leftDecoder.UseNumber()
	rightDecoder.UseNumber()
	if leftDecoder.Decode(&left) != nil || rightDecoder.Decode(&right) != nil {
		return false
	}
	normalizedLeft, _ := json.Marshal(left)
	normalizedRight, _ := json.Marshal(right)
	return string(normalizedLeft) == string(normalizedRight)
}

func ChangeLink(ctx context.Context, db *sql.DB, link Link, remove bool, actor string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if remove {
		err := tx.QueryRowContext(ctx, `
			DELETE FROM asset_links WHERE id=$1 AND source_key IS NULL
			RETURNING from_id, to_id, kind`, link.ID).Scan(&link.FromID, &link.ToID, &link.Kind)
		if err != nil {
			return err
		}
	}
	from, err := readAsset(tx.QueryRowContext(ctx, "SELECT "+assetColumns+" FROM assets WHERE id=$1", link.FromID))
	if err != nil {
		return err
	}
	to, err := readAsset(tx.QueryRowContext(ctx, "SELECT "+assetColumns+" FROM assets WHERE id=$1", link.ToID))
	if err != nil {
		return err
	}
	link.FromName, link.ToName = from.Name, to.Name
	if remove {
		if err := writeChange(ctx, tx, from, actor, "unlink", link, nil); err != nil {
			return err
		}
		if err := writeChange(ctx, tx, to, actor, "unlink", link, nil); err != nil {
			return err
		}
		return tx.Commit()
	}
	if !ValidLink(link.Kind, from.Kind, to.Kind) {
		return fmt.Errorf("%w: 所选资源类型与关系不匹配", ErrInvalid)
	}
	err = tx.QueryRowContext(ctx, `
		INSERT INTO asset_links (from_id,to_id,kind) VALUES ($1,$2,$3) RETURNING id`,
		link.FromID, link.ToID, link.Kind).Scan(&link.ID)
	if err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("%w: 此关系已存在，或目标已关联到另一上级资源", ErrInvalid)
		}
		return err
	}
	if err := writeChange(ctx, tx, from, actor, "link", nil, link); err != nil {
		return err
	}
	if err := writeChange(ctx, tx, to, actor, "link", nil, link); err != nil {
		return err
	}
	return tx.Commit()
}

func ValidLink(kind, from, to string) bool {
	switch kind {
	case "hosts":
		return from == "host" && to == "vm"
	default:
		return false
	}
}

func writeChange(ctx context.Context, tx *sql.Tx, asset Asset, actor, action string, before, after any) error {
	return writeNamedChange(ctx, tx, asset.ID, asset.Name, actor, action, before, after)
}

func writeNamedChange(ctx context.Context, tx *sql.Tx, assetID any, name, actor, action string, before, after any) error {
	oldData, err := json.Marshal(before)
	if err != nil {
		return err
	}
	newData, err := json.Marshal(after)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO changes (asset_id, asset_name, actor, action, before_data, after_data)
		VALUES ($1,$2,$3,$4,$5,$6)`, assetID, name, actor, action, string(oldData), string(newData))
	return err
}
