package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"easy-cmdb/internal/cmdb"
	"easy-cmdb/internal/config"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		slog.Error("easy", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) > 1 || (len(args) == 1 && args[0] != "serve") {
		return errors.New("用法: easy [serve]")
	}

	cfg, _, err := config.Load("config.yaml")
	if err != nil {
		return fmt.Errorf("读取配置: %w", err)
	}
	db, err := cmdb.Open(cfg.Database)
	if err != nil {
		return fmt.Errorf("打开数据库: %w", err)
	}
	defer db.Close()

	bootstrap, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := cmdb.Initialize(bootstrap, db); err != nil {
		return fmt.Errorf("初始化数据库: %w", err)
	}

	if err := cmdb.EnsureUser(bootstrap, db, cfg.Admin.Username, cfg.Admin.Password, "admin"); err != nil {
		return fmt.Errorf("初始化管理员: %w", err)
	}
	for _, account := range []struct {
		role string
		cfg  config.Account
	}{
		{"operator", cfg.Operator}, {"viewer", cfg.Viewer},
	} {
		if account.cfg.Username == "" && account.cfg.Password == "" {
			continue
		}
		if err := cmdb.EnsureUser(bootstrap, db, account.cfg.Username, account.cfg.Password, account.role); err != nil {
			return fmt.Errorf("初始化 %s 账号: %w", account.role, err)
		}
	}

	webDir := cfg.WebDir
	if _, err := os.Stat(filepath.Join(webDir, "index.html")); err != nil {
		return fmt.Errorf("前端构建产物不可用，请先运行 npm run build: %w", err)
	}
	return serve(ctx, cfg.Listen, cmdb.NewServer(db, cfg.CookieSecure, http.FileServer(http.Dir(webDir))))
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
