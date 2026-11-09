package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"

	"gopkg.in/yaml.v3"
)

// Account is a bootstrap account. An empty username and password disables an
// optional account; the administrator account always falls back to its built-in
// default when the file leaves it empty.
type Account struct {
	Username string `yaml:"username"`
	Password string `yaml:"password"`
}

type Config struct {
	Listen       string  `yaml:"listen"`
	Database     string  `yaml:"database"`
	WebDir       string  `yaml:"web_dir"`
	CookieSecure bool    `yaml:"cookie_secure"`
	Admin        Account `yaml:"admin"`
	Operator     Account `yaml:"operator"`
	Viewer       Account `yaml:"viewer"`
}

// Default returns the values used when config.yaml is absent.
func Default() Config {
	return Config{
		Listen:   "127.0.0.1:8080",
		Database: "easy.db",
		WebDir:   "web/dist",
		Admin:    Account{Username: "admin"},
	}
}

// Load reads an optional YAML configuration file. found is false when the file
// does not exist, in which case the built-in defaults are returned.
func Load(path string) (cfg Config, found bool, err error) {
	cfg = Default()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, false, nil
	}
	if err != nil {
		return Config{}, false, err
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil && !errors.Is(err, io.EOF) {
		return Config{}, false, fmt.Errorf("解析 %s: %w", path, err)
	}
	if cfg.Listen == "" || cfg.Database == "" || cfg.WebDir == "" {
		return Config{}, false, errors.New("listen、database 和 web_dir 不能为空")
	}
	return cfg, true, nil
}
