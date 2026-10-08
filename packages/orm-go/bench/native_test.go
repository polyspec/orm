// S0 native baseline: database/sql + go-sql-driver on the seeded bench
// database named by ORM_BENCH_MYSQL_DSN.
// Workloads: PK get, 100-row list, INSERT, 4-step relation chain (1 parent +
// 3 IN-batched children, assembled in Go). Run:
//
//	ORM_BENCH_MYSQL_DSN=mysql://… go test ./packages/orm-go/bench -run xxx -bench . -benchmem -benchtime 3s
//	ORM_BENCH_MYSQL_DSN=mysql://… ORM_BENCH_PAR=64 go test ./packages/orm-go/bench -run xxx -bench Par -benchmem
package bench

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/go-sql-driver/mysql"
	"github.com/polyspec/orm/packages/orm-go/orm"
)

// benchDSN returns the seeded bench database named by ORM_BENCH_MYSQL_DSN; an
// unset variable is an error.
func benchDSN() (string, error) {
	v := os.Getenv("ORM_BENCH_MYSQL_DSN")
	if v == "" {
		return "", fmt.Errorf("ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database, and bench tests never skip; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run")
	}
	return v, nil
}

// dsn returns the bench database DSN and fails tb when it is not configured.
func dsn(tb testing.TB) string {
	tb.Helper()
	v, err := benchDSN()
	if err != nil {
		tb.Fatal(err)
	}
	return v
}

// nativeDSN converts the DSN URI to the go-sql-driver form used by the
// native baseline.
func nativeDSN(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	cfg := mysql.NewConfig()
	cfg.User = u.User.Username()
	cfg.Passwd, _ = u.User.Password()
	cfg.DBName = strings.TrimPrefix(u.Path, "/")
	cfg.Net, cfg.Addr = "tcp", u.Host
	if socket := u.Query().Get("socket"); socket != "" {
		cfg.Net, cfg.Addr = "unix", socket
	}
	cfg.ParseTime = true
	cfg.ClientFoundRows = true
	return cfg.FormatDSN(), nil
}

// listCols는 generated client가 author의 기본 select set으로 만드는 column 목록과
// 같다. TestNativeStatementsEqualClient가 두 statement text를 비교한다.
const listCols = "`a`.`seq` AS `a__seq`, `a`.`name` AS `a__name`, `a`.`created_ts` AS `a__created_ts`, `a`.`updated_ts` AS `a__updated_ts`, `a`.`is_close` AS `a__is_close`, `a`.`is_display` AS `a__is_display`, `a`.`display_start_dt` AS `a__display_start_dt`, `a`.`display_end_dt` AS `a__display_end_dt`, `a`.`is_allday` AS `a__is_allday`, `a`.`target_club_reader_count` AS `a__target_club_reader_count`, `a`.`success_count` AS `a__success_count`, `a`.`reader_count` AS `a__reader_count`, `a`.`read_count` AS `a__read_count`, `a`.`photo_url` AS `a__photo_url`, `a`.`user_seq` AS `a__user_seq`, `a`.`service_seq` AS `a__service_seq`, `a`.`service_region_seq` AS `a__service_region_seq`, `a`.`service_member_seq` AS `a__service_member_seq`, `a`.`start_dt` AS `a__start_dt`, `a`.`end_dt` AS `a__end_dt`, `a`.`uuid` AS `a__uuid`, `a`.`is_single_work` AS `a__is_single_work`, `a`.`like_count` AS `a__like_count`, UNHEX(`a`.`aes_hex_email`) AS `a__aes_hex_email`, UNHEX(`a`.`aes_hex_phone`) AS `a__aes_hex_phone`, `a`.`price` AS `a__price`, `a`.`aes_key_version` AS `a__aes_key_version`"

type author struct {
	Seq                      int64
	Name                     string
	CreatedTs, UpdatedTs     sql.NullTime
	IsClose, IsDisplay       bool
	DisplayStart, DisplayEnd sql.NullTime
	IsAllday                 bool
	TargetClubReaderCount    int32
	SuccessCount             int32
	ReaderCount              int32
	ReadCount                int32
	PhotoURL                 sql.NullString
	UserSeq                  int64
	ServiceSeq               int64
	ServiceRegionSeq         int64
	ServiceMemberSeq         int64
	StartDt, EndDt           sql.NullTime
	UUID                     sql.NullString
	IsSingleWork             bool
	LikeCount                int32
	Email, Phone             sql.NullString
	Price                    sql.NullString
	AESKeyVersion            int32
}

// nativeKeyring은 client가 연결마다 한 번 만드는 것처럼 한 번 만든 AES keyring이다.
var nativeKeyring = sync.OnceValues(func() (orm.AESKeyring, error) {
	return orm.NewAESKeyring(map[int32]string{1: "bench-salt"}, 1)
})

