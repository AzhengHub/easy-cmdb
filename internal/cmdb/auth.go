package cmdb

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const sessionCookie = "easy_session"
const sessionDuration = 12 * time.Hour
const passwordIterations = 600000
const defaultAdminUsername = "admin"
const defaultAdminPassword = "default"

type User struct {
	Username string `json:"username"`
	Role     string `json:"role"`
}

type userKey struct{}

func EnsureUser(ctx context.Context, db *sql.DB, username, password, role string) error {
	if role == "admin" {
		if username == "" {
			username = defaultAdminUsername
		}
		if username == defaultAdminUsername && password == "" {
			password = defaultAdminPassword
		}
	}
	usesDefaultPassword := role == "admin" && username == defaultAdminUsername && password == defaultAdminPassword
	if username == "" || len(username) > 80 || strings.TrimSpace(username) != username ||
		len(password) > 512 || (len(password) < 12 && !usesDefaultPassword) {
		return errors.New("账号长度须为 1–80 字节，密码长度须为 12–512 字节")
	}
	// A known bootstrap password is only used when the database has no administrator yet.
	var exists bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS (SELECT 1 FROM users WHERE role=$2 AND (username=$1 OR $3))`,
		username, role, usesDefaultPassword).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	salt := make([]byte, 16)
	rand.Read(salt)
	key, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, 32)
	if err != nil {
		return err
	}
	value := base64.RawStdEncoding.EncodeToString(append(salt, key...))
	_, err = db.ExecContext(ctx, "INSERT INTO users (username,password_hash,role) VALUES ($1,$2,$3)", username, value, role)
	return err
}

func authenticate(ctx context.Context, db *sql.DB, username, password string) (User, bool, error) {
	user := User{Username: username}
	var hash string
	err := db.QueryRowContext(ctx, "SELECT password_hash,role FROM users WHERE username=$1", username).Scan(&hash, &user.Role)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return User{}, false, err
	}
	stored := make([]byte, 48)
	if err == nil {
		stored, err = base64.RawStdEncoding.DecodeString(hash)
		if err != nil || len(stored) != 48 {
			return User{}, false, fmt.Errorf("invalid stored password hash")
		}
	}
	key, err := pbkdf2.Key(sha256.New, password, stored[:16], passwordIterations, 32)
	if err != nil {
		return User{}, false, err
	}
	return user, subtle.ConstantTimeCompare(key, stored[16:]) == 1 && user.Role != "", nil
}

func sessionHash(token string) []byte {
	hash := sha256.Sum256([]byte(token))
	return hash[:]
}

func (s *Server) signIn(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		CaptchaID   string `json:"captchaId"`
		CaptchaCode string `json:"captchaCode"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if !s.captchas.verify(strings.TrimSpace(input.CaptchaID), input.CaptchaCode) {
		fail(w, http.StatusBadRequest, "验证码错误或已过期，请刷新后重试")
		return
	}
	if len(input.Username) > 80 || len(input.Password) > 512 {
		fail(w, http.StatusBadRequest, "账号或密码长度超出限制")
		return
	}

	select {
	case s.loginSlots <- struct{}{}:
		defer func() { <-s.loginSlots }()
	default:
		fail(w, http.StatusTooManyRequests, "登录请求过多，请稍后重试")
		return
	}

	user, valid, err := authenticate(r.Context(), s.db, strings.TrimSpace(input.Username), input.Password)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if !valid {
		fail(w, http.StatusUnauthorized, "账号或密码不正确")
		return
	}

	raw := make([]byte, 32)
	rand.Read(raw)
	token := base64.RawURLEncoding.EncodeToString(raw)
	expires := time.Now().Add(sessionDuration)
	_, err = s.db.ExecContext(r.Context(), "INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1,$2,$3)",
		sessionHash(token), user.Username, timeText(expires))
	if err != nil {
		s.databaseError(w, err)
		return
	}
	_, _ = s.db.ExecContext(r.Context(), "DELETE FROM sessions WHERE expires_at <= $1", nowText())
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", Expires: expires, HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: s.secureCookie,
	})
	respond(w, http.StatusOK, user)
}

func (s *Server) signOut(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		if _, err := s.db.ExecContext(r.Context(), "DELETE FROM sessions WHERE token_hash=$1", sessionHash(cookie.Value)); err != nil {
			s.databaseError(w, err)
			return
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Path: "/", MaxAge: -1, HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: s.secureCookie,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) requireUser(write bool, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookie)
		if err != nil || len(cookie.Value) != 43 {
			fail(w, http.StatusUnauthorized, "请先登录")
			return
		}
		var user User
		err = s.db.QueryRowContext(r.Context(), `
			SELECT u.username, u.role FROM sessions s JOIN users u ON u.username=s.username
			WHERE s.token_hash=$1 AND s.expires_at > $2`, sessionHash(cookie.Value), nowText()).Scan(&user.Username, &user.Role)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, http.StatusUnauthorized, "登录已失效，请重新登录")
			return
		}
		if err != nil {
			s.databaseError(w, err)
			return
		}
		if write && user.Role == "viewer" {
			fail(w, http.StatusForbidden, "当前账号只有查看权限")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey{}, user)))
	}
}

func currentUser(r *http.Request) User {
	return r.Context().Value(userKey{}).(User)
}
