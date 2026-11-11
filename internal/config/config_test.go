package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadMissingUsesDefaults(t *testing.T) {
	cfg, found, err := Load(filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if found {
		t.Fatal("missing config reported as found")
	}
	if cfg.Listen != "127.0.0.1:8080" || cfg.Database != "dc-db.db" || cfg.WebDir != "web/dist" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.Admin.Username != "admin" || cfg.Admin.Password != "" {
		t.Fatalf("unexpected default admin: %+v", cfg.Admin)
	}
}

func TestLoadYAML(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	body := `
listen: 127.0.0.1:9090
database: data/test.db
web_dir: public
cookie_secure: true
admin:
  username: root
  password: strong-password
operator:
  username: ops
  password: operator-password
`
	if err := os.WriteFile(path, []byte(strings.TrimSpace(body)), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, found, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !found {
		t.Fatal("config file not reported as found")
	}
	if cfg.Listen != "127.0.0.1:9090" || cfg.Database != "data/test.db" || cfg.WebDir != "public" || !cfg.CookieSecure {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	if cfg.Admin.Username != "root" || cfg.Admin.Password != "strong-password" {
		t.Fatalf("unexpected admin: %+v", cfg.Admin)
	}
	if cfg.Operator.Username != "ops" || cfg.Operator.Password != "operator-password" {
		t.Fatalf("unexpected operator: %+v", cfg.Operator)
	}
}

func TestLoadPartialKeepsDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("listen: 127.0.0.1:9091\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, found, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !found {
		t.Fatal("config file not reported as found")
	}
	if cfg.Listen != "127.0.0.1:9091" || cfg.Database != "dc-db.db" || cfg.WebDir != "web/dist" {
		t.Fatalf("defaults were not preserved: %+v", cfg)
	}
	if cfg.Admin.Username != "admin" {
		t.Fatalf("default admin was not preserved: %+v", cfg.Admin)
	}
}

func TestLoadRejectsUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("listen: 127.0.0.1:8080\nunknown: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(path); err == nil {
		t.Fatal("unknown field was accepted")
	}
}

func TestLoadRejectsEmptyRequiredValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("listen: \"\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(path); err == nil {
		t.Fatal("empty listen was accepted")
	}
}