func scan(rows *sql.Rows, b *author) error {
	var email, phone []byte
	if err := rows.Scan(&b.Seq, &b.Name, &b.CreatedTs, &b.UpdatedTs, &b.IsClose, &b.IsDisplay, &b.DisplayStart, &b.DisplayEnd,
		&b.IsAllday, &b.TargetClubReaderCount, &b.SuccessCount, &b.ReaderCount, &b.ReadCount, &b.PhotoURL, &b.UserSeq,
		&b.ServiceSeq, &b.ServiceRegionSeq, &b.ServiceMemberSeq, &b.StartDt, &b.EndDt, &b.UUID, &b.IsSingleWork, &b.LikeCount,
		&email, &phone, &b.Price, &b.AESKeyVersion); err != nil {
		return err
	}
	keyring, err := nativeKeyring()
	if err != nil {
		return err
	}
	// UNHEX가 hex를 server에서 풀었으므로 client처럼 aes stage만 decode한다.
	for _, column := range []struct {
		name   string
		cipher []byte
		value  *sql.NullString
	}{{"aes_hex_email", email, &b.Email}, {"aes_hex_phone", phone, &b.Phone}} {
		if column.cipher == nil {
			*column.value = sql.NullString{}
			continue
		}
		plain, err := orm.HostDecodeVersioned(column.cipher, []string{"aes"}, b.AESKeyVersion, keyring)
		if err != nil {
			return fmt.Errorf("native %s decode: %w", column.name, err)
		}
		text, ok := plain.(string)
		if !ok {
			return fmt.Errorf("native %s decode: got %T, want text", column.name, plain)
		}
		*column.value = sql.NullString{String: text, Valid: true}
	}
	return nil
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
	native, err := nativeDSN(dsn(tb))
	if err != nil {
		tb.Fatal(err)
	}
	db, err := sql.Open("mysql", native)
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

const (
	pkSQL      = "SELECT " + listCols + " FROM `author` AS `a` WHERE `a`.`seq` = ? LIMIT 0, 1"
	list100SQL = "SELECT " + listCols + " FROM `author` AS `a` WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? ORDER BY `a`.`seq` DESC LIMIT 0, 100"
)

func pkGet(ctx context.Context, db *sql.DB, seq int64) (*author, error) {
	rows, err := prep(db, pkSQL).QueryContext(ctx, seq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var b author
	if err := scan(rows, &b); err != nil {
		return nil, err
	}
	return &b, rows.Err()
}

func list100(ctx context.Context, db *sql.DB, serviceSeq int64) ([]author, error) {
	rows, err := prep(db, list100SQL).QueryContext(ctx, serviceSeq, 0)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]author, 0, 100)
	for rows.Next() {
		var b author
		if err := scan(rows, &b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// relation4: parent list (20 rows) then three IN-batched child lookups on the
// same table (stands in for user / items / readers), assembled into a map.
func relation4(ctx context.Context, db *sql.DB, serviceSeq int64) (map[int64][]author, error) {
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
	out := make(map[int64][]author, len(parents))
	for step := 0; step < 3; step++ {
		rows, err := prep(db, "SELECT "+listCols+" FROM `author` AS `a` WHERE `a`.`user_seq` IN ("+sb.String()+") AND `a`.`is_close` = 0 ORDER BY `a`.`seq` DESC LIMIT 0, 200").QueryContext(ctx, keys...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var b author
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

func listN(ctx context.Context, db *sql.DB, serviceSeq int64, n int) ([]author, error) {
	rows, err := prep(db, fmt.Sprintf("SELECT "+listCols+" FROM `author` AS `a` WHERE `a`.`service_seq` = ? ORDER BY `a`.`seq` DESC LIMIT 0, %d", n)).QueryContext(ctx, serviceSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]author, 0, n)
	for rows.Next() {
		var b author
		if err := scan(rows, &b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func insertOne(ctx context.Context, db *sql.DB, i int) (int64, error) {
	email, err := orm.HostEncode("ins@example.com", []string{"aes", "hex"}, "bench-salt")
	if err != nil {
		return 0, err
	}
	res, err := prep(db, "INSERT INTO `author` (`name`, `user_seq`, `service_seq`, `service_region_seq`, `service_member_seq`, `start_dt`, `end_dt`, `aes_hex_email`, `aes_key_version`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").ExecContext(ctx,
		"bench-insert-"+strconv.Itoa(i), 1, 999, 1, 1, "2026-06-01", "2026-12-31", email, 1)
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
	db.ExecContext(ctx, "DELETE FROM `author` WHERE `service_seq` = 999")
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
