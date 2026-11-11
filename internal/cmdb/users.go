package cmdb

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
)

var usernamePattern = regexp.MustCompile(`^[\p{L}\p{N}._@-]{1,80}$`)

type UserFields struct {
	Username string `json:"username"`
	Password string `json:"password,omitempty"`
	Role     string `json:"role"`
}

type userRole struct {
	Username string
	Role     string
}

func validateUserFields(fields UserFields, requirePassword bool) error {
	if !usernamePattern.MatchString(fields.Username) {
		return fmt.Errorf("%w: 账号须为 1–80 个字符，只能包含文字、数字、点、下划线、@ 或连字符", ErrInvalid)
	}
	switch fields.Role {
	case "admin", "operator", "viewer":
	default:
		return fmt.Errorf("%w: 账号角色无效", ErrInvalid)
	}
	if requirePassword && fields.Password == "" {
		return fmt.Errorf("%w: 新账号须设置密码", ErrInvalid)
	}
	if fields.Password != "" && (len(fields.Password) < 12 || len(fields.Password) > 512) {
		return fmt.Errorf("%w: 密码长度须为 12–512 个字符", ErrInvalid)
	}
	return nil
}

func ListUsers(ctx context.Context, db *sql.DB) ([]User, error) {
	rows, err := db.QueryContext(ctx, `SELECT username, role FROM users ORDER BY lower(username), username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := make([]User, 0)
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.Username, &user.Role); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func CreateUser(ctx context.Context, db *sql.DB, fields UserFields, actor string) (User, error) {
	fields.Username = strings.TrimSpace(fields.Username)
	fields.Role = strings.TrimSpace(fields.Role)
	if err := validateUserFields(fields, true); err != nil {
		return User{}, err
	}
	passwordHash, err := hashPassword(fields.Password)
	if err != nil {
		return User{}, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()
	user := User{Username: fields.Username, Role: fields.Role}
	err = tx.QueryRowContext(ctx, `
		INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)
		RETURNING username, role`, user.Username, passwordHash, user.Role).Scan(&user.Username, &user.Role)
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, fmt.Errorf("%w: 账号已存在", ErrInvalid)
		}
		return User{}, err
	}
	if err := writeNamedChange(ctx, tx, nil, user.Username, actor, "user_create", nil, map[string]any{
		"username": user.Username, "role": user.Role,
	}); err != nil {
		return User{}, err
	}
	return user, tx.Commit()
}

func UpdateUser(ctx context.Context, db *sql.DB, username string, fields UserFields, actor string) (User, error) {
	if strings.TrimSpace(username) != username || username == "" {
		return User{}, fmt.Errorf("%w: 账号无效", ErrInvalid)
	}
	if username == actor {
		return User{}, fmt.Errorf("%w: 当前账号请在「更改密码」中维护", ErrInvalid)
	}
	fields.Role = strings.TrimSpace(fields.Role)
	if err := validateUserFields(UserFields{Username: username, Password: fields.Password, Role: fields.Role}, false); err != nil {
		return User{}, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()

	var before userRole
	if err := tx.QueryRowContext(ctx, `SELECT username, role FROM users WHERE username=$1`, username).
		Scan(&before.Username, &before.Role); err != nil {
		return User{}, err
	}
	if before.Role == "admin" && fields.Role != "admin" {
		count, err := adminCount(ctx, tx)
		if err != nil {
			return User{}, err
		}
		if count <= 1 {
			return User{}, fmt.Errorf("%w: 不能降级最后一个管理员", ErrInvalid)
		}
	}
	passwordReset := false
	if fields.Password != "" {
		passwordHash, err := hashPassword(fields.Password)
		if err != nil {
			return User{}, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE users SET password_hash=$1 WHERE username=$2`, passwordHash, username); err != nil {
			return User{}, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE username=$1`, username); err != nil {
			return User{}, err
		}
		passwordReset = true
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET role=$1 WHERE username=$2`, fields.Role, username); err != nil {
		return User{}, err
	}
	after := User{Username: before.Username, Role: fields.Role}
	afterChange := map[string]any{"username": after.Username, "role": after.Role}
	if passwordReset {
		afterChange["passwordReset"] = true
	}
	if err := writeNamedChange(ctx, tx, nil, username, actor, "user_update", map[string]any{
		"username": before.Username, "role": before.Role,
	}, afterChange); err != nil {
		return User{}, err
	}
	return after, tx.Commit()
}

func DeleteUser(ctx context.Context, db *sql.DB, username, actor string) error {
	if username == "" {
		return fmt.Errorf("%w: 账号无效", ErrInvalid)
	}
	if username == actor {
		return fmt.Errorf("%w: 不能删除当前登录账号", ErrInvalid)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var before userRole
	if err := tx.QueryRowContext(ctx, `SELECT username, role FROM users WHERE username=$1`, username).
		Scan(&before.Username, &before.Role); err != nil {
		return err
	}
	if before.Role == "admin" {
		count, err := adminCount(ctx, tx)
		if err != nil {
			return err
		}
		if count <= 1 {
			return fmt.Errorf("%w: 不能删除最后一个管理员", ErrInvalid)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE username=$1`, username); err != nil {
		return err
	}
	if err := writeNamedChange(ctx, tx, nil, username, actor, "user_delete", map[string]any{
		"username": before.Username, "role": before.Role,
	}, nil); err != nil {
		return err
	}
	return tx.Commit()
}

func adminCount(ctx context.Context, tx *sql.Tx) (int, error) {
	var count int
	err := tx.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE role='admin'`).Scan(&count)
	return count, err
}
