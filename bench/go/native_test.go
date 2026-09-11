// S0 native baseline: database/sql + go-sql-driver over the local socket.
// Workloads: PK get, 100-row list, INSERT, 4-step relation chain (1 parent +
// 3 IN-batched children, assembled in Go). Run:
//
//	go test ./bench/go -run xxx -bench . -benchmem -benchtime 3s
//	ORM_BENCH_PAR=64 go test ./bench/go -run xxx -bench Par -benchmem
package bench

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	_ "github.com/go-sql-driver/mysql"
)

const localDSN = "root@unix(/tmp/mysql.sock)/orm_bench?parseTime=true&clientFoundRows=true&interpolateParams=false"

// dsn is the local socket unless ORM_MYSQL_DSN_GO names another server (CI).
func dsn() string {
	if v := os.Getenv("ORM_MYSQL_DSN_GO"); v != "" {
		return v
	}
	return localDSN
}

const listCols = "`a`.`seq`, `a`.`name`, `a`.`created_ts`, `a`.`updated_ts`, `a`.`is_close`, `a`.`is_display`, `a`.`display_start_dt`, `a`.`display_end_dt`, `a`.`is_allday`, `a`.`target_team_player_count`, `a`.`success_count`, `a`.`player_count`, `a`.`read_count`, `a`.`cover_url`, `a`.`user_seq`, `a`.`service_seq`, `a`.`service_module_seq`, `a`.`service_member_seq`, `a`.`start_dt`, `a`.`end_dt`, `a`.`uuid`, `a`.`is_single_play`, `a`.`like_count`, AES_DECRYPT(UNHEX(`a`.`aes_hex_email`), ?) AS `aes_hex_email`, AES_DECRYPT(UNHEX(`a`.`aes_hex_phone`), ?) AS `aes_hex_phone`"

type battle struct {
	Seq                      int64
	Name                     string
	CreatedTs, UpdatedTs     sql.NullTime
	IsClose, IsDisplay       bool
	DisplayStart, DisplayEnd sql.NullTime
	IsAllday                 bool
	TargetTeamPlayerCount    int32
	SuccessCount             int32
	PlayerCount              int32
	ReadCount                int32
	CoverURL                 sql.NullString
	UserSeq                  int64
	ServiceSeq               int64
	ServiceModuleSeq         int64
	ServiceMemberSeq         int64
	StartDt, EndDt           sql.NullTime
	UUID                     sql.NullString
	IsSinglePlay             bool
	LikeCount                int32
	Email, Phone             sql.NullString
}

func scan(rows *sql.Rows, b *battle) error {
	return rows.Scan(&b.Seq, &b.Name, &b.CreatedTs, &b.UpdatedTs, &b.IsClose, &b.IsDisplay, &b.DisplayStart, &b.DisplayEnd,
		&b.IsAllday, &b.TargetTeamPlayerCount, &b.SuccessCount, &b.PlayerCount, &b.ReadCount, &b.CoverURL, &b.UserSeq,
		&b.ServiceSeq, &b.ServiceModuleSeq, &b.ServiceMemberSeq, &b.StartDt, &b.EndDt, &b.UUID, &b.IsSinglePlay, &b.LikeCount,
		&b.Email, &b.Phone)
}

// stmt caches prepared statements per SQL text (one round trip per query).
var (
	stmtMu sync.Mutex
	stmts  = map[string]*sql.Stmt{}
)

func prep(db *sql.DB, q string) *sql.Stmt {
	stmtMu.Lock()
	defer stmtMu.Unlock()
	if st, ok := stmts[q]; ok {
		return st
	}
	st, err := db.Prepare(q)
	if err != nil {
		panic(err)
	}
	stmts[q] = st
	return st
}

func open(tb testing.TB) *sql.DB {
	db, err := sql.Open("mysql", dsn())
	if err != nil {
		tb.Fatal(err)
	}
	// Statements belong to a *sql.DB; each benchmark opens its own.
	stmtMu.Lock()
	stmts = map[string]*sql.Stmt{}
	stmtMu.Unlock()
	par := 1
	if v := os.Getenv("ORM_BENCH_PAR"); v != "" {
		par, _ = strconv.Atoi(v)
	}
	db.SetMaxOpenConns(par)
	db.SetMaxIdleConns(par)
	if err := db.Ping(); err != nil {
		tb.Fatal(err)
	}
	return db
}

