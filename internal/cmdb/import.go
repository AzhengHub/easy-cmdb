package cmdb

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxImportBytes = 16 << 20
	maxImportRows  = 5000
)

type ImportResult struct {
	Imported int `json:"imported"`
}

type importRow struct {
	number int
	fields Fields
}

var importHeaderAliases = map[string]string{
	"资源名称": "name", "名称": "name", "name": "name",
	"类型": "kind", "资源类型": "kind", "kind": "kind",
	"平台": "platform", "platform": "platform",
	"状态": "status", "status": "status",
	"生命周期": "lifecycle", "lifecycle": "lifecycle",
	"地址 / ip": "address", "地址/ip": "address", "地址": "address", "ip": "address", "address": "address",
	"cpu":    "cpu",
	"内存 mib": "memory", "内存mib": "memory", "内存": "memory", "memorymib": "memory", "memory_mib": "memory", "memory": "memory",
	"负责人": "owner", "owner": "owner",
	"环境": "environment", "environment": "environment",
	"备注": "notes", "notes": "notes",
	"扩展属性": "attributes", "属性": "attributes", "attributes": "attributes",
}

var importKinds = map[string]string{
	"host": "host", "物理机": "host", "主机": "host", "宿主机": "host",
	"vm": "vm", "虚拟机": "vm",
	"switch": "switch", "交换机": "switch",
}

var importPlatforms = map[string]string{
	"": "", "pve": "pve", "proxmox ve": "pve", "proxmox": "pve", "kvm": "kvm",
}

var importStatuses = map[string]string{
	"unknown": "unknown", "未知": "unknown",
	"online": "online", "在线": "online",
	"offline": "offline", "离线": "offline",
	"running": "running", "运行中": "running",
	"stopped": "stopped", "已停止": "stopped",
	"paused": "paused", "已暂停": "paused",
}

var importLifecycles = map[string]string{
	"active": "active", "在册": "active",
	"retired": "retired", "已退役": "retired",
}

