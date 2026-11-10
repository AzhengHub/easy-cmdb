package cmdb

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

var tagColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

type TagFields struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

type Tag struct {
	TagFields
	ID         int64 `json:"id"`
	AssetCount int64 `json:"assetCount"`
}

const tagSchema = `
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    color TEXT NOT NULL DEFAULT '#1677ff',
    description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_name_idx ON tags (lower(name));

CREATE TABLE IF NOT EXISTS asset_tags (
    asset_id INTEGER NOT NULL REFERENCES assets ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags ON DELETE CASCADE,
    PRIMARY KEY (asset_id, tag_id)
);

CREATE INDEX IF NOT EXISTS asset_tags_tag_idx ON asset_tags (tag_id);
`

const tagColumns = "id,name,color,description"

func ensureTagSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, tagSchema)
	return err
}

func readTag(row scanner) (Tag, error) {
	var tag Tag
	err := row.Scan(&tag.ID, &tag.Name, &tag.Color, &tag.Description)
	return tag, err
}

func normalizeTagFields(fields *TagFields) error {
	fields.Name = strings.TrimSpace(fields.Name)
	fields.Color = strings.TrimSpace(fields.Color)
	fields.Description = strings.TrimSpace(fields.Description)
	if fields.Color == "" {
		fields.Color = "#1677ff"
	}
	if fields.Name == "" || utf8.RuneCountInString(fields.Name) > 80 {
		return fmt.Errorf("%w: 标签名称须为 1–80 个字符", ErrInvalid)
	}
	if !tagColorPattern.MatchString(fields.Color) {
		return fmt.Errorf("%w: 标签颜色须为 #RRGGBB", ErrInvalid)
	}
	if utf8.RuneCountInString(fields.Description) > 200 {
		return fmt.Errorf("%w: 标签描述不能超过 200 个字符", ErrInvalid)
	}
	return nil
}

