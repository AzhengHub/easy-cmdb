package cmdb

import (
	"net/http"
	"strconv"
)

func (s *Server) listVLANs(w http.ResponseWriter, r *http.Request) {
	vlans, err := ListVLANs(r.Context(), s.db)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, vlans)
}

func (s *Server) saveVLAN(w http.ResponseWriter, r *http.Request) {
	var id int64
	if r.Method == http.MethodPut {
		var ok bool
		id, ok = pathID(w, r)
		if !ok {
			return
		}
	}
	var input struct {
		VLANFields
		Version int `json:"version"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	vlan, err := SaveVLAN(r.Context(), s.db, id, input.VLANFields, input.Version, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	status := http.StatusOK
	if id == 0 {
		status = http.StatusCreated
	}
	respond(w, status, vlan)
}

func (s *Server) deleteVLAN(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	version, err := strconv.Atoi(r.URL.Query().Get("version"))
	if err != nil || version < 1 {
		fail(w, http.StatusBadRequest, "记录版本无效，请刷新后重试")
		return
	}
	if err := DeleteVLAN(r.Context(), s.db, id, version, currentUser(r).Username); err != nil {
		s.databaseError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