// ImportAssets parses a UTF-8 CSV file and creates every row in one
// transaction. The first row must contain a header; Chinese and English header
// names are both accepted. Existing asset names are rejected to avoid silently
// duplicating inventory during a repeated import.
func ImportAssets(ctx context.Context, db *sql.DB, source io.Reader, actor string) (ImportResult, error) {
	data, err := io.ReadAll(io.LimitReader(source, maxImportBytes+1))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return ImportResult{}, fmt.Errorf("%w: CSV 文件不能超过 16 MiB", ErrInvalid)
		}
		return ImportResult{}, fmt.Errorf("%w: 读取 CSV 失败", ErrInvalid)
	}
	if len(data) > maxImportBytes {
		return ImportResult{}, fmt.Errorf("%w: CSV 文件不能超过 16 MiB", ErrInvalid)
	}
	if !utf8.Valid(data) {
		return ImportResult{}, fmt.Errorf("%w: CSV 须为 UTF-8 编码，Excel 请选择「CSV UTF-8」", ErrInvalid)
	}
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})

	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if errors.Is(err, io.EOF) {
		return ImportResult{}, fmt.Errorf("%w: CSV 文件为空", ErrInvalid)
	}
	if err != nil {
		return ImportResult{}, fmt.Errorf("%w: 无法读取 CSV 表头", ErrInvalid)
	}
	columns, err := mapImportColumns(header)
	if err != nil {
		return ImportResult{}, err
	}

	records, err := reader.ReadAll()
	if err != nil {
		var parseErr *csv.ParseError
		if errors.As(err, &parseErr) {
			return ImportResult{}, fmt.Errorf("%w: 第 %d 行 CSV 格式不正确", ErrInvalid, parseErr.StartLine)
		}
		return ImportResult{}, fmt.Errorf("%w: 解析 CSV 失败", ErrInvalid)
	}
	rows := make([]importRow, 0, len(records))
	seen := make(map[string]int)
	for i, record := range records {
		if importRecordEmpty(record) {
			continue
		}
		rowNumber := i + 2
		fields, err := decodeImportRow(record, columns, rowNumber)
		if err != nil {
			return ImportResult{}, err
		}
		nameKey := strings.ToLower(fields.Name)
		if previous, exists := seen[nameKey]; exists {
			return ImportResult{}, fmt.Errorf("%w: 第 %d 行：资源名称与第 %d 行重复", ErrInvalid, rowNumber, previous)
		}
		seen[nameKey] = rowNumber
		rows = append(rows, importRow{number: rowNumber, fields: fields})
	}
	if len(rows) == 0 {
		return ImportResult{}, fmt.Errorf("%w: CSV 中没有可导入的数据", ErrInvalid)
	}
	if len(rows) > maxImportRows {
		return ImportResult{}, fmt.Errorf("%w: 单次最多导入 %d 行", ErrInvalid, maxImportRows)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return ImportResult{}, err
	}
	defer tx.Rollback()

	existing, err := importExistingNames(ctx, tx)
	if err != nil {
		return ImportResult{}, err
	}
	for _, row := range rows {
		if existing[strings.ToLower(row.fields.Name)] {
			return ImportResult{}, fmt.Errorf("%w: 第 %d 行：资产名称 %q 已存在", ErrInvalid, row.number, row.fields.Name)
		}
	}
	for _, row := range rows {
		if _, err := createAsset(ctx, tx, row.fields, actor); err != nil {
			return ImportResult{}, fmt.Errorf("导入第 %d 行: %w", row.number, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return ImportResult{}, err
	}
	return ImportResult{Imported: len(rows)}, nil
}

func mapImportColumns(header []string) (map[string]int, error) {
	columns := make(map[string]int, len(header))
	for i, name := range header {
		canonical, ok := importHeaderAliases[normalizeImportHeader(name)]
		if !ok {
			continue
		}
		if _, exists := columns[canonical]; exists {
			return nil, fmt.Errorf("%w: CSV 表头重复：%s", ErrInvalid, strings.TrimSpace(name))
		}
		columns[canonical] = i
	}
	if _, ok := columns["kind"]; !ok {
		return nil, fmt.Errorf("%w: CSV 缺少「类型」列", ErrInvalid)
	}
	if _, ok := columns["name"]; !ok {
		return nil, fmt.Errorf("%w: CSV 缺少「资源名称」列", ErrInvalid)
	}
	return columns, nil
}

func normalizeImportHeader(value string) string {
	value = strings.TrimPrefix(value, "\ufeff")
	return strings.ToLower(strings.TrimSpace(value))
}

func importRecordEmpty(record []string) bool {
	for _, value := range record {
		if strings.TrimSpace(value) != "" {
			return false
		}
	}
	return true
}

func decodeImportRow(record []string, columns map[string]int, rowNumber int) (Fields, error) {
	value := func(key string) string {
		index, ok := columns[key]
		if !ok || index >= len(record) {
			return ""
		}
		return strings.TrimSpace(record[index])
	}

	rawKind := value("kind")
	kind, ok := importKinds[strings.ToLower(rawKind)]
	if !ok {
		return Fields{}, importRowError(rowNumber, "资源类型 %q 无效，可用：物理机、虚拟机、交换机", rawKind)
	}
	name := value("name")
	if name == "" {
		return Fields{}, importRowError(rowNumber, "资源名称不能为空")
	}

	rawPlatform := value("platform")
	if rawPlatform == "—" || rawPlatform == "-" {
		rawPlatform = ""
	}
	platform, ok := importPlatforms[strings.ToLower(rawPlatform)]
	if !ok {
		return Fields{}, importRowError(rowNumber, "平台 %q 无效，可用：Proxmox VE、KVM 或留空", rawPlatform)
	}

	rawStatus := value("status")
	lifecycleHint := ""
	if rawStatus == "已退役" {
		rawStatus = "unknown"
		lifecycleHint = "retired"
	}
	status := ""
	if rawStatus != "" {
		status, ok = importStatuses[strings.ToLower(rawStatus)]
		if !ok {
			return Fields{}, importRowError(rowNumber, "状态 %q 无效", rawStatus)
		}
	}

	rawLifecycle := value("lifecycle")
	if rawLifecycle == "" {
		rawLifecycle = lifecycleHint
	}
	lifecycle := ""
	if rawLifecycle != "" {
		lifecycle, ok = importLifecycles[strings.ToLower(rawLifecycle)]
		if !ok {
			return Fields{}, importRowError(rowNumber, "生命周期 %q 无效，可用：在册、已退役", rawLifecycle)
		}
	}

	cpu, err := importInt(value("cpu"), "CPU", rowNumber, 32)
	if err != nil {
		return Fields{}, err
	}
	memory, err := importInt(value("memory"), "内存 MiB", rowNumber, 64)
	if err != nil {
		return Fields{}, err
	}
	attributes := value("attributes")
	if attributes == "" {
		attributes = "{}"
	}
	if !json.Valid([]byte(attributes)) || !strings.HasPrefix(attributes, "{") {
		return Fields{}, importRowError(rowNumber, "扩展属性须为 JSON 对象，例如 {\"位置\":\"A01\"}")
	}

	fields := Fields{
		Kind: kind, Name: name, Platform: platform, Status: status, Lifecycle: lifecycle,
		Owner: value("owner"), Environment: value("environment"), Address: value("address"),
		CPU: int(cpu), MemoryMiB: memory, Notes: value("notes"), Attributes: json.RawMessage(attributes),
	}
	if err := validateFields(&fields); err != nil {
		return Fields{}, importRowError(rowNumber, "%s", err)
	}
	return fields, nil
}

func importInt(value, label string, rowNumber, bits int) (int64, error) {
	if value == "" {
		return 0, nil
	}
	number, err := strconv.ParseInt(value, 10, bits)
	if err != nil {
		return 0, importRowError(rowNumber, "%s 须为整数", label)
	}
	return number, nil
}

func importRowError(rowNumber int, format string, args ...any) error {
	return fmt.Errorf("%w: 第 %d 行：%s", ErrInvalid, rowNumber, fmt.Sprintf(format, args...))
}

func importExistingNames(ctx context.Context, tx *sql.Tx) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx, "SELECT name FROM assets")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names[strings.ToLower(name)] = true
	}
	return names, rows.Err()
}

func (s *Server) importAssets(w http.ResponseWriter, r *http.Request) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || (media != "text/csv" && media != "application/csv" && media != "application/vnd.ms-excel") {
		fail(w, http.StatusBadRequest, "请上传 CSV 文件")
		return
	}
	if r.ContentLength > maxImportBytes {
		fail(w, http.StatusRequestEntityTooLarge, "CSV 文件不能超过 16 MiB")
		return
	}
	body := http.MaxBytesReader(w, r.Body, maxImportBytes)
	defer body.Close()
	result, err := ImportAssets(r.Context(), s.db, body, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, result)
}
