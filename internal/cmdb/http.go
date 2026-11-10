package cmdb

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

var ErrInvalid = errors.New("输入无效")

type Server struct {
	db           *sql.DB
	secureCookie bool
	loginSlots   chan struct{}
	captchas     *captchaStore
}

func NewServer(db *sql.DB, secureCookie bool, frontend http.Handler) http.Handler {
	s := &Server{db: db, secureCookie: secureCookie, loginSlots: make(chan struct{}, 4), captchas: newCaptchaStore(captchaMax)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := s.db.PingContext(r.Context()); err != nil {
			fail(w, http.StatusServiceUnavailable, "数据库不可用")
			return
		}
		respond(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/captcha", s.issueCaptcha)
	mux.HandleFunc("POST /api/login", s.signIn)
	mux.HandleFunc("POST /api/logout", s.requireUser(false, s.signOut))
	mux.HandleFunc("POST /api/me/password", s.requireUser(false, s.changeOwnPassword))
	mux.HandleFunc("GET /api/me", s.requireUser(false, func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusOK, currentUser(r))
	}))
	mux.HandleFunc("GET /api/assets", s.requireUser(false, s.listAssets))
	mux.HandleFunc("GET /api/search", s.requireUser(false, s.search))
	mux.HandleFunc("POST /api/assets/bulk", s.requireUser(true, s.bulkUpdateAssets))
	mux.HandleFunc("POST /api/assets/bulk/tags", s.requireUser(true, s.bulkUpdateAssetTags))
	mux.HandleFunc("GET /api/tags", s.requireUser(false, s.listTags))
	mux.HandleFunc("POST /api/tags", s.requireUser(true, s.saveTag))
	mux.HandleFunc("PUT /api/tags/{id}", s.requireUser(true, s.saveTag))
	mux.HandleFunc("DELETE /api/tags/{id}", s.requireUser(true, s.deleteTag))
	mux.HandleFunc("GET /api/assets/{id}/tags", s.requireUser(false, s.listAssetTags))
	mux.HandleFunc("PUT /api/assets/{id}/tags", s.requireUser(true, s.setAssetTags))
	mux.HandleFunc("POST /api/assets", s.requireUser(true, s.saveAsset))
	mux.HandleFunc("POST /api/assets/import", s.requireUser(true, s.importAssets))
	mux.HandleFunc("POST /api/assets/import/preview", s.requireUser(true, s.previewImport))
	mux.HandleFunc("PUT /api/assets/{id}", s.requireUser(true, s.saveAsset))
	mux.HandleFunc("GET /api/links", s.requireUser(false, s.listLinks))
	mux.HandleFunc("POST /api/links", s.requireUser(true, s.saveLink))
	mux.HandleFunc("DELETE /api/links/{id}", s.requireUser(true, s.deleteLink))
	mux.HandleFunc("GET /api/changes", s.requireUser(false, s.listChanges))
	s.registerFacilities(mux)
	s.registerIPAM(mux)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, http.StatusNotFound, "接口不存在")
	})
	mux.Handle("/", frontend)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" && r.Method != http.MethodGet {
				fail(w, http.StatusForbidden, "请求来源无效")
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) listAssets(w http.ResponseWriter, r *http.Request) {
	assets, err := ListAssets(r.Context(), s.db)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, assets)
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	results, err := Search(r.Context(), s.db, r.URL.Query().Get("q"))
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, results)
}

func (s *Server) listTags(w http.ResponseWriter, r *http.Request) {
	tags, err := ListTags(r.Context(), s.db)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, tags)
}

func (s *Server) bulkUpdateAssetTags(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs    []int64 `json:"ids"`
		TagIDs []int64 `json:"tagIds"`
		Mode   string  `json:"mode"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(input.IDs) == 0 || len(input.IDs) > 1000 {
		fail(w, http.StatusBadRequest, "请选择 1–1000 条资产")
		return
	}
	updated, err := BulkUpdateAssetTags(r.Context(), s.db, input.IDs, input.TagIDs, input.Mode, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]int{"updated": updated})
}

func (s *Server) saveTag(w http.ResponseWriter, r *http.Request) {
	var id int64
	if r.Method == http.MethodPut {
		var ok bool
		id, ok = pathID(w, r)
		if !ok {
			return
		}
	}
	var fields TagFields
	if err := decode(w, r, &fields); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	tag, err := SaveTag(r.Context(), s.db, id, fields)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	status := http.StatusOK
	if id == 0 {
		status = http.StatusCreated
	}
	respond(w, status, tag)
}

func (s *Server) deleteTag(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := DeleteTag(r.Context(), s.db, id); err != nil {
		s.databaseError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listAssetTags(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	tags, err := ListAssetTags(r.Context(), s.db, id)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, tags)
}

func (s *Server) setAssetTags(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var input struct {
		TagIDs []int64 `json:"tagIds"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	tags, err := SetAssetTags(r.Context(), s.db, id, input.TagIDs, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, tags)
}

