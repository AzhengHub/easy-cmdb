package cmdb

import (
	"context"
	"path/filepath"
	"testing"
)

func TestIPAMSchemaUpgrade(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "old.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()

	// Minimal version of the pre-IPAM schema. Initialize must add the new
	// columns without losing the existing subnet row.
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE assets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '');
		CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
		CREATE TABLE subnets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			cidr TEXT NOT NULL UNIQUE,
			gateway TEXT NOT NULL DEFAULT '',
			vlan TEXT NOT NULL DEFAULT '',
			notes TEXT NOT NULL DEFAULT '',
			version INTEGER NOT NULL DEFAULT 1
		);
		CREATE TABLE ip_allocations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			subnet_id INTEGER NOT NULL REFERENCES subnets ON DELETE CASCADE,
			ip TEXT NOT NULL,
			asset_id INTEGER REFERENCES assets,
			label TEXT NOT NULL DEFAULT '',
			notes TEXT NOT NULL DEFAULT '',
			version INTEGER NOT NULL DEFAULT 1,
			UNIQUE (subnet_id, ip)
		);
		CREATE TABLE changes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER REFERENCES assets,
			asset_name TEXT NOT NULL,
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			before_data TEXT,
			after_data TEXT,
			created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		);
		INSERT INTO subnets (name,cidr,gateway,vlan,notes) VALUES ('旧网段','10.0.0.0/24','10.0.0.1','100','');
	`); err != nil {
		t.Fatalf("create old schema: %v", err)
	}
	if err := Initialize(ctx, db); err != nil {
		t.Fatalf("initialize old schema: %v", err)
	}
	if err := Initialize(ctx, db); err != nil {
		t.Fatalf("re-initialize upgraded schema: %v", err)
	}

	subnets, err := ListSubnets(ctx, db)
	if err != nil {
		t.Fatalf("list upgraded subnets: %v", err)
	}
	if len(subnets) != 1 || subnets[0].Status != "active" || subnets[0].Role != "" {
		t.Fatalf("unexpected upgraded subnet: %+v", subnets)
	}
	if _, err := SaveVLAN(ctx, db, 0, VLANFields{VID: 100, Name: "升级 VLAN", Status: "active"}, 0, "tester"); err != nil {
		t.Fatalf("create vlan after upgrade: %v", err)
	}
	if _, err := SaveAllocation(ctx, db, subnets[0].ID, AllocationFields{
		IP: "10.0.0.20", Status: "active", DNSName: "old-01.example.test", Role: "vip",
	}, "tester"); err != nil {
		t.Fatalf("create allocation after upgrade: %v", err)
	}
}
