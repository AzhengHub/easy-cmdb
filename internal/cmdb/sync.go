package cmdb

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type Observation struct {
	Key       string
	Kind      string
	Name      string
	Status    string
	CPU       int
	MemoryMiB int64
	Details   json.RawMessage
}

type ObservedLink struct {
	FromKey string
	ToKey   string
	Kind    string
}

type Snapshot struct {
	Assets []Observation
	Links  []ObservedLink
}

type SyncRun struct {
	SourceKey     string     `json:"sourceKey"`
	Platform      string     `json:"platform"`
	Status        string     `json:"status"`
	Message       string     `json:"message"`
	ResourceCount int        `json:"resourceCount"`
	FinishedAt    time.Time  `json:"finishedAt"`
	LastSuccessAt *time.Time `json:"lastSuccessAt"`
}

func ListSyncRuns(ctx context.Context, db *sql.DB) ([]SyncRun, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT source_key,platform,status,message,resource_count,finished_at,last_success_at
		FROM sync_runs ORDER BY source_key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := make([]SyncRun, 0)
	for rows.Next() {
		var run SyncRun
		if err := rows.Scan(&run.SourceKey, &run.Platform, &run.Status, &run.Message, &run.ResourceCount,
			&run.FinishedAt, &run.LastSuccessAt); err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func RecordSyncFailure(ctx context.Context, db interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, key, platform, message string) error {
	_, err := db.ExecContext(ctx, `
		INSERT INTO sync_runs (source_key,platform,status,message) VALUES ($1,$2,'failed',$3)
		ON CONFLICT (source_key) DO UPDATE SET status='failed',message=EXCLUDED.message,finished_at=now()`,
		key, platform, message)
	return err
}

func ApplySnapshot(ctx context.Context, db interface {
	BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error)
}, key, platform string, snapshot Snapshot) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(5843202, hashtext($1))", key); err != nil {
		return err
	}

	rows, err := tx.QueryContext(ctx, "SELECT "+assetColumns+" FROM assets WHERE source_key=$1 ORDER BY id FOR UPDATE", key)
	if err != nil {
		return err
	}
	previous := make(map[string]Asset)
	for rows.Next() {
		asset, err := readAsset(rows)
		if err != nil {
			rows.Close()
			return err
		}
		previous[asset.ExternalKey] = asset
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	seen := make(map[string]Asset)
	actor := "采集/" + key
	for _, observation := range snapshot.Assets {
		if observation.Key == "" || observation.Name == "" {
			return errors.New("数据源返回了缺少标识或名称的资源")
		}
		if _, exists := seen[observation.Key]; exists {
			return fmt.Errorf("数据源返回了重复标识 %s", observation.Key)
		}
		before := previous[observation.Key]
		if before.ID != 0 && (before.Kind != observation.Kind || before.Platform != platform) {
			return fmt.Errorf("资源 %s 的类型或平台与已有记录冲突", observation.Key)
		}
		asset, err := applyObservation(ctx, tx, key, platform, actor, observation, before)
		if err != nil {
			return err
		}
		seen[observation.Key] = asset
	}

	for _, relation := range snapshot.Links {
		from, fromOK := seen[relation.FromKey]
		to, toOK := seen[relation.ToKey]
		if !fromOK || !toOK || !ValidLink(relation.Kind, from.Kind, to.Kind) {
			return errors.New("数据源返回了不完整的资源关系")
		}
		if err := syncLink(ctx, tx, key, actor, relation.Kind, from, to); err != nil {
			return err
		}
	}

	for externalKey, asset := range previous {
		if _, found := seen[externalKey]; found || asset.MissingCount >= 2 || asset.Lifecycle == "retired" {
			continue
		}
		if _, err := tx.ExecContext(ctx, "UPDATE assets SET missing_count=missing_count+1 WHERE id=$1", asset.ID); err != nil {
			return err
		}
		if asset.MissingCount == 1 {
			if err := writeChange(ctx, tx, asset, actor, "missing", nil, map[string]int{"missingCount": 2}); err != nil {
				return err
			}
		}
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO sync_runs (source_key,platform,status,resource_count,last_success_at)
		VALUES ($1,$2,'ok',$3,now())
		ON CONFLICT (source_key) DO UPDATE SET status='ok',message='',resource_count=EXCLUDED.resource_count,
		finished_at=now(),last_success_at=now()`, key, platform, len(seen))
	if err != nil {
		return err
	}
	return tx.Commit()
}

func applyObservation(ctx context.Context, tx *sql.Tx, key, platform, actor string, item Observation, before Asset) (Asset, error) {
	if len(item.Details) == 0 {
		item.Details = json.RawMessage("{}")
	}
	if before.ID == 0 {
		asset, err := readAsset(tx.QueryRowContext(ctx, `
			INSERT INTO assets (kind,name,platform,status,cpu,memory_mib,observed,source_key,external_key,last_seen_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) RETURNING `+assetColumns,
			item.Kind, item.Name, platform, item.Status, item.CPU, item.MemoryMiB, item.Details, key, item.Key))
		if err != nil {
			return Asset{}, err
		}
		return asset, writeChange(ctx, tx, asset, actor, "discover", nil, snapshotFields(asset))
	}

	var oldIdentity, newIdentity string
	var oldDetails, newDetails struct {
		Identity string `json:"标识"`
	}
	if json.Unmarshal(before.Observed, &oldDetails) == nil {
		oldIdentity = oldDetails.Identity
	}
	if json.Unmarshal(item.Details, &newDetails) == nil {
		newIdentity = newDetails.Identity
	}
	if oldIdentity != "" && newIdentity != "" && oldIdentity != newIdentity {
		return Asset{}, fmt.Errorf("资源 %s 的实例标识已变化，请核对平台标识是否被复用", item.Key)
	}
	if before.Lifecycle == "retired" {
		return before, nil
	}

	var unchanged bool
	err := tx.QueryRowContext(ctx, `
		SELECT name=$2 AND status=$3 AND cpu=$4 AND memory_mib=$5 AND observed=$6
		FROM assets WHERE id=$1`, before.ID, item.Name, item.Status, item.CPU, item.MemoryMiB, item.Details).Scan(&unchanged)
	if err != nil {
		return Asset{}, err
	}
	if unchanged {
		_, err = tx.ExecContext(ctx, "UPDATE assets SET last_seen_at=now(), missing_count=0 WHERE id=$1", before.ID)
		return before, err
	}

	asset, err := readAsset(tx.QueryRowContext(ctx, `
		UPDATE assets SET name=$2,status=$3,cpu=$4,memory_mib=$5,observed=$6,last_seen_at=now(),
			missing_count=0,version=version+1,updated_at=now() WHERE id=$1 RETURNING `+assetColumns,
		before.ID, item.Name, item.Status, item.CPU, item.MemoryMiB, item.Details))
	if err != nil {
		return Asset{}, err
	}
	return asset, writeChange(ctx, tx, asset, actor, "sync", snapshotFields(before), snapshotFields(asset))
}

func snapshotFields(asset Asset) any {
	return struct {
		Fields
		Observed json.RawMessage `json:"observed"`
	}{asset.Fields, asset.Observed}
}

func syncLink(ctx context.Context, tx *sql.Tx, key, actor, kind string, from, to Asset) error {
	if to.Lifecycle == "retired" {
		return nil
	}
	var old Link
	err := tx.QueryRowContext(ctx, `
		SELECT l.id,l.from_id,a.name,COALESCE(l.source_key,'') FROM asset_links l
		JOIN assets a ON a.id=l.from_id WHERE l.to_id=$1 AND l.kind=$2`,
		to.ID, kind).Scan(&old.ID, &old.FromID, &old.FromName, &old.SourceKey)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if old.FromID == from.ID {
		return nil
	}
	if old.ID != 0 {
		if old.SourceKey != key {
			return fmt.Errorf("资产 %s 已有独立维护的上级关系", to.Name)
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM asset_links WHERE id=$1", old.ID); err != nil {
			return err
		}
	}
	link := Link{Kind: kind, FromID: from.ID, FromName: from.Name, ToID: to.ID, ToName: to.Name, SourceKey: key}
	err = tx.QueryRowContext(ctx, "INSERT INTO asset_links (from_id,to_id,kind,source_key) VALUES ($1,$2,$3,$4) RETURNING id",
		link.FromID, link.ToID, link.Kind, link.SourceKey).Scan(&link.ID)
	if err != nil {
		return err
	}
	if old.ID != 0 {
		old.Kind, old.ToID, old.ToName = kind, to.ID, to.Name
		return writeChange(ctx, tx, to, actor, "move", old, link)
	}
	return writeChange(ctx, tx, to, actor, "link", nil, link)
}
