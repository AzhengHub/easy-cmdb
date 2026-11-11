package cmdb

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestUserManagement(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	admin, err := CreateUser(ctx, db, UserFields{
		Username: "root-admin", Password: "admin-password-123", Role: "admin",
	}, "system")
	if err != nil {
		t.Fatalf("create admin: %v", err)
	}
	if admin.Role != "admin" {
		t.Fatalf("admin role = %q", admin.Role)
	}
	viewer, err := CreateUser(ctx, db, UserFields{
		Username: "read-only", Password: "viewer-password-123", Role: "viewer",
	}, "system")
	if err != nil {
		t.Fatalf("create viewer: %v", err)
	}
	if _, err := CreateUser(ctx, db, UserFields{
		Username: "read-only", Password: "another-password-123", Role: "viewer",
	}, "system"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate user error = %v, want ErrInvalid", err)
	}
	if _, err := CreateUser(ctx, db, UserFields{
		Username: "bad/name", Password: "valid-password-123", Role: "viewer",
	}, "system"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid username error = %v, want ErrInvalid", err)
	}
	if _, err := CreateUser(ctx, db, UserFields{
		Username: "short-password", Password: "short", Role: "viewer",
	}, "system"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("short password error = %v, want ErrInvalid", err)
	}
	if _, err := CreateUser(ctx, db, UserFields{
		Username: "bad-role", Password: "valid-password-123", Role: "owner",
	}, "system"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid role error = %v, want ErrInvalid", err)
	}

	users, err := ListUsers(ctx, db)
	if err != nil || len(users) != 2 {
		t.Fatalf("list users: %v, %+v", err, users)
	}
	if _, valid, err := authenticate(ctx, db, viewer.Username, "viewer-password-123"); err != nil || !valid {
		t.Fatalf("viewer authentication failed: %v, %v", valid, err)
	}

	token := "test-session-token"
	if _, err := db.ExecContext(ctx, `INSERT INTO sessions (token_hash,username,expires_at) VALUES ($1,$2,$3)`,
		sessionHash(token), viewer.Username, timeText(time.Now().Add(time.Hour))); err != nil {
		t.Fatalf("create viewer session: %v", err)
	}
	operator, err := UpdateUser(ctx, db, viewer.Username, UserFields{
		Role: "operator", Password: "operator-password-123",
	}, admin.Username)
	if err != nil {
		t.Fatalf("update viewer: %v", err)
	}
	if operator.Role != "operator" {
		t.Fatalf("updated role = %q", operator.Role)
	}
	if _, valid, err := authenticate(ctx, db, viewer.Username, "operator-password-123"); err != nil || !valid {
		t.Fatalf("new password authentication failed: %v, %v", valid, err)
	}
	if _, valid, err := authenticate(ctx, db, viewer.Username, "viewer-password-123"); err != nil || valid {
		t.Fatalf("old password still works: %v, %v", valid, err)
	}
	var sessions int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sessions WHERE username=$1`, viewer.Username).Scan(&sessions); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if sessions != 0 {
		t.Fatalf("sessions after password reset = %d, want 0", sessions)
	}

	if _, err := UpdateUser(ctx, db, admin.Username, UserFields{Role: "viewer"}, "read-only"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("demote last admin error = %v, want ErrInvalid", err)
	}
	if err := DeleteUser(ctx, db, admin.Username, "read-only"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("delete last admin error = %v, want ErrInvalid", err)
	}
	if _, err := UpdateUser(ctx, db, admin.Username, UserFields{Role: "viewer"}, admin.Username); !errors.Is(err, ErrInvalid) {
		t.Fatalf("self role change error = %v, want ErrInvalid", err)
	}
	if err := DeleteUser(ctx, db, admin.Username, admin.Username); !errors.Is(err, ErrInvalid) {
		t.Fatalf("self delete error = %v, want ErrInvalid", err)
	}

	if _, err := CreateUser(ctx, db, UserFields{
		Username: "second-admin", Password: "second-password-123", Role: "admin",
	}, admin.Username); err != nil {
		t.Fatalf("create second admin: %v", err)
	}
	if _, err := UpdateUser(ctx, db, "second-admin", UserFields{Role: "viewer"}, admin.Username); err != nil {
		t.Fatalf("demote second admin: %v", err)
	}
	if err := DeleteUser(ctx, db, "second-admin", admin.Username); err != nil {
		t.Fatalf("delete second account: %v", err)
	}

	changes, err := ListChanges(ctx, db, 0)
	if err != nil {
		t.Fatalf("list changes: %v", err)
	}
	foundUserChange := false
	for _, change := range changes {
		if change.Action == "user_create" || change.Action == "user_update" || change.Action == "user_delete" {
			foundUserChange = true
			break
		}
	}
	if !foundUserChange {
		t.Fatalf("user changes not audited: %+v", changes)
	}
}
