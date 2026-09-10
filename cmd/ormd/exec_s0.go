package main

// S0-only execution ops used to measure "PHP → ormd executes → PHP" against
// "PHP → PDO". They pass SQL through verbatim and return positional rows as
// msgpack. S1 replaces them with plan execution (the shared Go executor).
//
//	{"op":"exec","sql":"...","binds":[...]}                 -> msgpack {columns, rows}
//	{"op":"exec_rel4","service_seq":N}                      -> msgpack {parents, children:{user_seq:[rows]}}

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"sync"

	_ "github.com/go-sql-driver/mysql"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/maxkwon/orm/engine"
)

const s0DSN = "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=false&clientFoundRows=true"

const s0ListCols = "`a`.`seq`, `a`.`name`, `a`.`created_ts`, `a`.`updated_ts`, `a`.`is_close`, `a`.`is_display`, `a`.`display_start_dt`, `a`.`display_end_dt`, `a`.`is_allday`, `a`.`target_team_player_count`, `a`.`success_count`, `a`.`player_count`, `a`.`read_count`, `a`.`cover_url`, `a`.`user_seq`, `a`.`service_seq`, `a`.`service_module_seq`, `a`.`service_member_seq`, `a`.`start_dt`, `a`.`end_dt`, `a`.`uuid`, `a`.`is_single_play`, `a`.`like_count`, AES_DECRYPT(UNHEX(`a`.`aes_hex_email`), ?) AS `aes_hex_email`, AES_DECRYPT(UNHEX(`a`.`aes_hex_phone`), ?) AS `aes_hex_phone`"

var (
	s0Once sync.Once
	s0DB   *sql.DB
	s0Err  error
	s0Mu   sync.Mutex
	s0Stmt = map[string]*sql.Stmt{}
)

// s0prep caches server-side prepared statements per SQL text so each query is
// one round trip (what the S1 executor's statement cache will do).
func s0prep(db *sql.DB, q string) (*sql.Stmt, error) {
	s0Mu.Lock()
	st, ok := s0Stmt[q]
	s0Mu.Unlock()
	if ok {
		return st, nil
	}
	st, err := db.Prepare(q)
	if err != nil {
		return nil, err
	}
	s0Mu.Lock()
	s0Stmt[q] = st
	s0Mu.Unlock()
	return st, nil
}

func s0db() (*sql.DB, error) {
	s0Once.Do(func() {
		s0DB, s0Err = sql.Open("mysql", s0DSN)
		if s0Err == nil {
			s0DB.SetMaxOpenConns(64)
			s0DB.SetMaxIdleConns(64)
			s0Err = s0DB.Ping()
		}
	})
	return s0DB, s0Err
}

type execReq struct {
	SQL   string `json:"sql"`
	Binds []any  `json:"binds"`
}

type table struct {
	Columns []string `msgpack:"columns"`
	Rows    [][]any  `msgpack:"rows"`
}

// readTable scans every row into positional []any using the column types the
// driver reports; numeric types come back as int64/float64, text as string,
// NULL as nil. This is what the S1 executor will do per assemble spec.
func readTable(rows *sql.Rows) (*table, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	t := &table{Columns: cols}
	n := len(cols)
	for rows.Next() {
		vals := make([]any, n)
		ptrs := make([]any, n)
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		for i, v := range vals {
			if b, ok := v.([]byte); ok {
				vals[i] = string(b)
			}
		}
		t.Rows = append(t.Rows, vals)
	}
	return t, rows.Err()
}

func handleExec(frame []byte) []byte {
	var req execReq
	if err := json.Unmarshal(frame, &req); err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "FRAME_INVALID", Msg: err.Error()})
	}
	db, err := s0db()
	if err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
	}
	st, err := s0prep(db, req.SQL)
	if err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
	}
	rows, err := st.QueryContext(context.Background(), req.Binds...)
	if err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
	}
	defer rows.Close()
	t, err := readTable(rows)
	if err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
	}
	out, _ := msgpack.Marshal(t)
	return out
}

type rel4Req struct {
	ServiceSeq int64 `json:"service_seq"`
}

type rel4Resp struct {
	Parents  *table            `msgpack:"parents"`
	Children map[int64][][]any `msgpack:"children"`
	Columns  []string          `msgpack:"child_columns"`
}

func handleRel4(frame []byte) []byte {
	var req rel4Req
	if err := json.Unmarshal(frame, &req); err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "FRAME_INVALID", Msg: err.Error()})
	}
	db, err := s0db()
	if err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
	}
	ctx := context.Background()
	stP, err := s0prep(db, "SELECT "+s0ListCols+" FROM `battle` AS `a` WHERE `a`.`service_seq` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 20")
	if err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
	}
	rows, err := stP.QueryContext(ctx, "bench-salt", "bench-salt", req.ServiceSeq)
	if err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
	}
	parents, err := readTable(rows)
	rows.Close()
	if err != nil {
		return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
	}
	userIdx := -1
	for i, c := range parents.Columns {
		if c == "user_seq" {
			userIdx = i
		}
	}
	keys := make([]any, 0, len(parents.Rows))
	seen := map[int64]bool{}
	for _, r := range parents.Rows {
		k := r[userIdx].(int64)
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	resp := rel4Resp{Parents: parents, Children: map[int64][][]any{}}
	if len(keys) == 0 {
		out, _ := msgpack.Marshal(resp)
		return out
	}
	ph := strings.Repeat("?, ", len(keys))
	ph = ph[:len(ph)-2]
	for step := 0; step < 3; step++ {
		args := append([]any{"bench-salt", "bench-salt"}, keys...)
		stC, err := s0prep(db, "SELECT "+s0ListCols+" FROM `battle` AS `a` WHERE `a`.`user_seq` IN ("+ph+") AND `a`.`is_close` = 0 ORDER BY `a`.`seq` DESC LIMIT 0, 200")
		if err != nil {
			return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
		}
		rows, err := stC.QueryContext(ctx, args...)
		if err != nil {
			return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
		}
		t, err := readTable(rows)
		rows.Close()
		if err != nil {
			return engine.ErrorJSON(&engine.Error{Code: "DB", Msg: err.Error()})
		}
		resp.Columns = t.Columns
		for _, r := range t.Rows {
			k := r[userIdx].(int64)
			resp.Children[k] = append(resp.Children[k], r)
		}
	}
	out, _ := msgpack.Marshal(resp)
	return out
}