func ListTags(ctx context.Context, db *sql.DB) ([]Tag, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT t.id, t.name, t.color, t.description, count(at.asset_id)
		FROM tags t LEFT JOIN asset_tags at ON at.tag_id = t.id
		GROUP BY t.id
		ORDER BY lower(t.name), t.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := make([]Tag, 0)
	for rows.Next() {
		var tag Tag
		if err := rows.Scan(&tag.ID, &tag.Name, &tag.Color, &tag.Description, &tag.AssetCount); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}

func SaveTag(ctx context.Context, db *sql.DB, id int64, fields TagFields) (Tag, error) {
	if err := normalizeTagFields(&fields); err != nil {
		return Tag{}, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return Tag{}, err
	}
	defer tx.Rollback()

	var tag Tag
	if id == 0 {
		tag, err = readTag(tx.QueryRowContext(ctx, `
			INSERT INTO tags (name,color,description) VALUES ($1,$2,$3)
			RETURNING `+tagColumns, fields.Name, fields.Color, fields.Description))
	} else {
		tag, err = readTag(tx.QueryRowContext(ctx, `
			UPDATE tags SET name=$2,color=$3,description=$4 WHERE id=$1
			RETURNING `+tagColumns, id, fields.Name, fields.Color, fields.Description))
	}
	if err != nil {
		if isUniqueViolation(err) {
			return Tag{}, fmt.Errorf("%w: 标签名称已存在", ErrInvalid)
		}
		return Tag{}, err
	}
	if err := tx.Commit(); err != nil {
		return Tag{}, err
	}
	return tag, nil
}

func DeleteTag(ctx context.Context, db *sql.DB, id int64) error {
	result, err := db.ExecContext(ctx, "DELETE FROM tags WHERE id=$1", id)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func assetTags(ctx context.Context, q queryer, assetID int64) ([]Tag, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT t.id, t.name, t.color, t.description
		FROM asset_tags at JOIN tags t ON t.id = at.tag_id
		WHERE at.asset_id = $1
		ORDER BY lower(t.name), t.id`, assetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := make([]Tag, 0)
	for rows.Next() {
		tag, err := readTag(rows)
		if err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}

func ListAssetTags(ctx context.Context, db *sql.DB, assetID int64) ([]Tag, error) {
	var exists bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1)", assetID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, sql.ErrNoRows
	}
	return assetTags(ctx, db, assetID)
}

func SetAssetTags(ctx context.Context, db *sql.DB, assetID int64, tagIDs []int64, actor string) ([]Tag, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	asset, err := readAsset(tx.QueryRowContext(ctx, "SELECT "+assetColumns+" FROM assets WHERE id=$1", assetID))
	if err != nil {
		return nil, err
	}
	before, err := assetTags(ctx, tx, assetID)
	if err != nil {
		return nil, err
	}
	beforeNames := make([]string, 0, len(before))
	for _, tag := range before {
		beforeNames = append(beforeNames, tag.Name)
	}

	seen := make(map[int64]bool, len(tagIDs))
	ids := make([]int64, 0, len(tagIDs))
	for _, id := range tagIDs {
		if id < 1 {
			return nil, fmt.Errorf("%w: 标签编号无效", ErrInvalid)
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	valid := 0
	if len(ids) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
		args := make([]any, len(ids))
		for i, id := range ids {
			args[i] = id
		}
		if err := tx.QueryRowContext(ctx,
			"SELECT count(*) FROM tags WHERE id IN ("+placeholders+")", args...).Scan(&valid); err != nil {
			return nil, err
		}
	}
	if valid != len(ids) {
		return nil, fmt.Errorf("%w: 部分标签不存在", ErrInvalid)
	}

	if _, err := tx.ExecContext(ctx, "DELETE FROM asset_tags WHERE asset_id=$1", assetID); err != nil {
		return nil, err
	}
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, "INSERT INTO asset_tags (asset_id,tag_id) VALUES ($1,$2)", assetID, id); err != nil {
			return nil, err
		}
	}
	after, err := assetTags(ctx, tx, assetID)
	if err != nil {
		return nil, err
	}
	afterNames := make([]string, 0, len(after))
	for _, tag := range after {
		afterNames = append(afterNames, tag.Name)
	}
	if strings.Join(beforeNames, "\x00") != strings.Join(afterNames, "\x00") {
		if err := writeChange(ctx, tx, asset, actor, "tags", beforeNames, afterNames); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return after, nil
}

// BulkUpdateAssetTags applies one tag operation to several assets in a
// transaction. Mode is add, remove, or replace; replace with an empty list
// clears all tags on the selected assets.
func BulkUpdateAssetTags(ctx context.Context, db *sql.DB, ids, tagIDs []int64, mode, actor string) (int, error) {
	if mode != "add" && mode != "remove" && mode != "replace" {
		return 0, fmt.Errorf("%w: 标签批量操作方式无效", ErrInvalid)
	}
	if len(ids) == 0 {
		return 0, fmt.Errorf("%w: 请选择资产", ErrInvalid)
	}
	if mode != "replace" && len(tagIDs) == 0 {
		return 0, fmt.Errorf("%w: 请选择标签", ErrInvalid)
	}

	assetIDs := uniquePositiveIDs(ids)
	tagIDs = uniquePositiveIDs(tagIDs)
	if len(assetIDs) == 0 {
		return 0, fmt.Errorf("%w: 请选择资产", ErrInvalid)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	if len(tagIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(tagIDs)), ",")
		args := make([]any, len(tagIDs))
		for i, id := range tagIDs {
			args[i] = id
		}
		rows, err := tx.QueryContext(ctx, "SELECT id FROM tags WHERE id IN ("+placeholders+")", args...)
		if err != nil {
			return 0, err
		}
		valid := make(map[int64]bool, len(tagIDs))
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return 0, err
			}
			valid[id] = true
		}
		if err := rows.Close(); err != nil {
			return 0, err
		}
		if len(valid) != len(tagIDs) {
			return 0, fmt.Errorf("%w: 部分标签不存在", ErrInvalid)
		}
	}

	updated := 0
	for _, assetID := range assetIDs {
		asset, err := readAsset(tx.QueryRowContext(ctx, "SELECT "+assetColumns+" FROM assets WHERE id=$1", assetID))
		if err != nil {
			return 0, err
		}
		before, err := assetTags(ctx, tx, assetID)
		if err != nil {
			return 0, err
		}
		desired := make(map[int64]bool)
		if mode != "replace" {
			for _, tag := range before {
				desired[tag.ID] = true
			}
		}
		for _, tagID := range tagIDs {
			if mode == "remove" {
				delete(desired, tagID)
			} else {
				desired[tagID] = true
			}
		}
		if len(desired) == len(before) {
			same := true
			for _, tag := range before {
				if !desired[tag.ID] {
					same = false
					break
				}
			}
			if same {
				continue
			}
		}

		if _, err := tx.ExecContext(ctx, "DELETE FROM asset_tags WHERE asset_id=$1", assetID); err != nil {
			return 0, err
		}
		for tagID := range desired {
			if _, err := tx.ExecContext(ctx, "INSERT INTO asset_tags (asset_id,tag_id) VALUES ($1,$2)", assetID, tagID); err != nil {
				return 0, err
			}
		}
		after, err := assetTags(ctx, tx, assetID)
		if err != nil {
			return 0, err
		}
		beforeNames := make([]string, 0, len(before))
		for _, tag := range before {
			beforeNames = append(beforeNames, tag.Name)
		}
		afterNames := make([]string, 0, len(after))
		for _, tag := range after {
			afterNames = append(afterNames, tag.Name)
		}
		if err := writeChange(ctx, tx, asset, actor, "tags", beforeNames, afterNames); err != nil {
			return 0, err
		}
		updated++
	}
	return updated, tx.Commit()
}

func uniquePositiveIDs(ids []int64) []int64 {
	seen := make(map[int64]bool, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id < 1 || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
