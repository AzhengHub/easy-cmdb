package cmdb

import (
	"context"
	"database/sql"
	"fmt"
)

// BulkAssetPatch changes only the fields explicitly provided. This mirrors the
// "bulk edit" pattern in NetBox: one action, one transaction, one audit entry
// per affected object.
type BulkAssetPatch struct {
	Status      *string
	Platform    *string
	Lifecycle   *string
	Owner       *string
	Environment *string
}

func (p BulkAssetPatch) empty() bool {
	return p.Status == nil && p.Platform == nil && p.Lifecycle == nil && p.Owner == nil && p.Environment == nil
}

func BulkUpdateAssets(ctx context.Context, db *sql.DB, ids []int64, patch BulkAssetPatch, actor string) (int, error) {
	if len(ids) == 0 {
		return 0, fmt.Errorf("%w: 请选择资产", ErrInvalid)
	}
	if patch.empty() {
		return 0, fmt.Errorf("%w: 请至少选择一项要修改的字段", ErrInvalid)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	updated := 0
	for _, id := range ids {
		before, err := readAsset(tx.QueryRowContext(ctx, "SELECT "+assetColumns+" FROM assets WHERE id=$1", id))
		if err != nil {
			return 0, err
		}
		fields := before.Fields
		if patch.Status != nil {
			fields.Status = *patch.Status
		}
		if patch.Platform != nil {
			fields.Platform = *patch.Platform
		}
		if patch.Lifecycle != nil {
			fields.Lifecycle = *patch.Lifecycle
		}
		if patch.Owner != nil {
			fields.Owner = *patch.Owner
		}
		if patch.Environment != nil {
			fields.Environment = *patch.Environment
		}
		if err := validateFields(&fields); err != nil {
			return 0, fmt.Errorf("%w: %s: %v", ErrInvalid, before.Name, err)
		}
		if equalFields(fields, before.Fields) {
			continue
		}

		after, err := readAsset(tx.QueryRowContext(ctx, `
			UPDATE assets
			SET status=$2, platform=$3, lifecycle=$4, owner=$5, environment=$6, version=version+1, updated_at=$7
			WHERE id=$1
			RETURNING `+assetColumns,
			id, fields.Status, fields.Platform, fields.Lifecycle, fields.Owner, fields.Environment, nowText(),
		))
		if err != nil {
			return 0, err
		}
		if err := writeChange(ctx, tx, after, actor, "update", before.Fields, after.Fields); err != nil {
			return 0, err
		}
		updated++
	}
	return updated, tx.Commit()
}
