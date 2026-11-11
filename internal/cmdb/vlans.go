package cmdb

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"unicode/utf8"
)

type VLANFields struct {
	VID         int    `json:"vid"`
	Name        string `json:"name"`
	Status      string `json:"status"`
	Description string `json:"description"`
	RoomID      int64  `json:"roomId,omitempty"`
}

type VLAN struct {
	VLANFields
	ID          int64  `json:"id"`
	Version     int    `json:"version"`
	RoomName    string `json:"roomName,omitempty"`
	PrefixCount int64  `json:"prefixCount"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

const vlanSelect = `
	SELECT v.id,v.vid,v.name,v.status,v.description,COALESCE(v.room_id,0),COALESCE(r.name,''),
		v.version,(SELECT count(*) FROM subnets s WHERE s.vlan=CAST(v.vid AS TEXT)),
		v.created_at,v.updated_at
	FROM vlans v LEFT JOIN rooms r ON r.id=v.room_id`

func readVLAN(row scanner) (VLAN, error) {
	var vlan VLAN
	err := row.Scan(&vlan.ID, &vlan.VID, &vlan.Name, &vlan.Status, &vlan.Description,
		&vlan.RoomID, &vlan.RoomName, &vlan.Version, &vlan.PrefixCount, &vlan.CreatedAt, &vlan.UpdatedAt)
	return vlan, err
}

func ListVLANs(ctx context.Context, db *sql.DB) ([]VLAN, error) {
	rows, err := db.QueryContext(ctx, vlanSelect+" ORDER BY v.vid, v.id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	vlans := make([]VLAN, 0)
	for rows.Next() {
		vlan, err := readVLAN(rows)
		if err != nil {
			return nil, err
		}
		vlans = append(vlans, vlan)
	}
	return vlans, rows.Err()
}

func GetVLAN(ctx context.Context, db *sql.DB, id int64) (VLAN, error) {
	return readVLAN(db.QueryRowContext(ctx, vlanSelect+" WHERE v.id=$1", id))
}

func normalizeVLANFields(fields *VLANFields) error {
	fields.Name = strings.TrimSpace(fields.Name)
	fields.Status = strings.TrimSpace(fields.Status)
	fields.Description = strings.TrimSpace(fields.Description)
	if fields.VID < 1 || fields.VID > 4094 {
		return invalidFacility("VLAN ID 须在 1–4094 之间")
	}
	if utf8.RuneCountInString(fields.Name) < 1 || utf8.RuneCountInString(fields.Name) > 80 {
		return invalidFacility("VLAN 名称须为 1–80 个字符")
	}
	if fields.Status == "" {
		fields.Status = "active"
	}
	switch fields.Status {
	case "active", "reserved", "deprecated":
	default:
		return invalidFacility("VLAN 状态无效")
	}
	if utf8.RuneCountInString(fields.Description) > 200 {
		return invalidFacility("VLAN 描述不能超过 200 个字符")
	}
	return nil
}

func SaveVLAN(ctx context.Context, db *sql.DB, id int64, fields VLANFields, version int, actor string) (VLAN, error) {
	if err := normalizeVLANFields(&fields); err != nil {
		return VLAN{}, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return VLAN{}, err
	}
	defer tx.Rollback()

	vlanID := id
	var before VLAN
	if fields.RoomID != 0 {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM rooms WHERE id=$1)", fields.RoomID).Scan(&exists); err != nil {
			return VLAN{}, err
		}
		if !exists {
			return VLAN{}, invalidFacility("所属数据中心不存在")
		}
	}

	if id == 0 {
		result, execErr := tx.ExecContext(ctx, `
			INSERT INTO vlans (vid,name,status,description,room_id)
			VALUES ($1,$2,$3,$4,$5)`, fields.VID, fields.Name, fields.Status, fields.Description, nullID(fields.RoomID))
		err = execErr
		if err == nil {
			vlanID, err = result.LastInsertId()
		}
	} else {
		before, err = readVLAN(tx.QueryRowContext(ctx, vlanSelect+" WHERE v.id=$1", id))
		if err != nil {
			return VLAN{}, err
		}
		if before.Version != version {
			return VLAN{}, ErrConflict
		}
		if before.VID != fields.VID && before.PrefixCount > 0 {
			return VLAN{}, invalidFacility("修改 VLAN ID 前请先调整关联网段")
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE vlans SET vid=$2,name=$3,status=$4,description=$5,room_id=$6,
				version=version+1,updated_at=$7 WHERE id=$1`,
			id, fields.VID, fields.Name, fields.Status, fields.Description, nullID(fields.RoomID), nowText())
	}
	if err != nil {
		if isUniqueViolation(err) {
			return VLAN{}, invalidFacility("VLAN ID 或名称已被占用")
		}
		return VLAN{}, err
	}
	vlan, err := readVLAN(tx.QueryRowContext(ctx, vlanSelect+" WHERE v.id=$1", vlanID))
	if err != nil {
		return VLAN{}, err
	}
	action := "vlan_create"
	old := any(nil)
	if id != 0 {
		action = "vlan_update"
		old = before.VLANFields
	}
	if err := writeNamedChange(ctx, tx, nil, vlanLabel(vlan), actor, action, old, vlan.VLANFields); err != nil {
		return VLAN{}, err
	}
	return vlan, tx.Commit()
}

func DeleteVLAN(ctx context.Context, db *sql.DB, id int64, version int, actor string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	vlan, err := readVLAN(tx.QueryRowContext(ctx, vlanSelect+" WHERE v.id=$1", id))
	if err != nil {
		return err
	}
	if vlan.Version != version {
		return ErrConflict
	}
	var prefixes int64
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM subnets WHERE vlan=CAST($1 AS TEXT)", vlan.VID).Scan(&prefixes); err != nil {
		return err
	}
	if prefixes > 0 {
		return invalidFacility(fmt.Sprintf("VLAN 仍被 %d 个网段使用，请先调整网段的 VLAN", prefixes))
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM vlans WHERE id=$1", id); err != nil {
		return err
	}
	if err := writeNamedChange(ctx, tx, nil, vlanLabel(vlan), actor, "vlan_delete", vlan.VLANFields, nil); err != nil {
		return err
	}
	return tx.Commit()
}

func vlanLabel(vlan VLAN) string {
	return fmt.Sprintf("VLAN %d · %s", vlan.VID, vlan.Name)
}
