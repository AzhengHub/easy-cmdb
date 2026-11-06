package collect

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"regexp"
	"sync"
	"time"

	"radar-cmdb/internal/cmdb"
)

type Source struct {
	Key             string `json:"key"`
	Name            string `json:"name"`
	Platform        string `json:"platform"`
	Endpoint        string `json:"endpoint"`
	TokenEnv        string `json:"tokenEnv,omitempty"`
	CAFile          string `json:"caFile,omitempty"`
	IntervalSeconds int    `json:"intervalSeconds,omitempty"`
	VMDetails       bool   `json:"vmDetails,omitempty"`
}

var validKey = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

func LoadSources(path string) ([]Source, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	var sources []Source
	if err := decoder.Decode(&sources); err != nil {
		return nil, fmt.Errorf("读取采集配置: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("采集配置须为一个 JSON 数组")
	}
	if len(sources) == 0 {
		return nil, errors.New("采集配置中没有数据源")
	}
	keys := make(map[string]bool)
	for i := range sources {
		s := &sources[i]
		if !validKey.MatchString(s.Key) || keys[s.Key] || s.Name == "" || s.Endpoint == "" {
			return nil, fmt.Errorf("第 %d 个数据源的 key、name 或 endpoint 无效，key 须唯一", i+1)
		}
		keys[s.Key] = true
		if s.Platform != "pve" && s.Platform != "kvm" {
			return nil, fmt.Errorf("%s 的 platform 须为 pve 或 kvm", s.Key)
		}
		if s.IntervalSeconds == 0 {
			s.IntervalSeconds = 300
		}
		if s.IntervalSeconds < 30 || s.IntervalSeconds > 86400 {
			return nil, fmt.Errorf("%s 的同步周期须为 30–86400 秒", s.Key)
		}
	}
	return sources, nil
}

func Run(ctx context.Context, db *sql.DB, sources []Source, once bool) error {
	var workers sync.WaitGroup
	results := make(chan error, len(sources))
	for _, source := range sources {
		workers.Go(func() {
			for {
				err := syncSource(ctx, db, source)
				if once {
					results <- err
					return
				}
				timer := time.NewTimer(time.Duration(source.IntervalSeconds) * time.Second)
				select {
				case <-timer.C:
				case <-ctx.Done():
					timer.Stop()
					return
				}
			}
		})
	}
	workers.Wait()
	close(results)
	var result error
	for err := range results {
		result = errors.Join(result, err)
	}
	return result
}

func syncSource(ctx context.Context, db *sql.DB, source Source) error {
	lock, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer lock.Close()
	var acquired bool
	err = lock.QueryRowContext(ctx, "SELECT pg_try_advisory_lock(5843203, hashtext($1))", source.Key).Scan(&acquired)
	if err != nil || !acquired {
		return err
	}
	defer func() {
		unlock, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := lock.ExecContext(unlock, "SELECT pg_advisory_unlock(5843203, hashtext($1))", source.Key); err != nil {
			slog.Error("release collector lock", "source", source.Key, "error", err)
			// A broken connection is discarded so its advisory lock cannot stay in the pool.
			_ = lock.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()

	request, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	var snapshot cmdb.Snapshot
	switch source.Platform {
	case "pve":
		snapshot, err = pveSnapshot(request, source)
	case "kvm":
		snapshot, err = kvmSnapshot(request, source)
	}
	message := ""
	if err != nil {
		message = err.Error()
	} else {
		err = cmdb.ApplySnapshot(request, lock, source.Key, source.Platform, snapshot)
		if err != nil {
			message = "写入同步结果失败，请检查采集日志"
		}
	}
	if err == nil {
		slog.Info("sync complete", "source", source.Key, "resources", len(snapshot.Assets))
		return nil
	}
	slog.Error("sync failed", "source", source.Key, "error", err)
	if ctx.Err() == nil {
		record, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if recordErr := cmdb.RecordSyncFailure(record, lock, source.Key, source.Platform, message); recordErr != nil {
			slog.Error("record sync failure", "source", source.Key, "error", recordErr)
		}
	}
	return fmt.Errorf("%s: %w", source.Key, err)
}
