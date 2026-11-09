package cmdb

import (
	"context"
	"errors"
	"testing"
)

func TestChangePassword(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	if err := EnsureUser(ctx, db, "admin", "default", "admin"); err != nil {
		t.Fatalf("create admin: %v", err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1,'admin','2099-01-01T00:00:00Z')", []byte("existing-session")); err != nil {
		t.Fatalf("create session: %v", err)
	}

	if err := ChangePassword(ctx, db, "admin", "wrong-password", "new-password-123"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("wrong current password error = %v, want ErrInvalid", err)
	}
	if err := ChangePassword(ctx, db, "admin", "default", "short"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("short password error = %v, want ErrInvalid", err)
	}
	if err := ChangePassword(ctx, db, "admin", "default", "new-password-123"); err != nil {
		t.Fatalf("change password: %v", err)
	}
	if _, valid, err := authenticate(ctx, db, "admin", "default"); err != nil || valid {
		t.Fatalf("old password still valid: valid=%v err=%v", valid, err)
	}
	if _, valid, err := authenticate(ctx, db, "admin", "new-password-123"); err != nil || !valid {
		t.Fatalf("new password invalid: valid=%v err=%v", valid, err)
	}
	var sessions int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sessions WHERE username='admin'").Scan(&sessions); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if sessions != 0 {
		t.Fatalf("sessions after password change = %d, want 0", sessions)
	}
}
