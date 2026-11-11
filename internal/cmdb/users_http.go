package cmdb

import (
	"net/http"
	"strings"
)

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := ListUsers(r.Context(), s.db)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, users)
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var input UserFields
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	user, err := CreateUser(r.Context(), s.db, input, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusCreated, user)
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.PathValue("username"))
	if username == "" {
		fail(w, http.StatusBadRequest, "账号无效")
		return
	}
	var input UserFields
	if err := decode(w, r, &input); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	user, err := UpdateUser(r.Context(), s.db, username, input, currentUser(r).Username)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	respond(w, http.StatusOK, user)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.PathValue("username"))
	if username == "" {
		fail(w, http.StatusBadRequest, "账号无效")
		return
	}
	if err := DeleteUser(r.Context(), s.db, username, currentUser(r).Username); err != nil {
		s.databaseError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