func pkGet(ctx context.Context, db *sql.DB, seq int64) (*battle, error) {
	rows, err := prep(db, "SELECT "+listCols+" FROM `battle` AS `a` WHERE `a`.`seq` = ? LIMIT 0, 1").QueryContext(ctx, "bench-salt", "bench-salt", seq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var b battle
	if err := scan(rows, &b); err != nil {
		return nil, err
	}
	return &b, rows.Err()
}

func list100(ctx context.Context, db *sql.DB, serviceSeq int64) ([]battle, error) {
	rows, err := prep(db, "SELECT "+listCols+" FROM `battle` AS `a` WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 100").QueryContext(ctx, "bench-salt", "bench-salt", serviceSeq, 0)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]battle, 0, 100)
	for rows.Next() {
		var b battle
		if err := scan(rows, &b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// relation4: parent list (20 rows) then three IN-batched child lookups on the
// same table (stands in for user / items / players), assembled into a map.
func relation4(ctx context.Context, db *sql.DB, serviceSeq int64) (map[int64][]battle, error) {
	parents, err := listN(ctx, db, serviceSeq, 20)
	if err != nil {
		return nil, err
	}
	keys := make([]any, 0, len(parents))
	var sb strings.Builder
	for i, p := range parents {
		if i > 0 {
			sb.WriteString(", ")
		}
		sb.WriteByte('?')
		keys = append(keys, p.UserSeq)
	}
	out := make(map[int64][]battle, len(parents))
	for step := 0; step < 3; step++ {
		args := append([]any{"bench-salt", "bench-salt"}, keys...)
		rows, err := prep(db, "SELECT "+listCols+" FROM `battle` AS `a` WHERE `a`.`user_seq` IN ("+sb.String()+") AND `a`.`is_close` = 0 ORDER BY `a`.`seq` DESC LIMIT 0, 200").QueryContext(ctx, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var b battle
			if err := scan(rows, &b); err != nil {
				rows.Close()
				return nil, err
			}
			out[b.UserSeq] = append(out[b.UserSeq], b)
		}
		rows.Close()
	}
	return out, nil
}

func listN(ctx context.Context, db *sql.DB, serviceSeq int64, n int) ([]battle, error) {
	rows, err := prep(db, fmt.Sprintf("SELECT "+listCols+" FROM `battle` AS `a` WHERE `a`.`service_seq` = ? ORDER BY `a`.`seq` DESC LIMIT 0, %d", n)).QueryContext(ctx, "bench-salt", "bench-salt", serviceSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]battle, 0, n)
	for rows.Next() {
		var b battle
		if err := scan(rows, &b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func insertOne(ctx context.Context, db *sql.DB, i int) (int64, error) {
	res, err := prep(db, "INSERT INTO `battle` (`name`, `user_seq`, `service_seq`, `service_module_seq`, `service_member_seq`, `start_dt`, `end_dt`, `aes_hex_email`) VALUES (?, ?, ?, ?, ?, ?, ?, HEX(AES_ENCRYPT(?, ?)))").ExecContext(ctx,
		"bench-insert-"+strconv.Itoa(i), 1, 999, 1, 1, "2026-06-01", "2026-12-31", "ins@example.com", "bench-salt")
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func BenchmarkPKGet(b *testing.B) {
	db := open(b)
	defer db.Close()
	ctx := context.Background()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := pkGet(ctx, db, int64(i%100000+1)); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkList100(b *testing.B) {
	db := open(b)
	defer db.Close()
	ctx := context.Background()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		rows, err := list100(ctx, db, int64(i%100+1))
		if err != nil || len(rows) == 0 {
			b.Fatalf("err=%v rows=%d", err, len(rows))
		}
	}
}

func BenchmarkInsert(b *testing.B) {
	db := open(b)
	defer db.Close()
	ctx := context.Background()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := insertOne(ctx, db, i); err != nil {
			b.Fatal(err)
		}
	}
	b.StopTimer()
	db.ExecContext(ctx, "DELETE FROM `battle` WHERE `service_seq` = 999")
}

func BenchmarkRelation4(b *testing.B) {
	db := open(b)
	defer db.Close()
	ctx := context.Background()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := relation4(ctx, db, int64(i%100+1)); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPKGetPar(b *testing.B) {
	db := open(b)
	defer db.Close()
	ctx := context.Background()
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			i++
			if _, err := pkGet(ctx, db, int64(i%100000+1)); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkList100Par(b *testing.B) {
	db := open(b)
	defer db.Close()
	ctx := context.Background()
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			i++
			if _, err := list100(ctx, db, int64(i%100+1)); err != nil {
				b.Fatal(err)
			}
		}
	})
}
