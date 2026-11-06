package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"radar-cmdb/internal/cmdb"
	"radar-cmdb/internal/collect"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		slog.Error("radar", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	worker := len(args) > 0 && args[0] == "collect"
	once := worker && len(args) == 2 && args[1] == "--once"
	if len(args) != 0 && !(len(args) == 1 && (worker || args[0] == "serve")) && !once {
		return errors.New("用法: radar [serve | collect [--once]]")
	}

	dsn := os.Getenv("RADAR_DATABASE_URL")
	if dsn == "" {
		return errors.New("请设置 RADAR_DATABASE_URL")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return errors.New("数据库连接配置无效")
	}
	defer db.Close()
	db.SetMaxIdleConns(4)
	db.SetMaxOpenConns(16)

	bootstrap, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := cmdb.Initialize(bootstrap, db); err != nil {
		return fmt.Errorf("初始化数据库: %w", err)
	}
	if worker {
		sources, err := collect.LoadSources(env("RADAR_SOURCES_FILE", "collectors.json"))
		if err != nil {
			return err
		}
		return collect.Run(ctx, db, sources, once)
	}

	if err := cmdb.EnsureUser(bootstrap, db, os.Getenv("RADAR_ADMIN_USER"), os.Getenv("RADAR_ADMIN_PASSWORD"), "admin"); err != nil {
		return fmt.Errorf("初始化管理员: %w", err)
	}
	for _, account := range []struct{ prefix, role string }{
		{"RADAR_OPERATOR", "operator"}, {"RADAR_VIEWER", "viewer"},
	} {
		username, password := os.Getenv(account.prefix+"_USER"), os.Getenv(account.prefix+"_PASSWORD")
		if username == "" && password == "" {
			continue
		}
		if err := cmdb.EnsureUser(bootstrap, db, username, password, account.role); err != nil {
			return fmt.Errorf("初始化 %s 账号: %w", account.role, err)
		}
	}

	secureCookie, err := boolEnv("RADAR_COOKIE_SECURE")
	if err != nil {
		return err
	}
	webDir := env("RADAR_WEB_DIR", "web/dist")
	if _, err := os.Stat(filepath.Join(webDir, "index.html")); err != nil {
		return fmt.Errorf("前端构建产物不可用，请先运行 npm run build: %w", err)
	}
	return serve(ctx, env("RADAR_LISTEN", "127.0.0.1:8080"), cmdb.NewServer(db, secureCookie, http.FileServer(http.Dir(webDir))))
}

func serve(ctx context.Context, addr string, handler http.Handler) error {
	server := &http.Server{
		Addr: addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: time.Minute,
	}
	done := make(chan error, 1)
	go func() {
		slog.Info("web server starting", "address", addr)
		done <- server.ListenAndServe()
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func boolEnv(key string) (bool, error) {
	value, err := strconv.ParseBool(strings.TrimSpace(env(key, "false")))
	if err != nil {
		return false, fmt.Errorf("%s 须为 true 或 false", key)
	}
	return value, nil
}
