package cmdb

import (
	"net/http"
	"strconv"
)

func (s *Server) registerIPAM(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/subnets", s.requireUser(false, s.listSubnets))
	mux.HandleFunc("POST /api/subnets", s.requireUser(true, s.saveSubnet))
	mux.HandleFunc("PUT /api/subnets/{id}", s.requireUser(true, s.saveSubnet))
	mux.HandleFunc("DELETE /api/subnets/{id}", s.requireUser(true, s.deleteSubnet))
	mux.HandleFunc("GET /api/subnets/{id}/addresses", s.requireUser(false, s.listSubnetAddresses))
	mux.HandleFunc("POST /api/subnets/{id}/allocations", s.requireUser(true, s.saveAllocation))
	mux.HandleFunc("PUT /api/allocations/{id}", s.requireUser(true, s.updateAllocation))
	mux.HandleFunc("DELETE /api/allocations/{id}", s.requireUser(true, s.deleteAllocation))
	mux.HandleFunc("GET /api/ip-addresses", s.requireUser(false, s.listIPAddresses))
	mux.HandleFunc("GET /api/vlans", s.requireUser(false, s.listVLANs))
	mux.HandleFunc("POST /api/vlans", s.requireUser(true, s.saveVLAN))
	mux.HandleFunc("PUT /api/vlans/{id}", s.requireUser(true, s.saveVLAN))
	mux.HandleFunc("DELETE /api/vlans/{id}", s.requireUser(true, s.deleteVLAN))
}

func (s *Server) listSubnets(w http.ResponseWriter, r *http.Request) {
	subnets, err := ListSubnets(r.Context(), s.db)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, subnets)
}

func (s *Server) saveSubnet(w http.ResponseWriter, r *http.Request) {
	var id int64
	if r.Method == http.MethodPut {
		var ok bool
		id, ok = pathID(w, r)
		if !ok {
			return
		}
	}
	var input struct {
		SubnetFields
		Version int `json:"version"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	subnet, err := SaveSubnet(r.Context(), s.db, id, input.SubnetFields, input.Version, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	status := http.StatusOK
	if r.Method == http.MethodPost {
		status = http.StatusCreated
	}
	respond(w, status, subnet)
}

func (s *Server) deleteSubnet(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	version, err := strconv.Atoi(r.URL.Query().Get("version"))
	if err != nil || version < 1 {
		fail(w, http.StatusBadRequest, "记录版本无效，请刷新后重试")
		return
	}
	if err := DeleteSubnet(r.Context(), s.db, id, version, currentUser(r).Username); err != nil {
		s.databaseError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listSubnetAddresses(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	detail, err := GetSubnet(r.Context(), s.db, id)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, detail)
}

func (s *Server) saveAllocation(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var input AllocationFields
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	allocation, err := SaveAllocation(r.Context(), s.db, id, input, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusCreated, allocation)
}

func (s *Server) updateAllocation(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var input struct {
		AllocationFields
		Version int `json:"version"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	allocation, err := UpdateAllocation(r.Context(), s.db, id, input.Version, input.AllocationFields, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, allocation)
}

func (s *Server) listIPAddresses(w http.ResponseWriter, r *http.Request) {
	addresses, err := ListIPAddresses(r.Context(), s.db)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, addresses)
}

func (s *Server) deleteAllocation(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	version, err := strconv.Atoi(r.URL.Query().Get("version"))
	if err != nil || version < 1 {
		fail(w, http.StatusBadRequest, "记录版本无效，请刷新后重试")
		return
	}
	if err := DeleteAllocation(r.Context(), s.db, id, version, currentUser(r).Username); err != nil {
		s.databaseError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