func (s *Server) bulkUpdateAssets(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs         []int64 `json:"ids"`
		Status      *string `json:"status"`
		Platform    *string `json:"platform"`
		Lifecycle   *string `json:"lifecycle"`
		Owner       *string `json:"owner"`
		Environment *string `json:"environment"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(input.IDs) == 0 || len(input.IDs) > 1000 {
		fail(w, http.StatusBadRequest, "请选择 1–1000 条资产")
		return
	}
	ids := make([]int64, 0, len(input.IDs))
	seen := make(map[int64]bool, len(input.IDs))
	for _, id := range input.IDs {
		if id < 1 {
			fail(w, http.StatusBadRequest, "资产编号无效")
			return
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	updated, err := BulkUpdateAssets(r.Context(), s.db, ids, BulkAssetPatch{
		Status: input.Status, Platform: input.Platform, Lifecycle: input.Lifecycle,
		Owner: input.Owner, Environment: input.Environment,
	}, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]int{"updated": updated})
}

func (s *Server) saveAsset(w http.ResponseWriter, r *http.Request) {
	var id int64
	if r.Method == http.MethodPut {
		var ok bool
		id, ok = pathID(w, r)
		if !ok {
			return
		}
	}

	var input struct {
		Fields
		Version int `json:"version"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateFields(&input.Fields); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	asset, err := SaveAsset(r.Context(), s.db, id, input.Version, input.Fields, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	status := http.StatusOK
	if id == 0 {
		status = http.StatusCreated
	}
	respond(w, status, asset)
}

func validateFields(fields *Fields) error {
	fields.Name = strings.TrimSpace(fields.Name)
	fields.Address = strings.TrimSpace(fields.Address)
	fields.Owner = strings.TrimSpace(fields.Owner)
	fields.Environment = strings.TrimSpace(fields.Environment)

	switch fields.Kind {
	case "host", "vm", "switch":
	default:
		return errors.New("请选择资源类型")
	}
	if fields.Name == "" || utf8.RuneCountInString(fields.Name) > 160 {
		return errors.New("资源名称须为 1–160 个字符")
	}
	switch fields.Platform {
	case "", "pve", "kvm":
	default:
		return errors.New("虚拟化平台无效")
	}
	switch fields.Status {
	case "":
		fields.Status = "unknown"
	case "unknown", "online", "offline", "running", "stopped", "paused":
	default:
		return errors.New("运行状态无效")
	}
	switch fields.Lifecycle {
	case "":
		fields.Lifecycle = "active"
	case "active", "retired":
	default:
		return errors.New("资产生命周期无效")
	}
	if fields.CPU < 0 || fields.CPU > 65536 || fields.MemoryMiB < 0 || fields.MemoryMiB > 1073741824 {
		return errors.New("CPU 或内存超出允许范围")
	}
	if len(fields.Address) > 512 || len(fields.Owner) > 512 || len(fields.Environment) > 128 || len(fields.Notes) > 8192 {
		return errors.New("地址、负责人、环境或备注超出长度限制")
	}
	if len(fields.Attributes) == 0 {
		fields.Attributes = json.RawMessage("{}")
	}
	if len(fields.Attributes) > 16384 || fields.Attributes[0] != '{' {
		return errors.New("扩展属性须为不超过 16 KiB 的 JSON 对象")
	}
	return nil
}

func (s *Server) listLinks(w http.ResponseWriter, r *http.Request) {
	links, err := ListLinks(r.Context(), s.db, 0)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, links)
}

func (s *Server) saveLink(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Kind   string `json:"kind"`
		FromID int64  `json:"fromId"`
		ToID   int64  `json:"toId"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if input.FromID < 1 || input.ToID < 1 || input.FromID == input.ToID {
		fail(w, http.StatusBadRequest, "请选择不同的起点与目标资源")
		return
	}
	link := Link{Kind: input.Kind, FromID: input.FromID, ToID: input.ToID}
	if err := ChangeLink(r.Context(), s.db, link, false, currentUser(r).Username); err != nil {
		s.databaseError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteLink(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := ChangeLink(r.Context(), s.db, Link{ID: id}, true, currentUser(r).Username); err != nil {
		s.databaseError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listChanges(w http.ResponseWriter, r *http.Request) {
	id := int64(0)
	if value := r.URL.Query().Get("assetId"); value != "" {
		var err error
		id, err = strconv.ParseInt(value, 10, 64)
		if err != nil || id < 1 {
			fail(w, http.StatusBadRequest, "资源编号无效")
			return
		}
	}
	changes, err := ListChanges(r.Context(), s.db, id)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, changes)
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		fail(w, http.StatusBadRequest, "资源编号无效")
		return 0, false
	}
	return id, true
}

func decode(w http.ResponseWriter, r *http.Request, target any) error {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return errors.New("请求须使用 application/json")
	}
	body := http.MaxBytesReader(w, r.Body, 48*1024)
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("请求格式不正确或超出长度限制")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("请求须包含一个 JSON 对象")
	}
	return nil
}

func respond(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func fail(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"error": message})
}

func (s *Server) databaseError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		fail(w, http.StatusNotFound, "记录不存在")
	case errors.Is(err, ErrConflict):
		fail(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrInvalid):
		fail(w, http.StatusBadRequest, strings.TrimPrefix(err.Error(), ErrInvalid.Error()+": "))
	default:
		slog.Error("database operation failed", "error", err)
		fail(w, http.StatusInternalServerError, "保存或读取失败，请稍后重试")
	}
}
