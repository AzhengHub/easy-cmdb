package cmdb

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCaptchaStore(t *testing.T) {
	store := newCaptchaStore(2)
	id := store.issue("aB3d")
	if store.verify(id, "wrong") {
		t.Fatal("wrong captcha code accepted")
	}
	if store.verify(id, "AB3D") {
		t.Fatal("captcha was not consumed after a failed attempt")
	}

	id = store.issue("2345")
	if !store.verify(id, " 2345 ") {
		t.Fatal("correct captcha code rejected")
	}
	if store.verify(id, "2345") {
		t.Fatal("captcha was not consumed after a successful attempt")
	}

	id = store.issue("6789")
	store.mu.Lock()
	store.entries[id] = captchaEntry{code: "6789", expires: time.Now().Add(-time.Second)}
	store.mu.Unlock()
	if store.verify(id, "6789") {
		t.Fatal("expired captcha accepted")
	}
}

func TestCaptchaImage(t *testing.T) {
	code, err := randomCaptchaCode()
	if err != nil {
		t.Fatalf("generate code: %v", err)
	}
	if len(code) != captchaLength {
		t.Fatalf("code length = %d, want %d", len(code), captchaLength)
	}
	for _, character := range code {
		if !strings.ContainsRune(captchaAlphabet, character) {
			t.Fatalf("code contains unsupported character %q", character)
		}
	}

	for _, dark := range []bool{false, true} {
		data, err := captchaPNG(code, dark)
		if err != nil {
			t.Fatalf("render captcha: %v", err)
		}
		if !bytes.HasPrefix(data, []byte{0x89, 'P', 'N', 'G'}) {
			t.Fatal("captcha is not a PNG image")
		}
		image, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatalf("decode captcha: %v", err)
		}
		if image.Bounds().Dx() != 180 || image.Bounds().Dy() != 58 {
			t.Fatalf("unexpected captcha size: %v", image.Bounds())
		}
	}
}

func TestLoginRequiresCaptcha(t *testing.T) {
	server := &Server{captchas: newCaptchaStore(4), loginSlots: make(chan struct{}, 1)}
	request := httptest.NewRequest(http.MethodPost, "/api/login",
		strings.NewReader(`{"username":"admin","password":"default"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.signIn(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if !strings.Contains(response.Body.String(), "验证码") {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
}

func TestLoginWithCaptcha(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	if err := EnsureUser(ctx, db, "admin", "default", "admin"); err != nil {
		t.Fatalf("create admin: %v", err)
	}
	server := &Server{db: db, captchas: newCaptchaStore(4), loginSlots: make(chan struct{}, 1)}
	code, err := randomCaptchaCode()
	if err != nil {
		t.Fatalf("generate code: %v", err)
	}
	id := server.captchas.issue(code)
	body := fmt.Sprintf(`{"username":"admin","password":"default","captchaId":%q,"captchaCode":%q}`, id, strings.ToLower(code))
	request := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.signIn(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Header().Get("Set-Cookie"), sessionCookie+"=") {
		t.Fatalf("session cookie missing: %q", response.Header().Get("Set-Cookie"))
	}
}

func TestCaptchaIssueHandler(t *testing.T) {
	server := &Server{captchas: newCaptchaStore(4)}
	request := httptest.NewRequest(http.MethodGet, "/api/captcha?theme=dark", nil)
	response := httptest.NewRecorder()
	server.issueCaptcha(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"id"`) || !strings.Contains(body, "data:image/png;base64,") {
		t.Fatalf("unexpected captcha response: %s", body)
	}
}
