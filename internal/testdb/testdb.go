// Package testdb는 database case 하나가 혼자 쓰는 database(case database)를 만든다.
//
// ORM_TEST_MYSQL_DSN과 ORM_TEST_POSTGRES_DSN이 가리키는 database는 여러 실행과 session이
// 함께 쓰므로 비어 있다고 가정할 수 없다. schema를 설치하거나 빈 database를 확인하는
// case는 New로 자기 database를 만들고, database는 case가 끝날 때(실패한 뒤에도) 지워진다.
// 공유 DSN은 admin 연결로만 쓰고 그 database에는 아무것도 만들지 않는다.
//
// PostgreSQL도 schema가 아니라 database를 만든다. Empty()는 public이 아닌 schema를
// 내용으로 세므로 공유 database 안의 case schema로는 빈 database를 확인할 수 없다.
package testdb

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/polyspec/orm/internal/testcase"
)

// counter는 이 process가 만든 case database의 번호다. 이름은 process id와 이 번호로
// 정해지므로 동시에 실행되는 process끼리 겹치지 않는다.
var counter atomic.Int64

// Name은 다음 case database 이름 orm_case_<pid>_<번호>를 돌려준다. PgBouncer가 하나의
// database에 묶은 case처럼 database를 만들 수 없는 case가 자기 table 이름으로 쓴다.
func Name() string {
	return fmt.Sprintf("orm_case_%d_%d", os.Getpid(), counter.Add(1))
}

// New는 driver("sqlite", "mysql", "postgres")의 case database를 만들고 그 DSN을
// 돌려준다. MySQL과 PostgreSQL은 ORM_TEST_<DRIVER>_DSN의 server에 orm_case_<pid>_<번호>
// database를 만들고 DSN의 path만 그 이름으로 바꾼다(query는 그대로다). SQLite는 OS temp
// directory의 새 file orm-case-<pid>-<번호>.sqlite다. 만들고 지운 일은 t를 감싼
// case(testcase.Of)의 STEP 줄로 보고하고, 지우기는 t.Cleanup에서 실행되므로 실패한
// case 뒤에도 실행된다. 지우지 못하면 database 이름과 함께 case를 실패시킨다.
func New(t testing.TB, driver string) string {
	t.Helper()
	c := testcase.Of(t)
	if driver == "sqlite" {
		path := filepath.Join(os.TempDir(), fmt.Sprintf("orm-case-%d-%d.sqlite", os.Getpid(), counter.Add(1)))
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatalf("create case file: %v", err)
		}
		file.Close()
		c.Step("file %s created", path)
		t.Cleanup(func() {
			for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
				if err := os.Remove(path + suffix); err != nil && !os.IsNotExist(err) {
					t.Errorf("remove case file %s: %v", path+suffix, err)
					return
				}
			}
			c.Step("file %s removed", path)
		})
		return "sqlite://" + path
	}
	env := "ORM_TEST_" + strings.ToUpper(driver) + "_DSN"
	base := os.Getenv(env)
	if base == "" {
		t.Fatalf("%s is required; database tests never skip", env)
	}
	name := Name()
	admin := Open(t, driver, base)
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		admin.Close()
		t.Fatalf("create case database %s: %v", name, err)
	}
	c.Step("database %s created", name)
	t.Cleanup(func() {
		defer admin.Close()
		stmt := "DROP DATABASE " + name
		if driver == "postgres" {
			stmt += " WITH (FORCE)"
		}
		if _, err := admin.Exec(stmt); err != nil {
			t.Errorf("drop case database %s: %v", name, err)
			return
		}
		c.Step("database %s dropped", name)
	})
	return Retarget(t, base, name)
}

// Retarget은 dsn의 path를 database name으로 바꾼 DSN이다. case database를 다른 server
// (replica)에서 같은 이름으로 열 때 쓴다.
func Retarget(t testing.TB, dsn, name string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse DSN: %v", err)
	}
	u.Path = "/" + name
	return u.String()
}

// DatabaseOf는 MySQL이나 PostgreSQL DSN의 database 이름이다.
func DatabaseOf(t testing.TB, dsn string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse DSN: %v", err)
	}
	return strings.TrimPrefix(u.Path, "/")
}

// Open은 MySQL이나 PostgreSQL client DSN의 database를 native database/sql driver로
// 연다.
func Open(t testing.TB, driver, dsn string) *sql.DB {
	t.Helper()
	sqlDriver, native := "pgx", dsn
	if driver == "mysql" {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatalf("parse DSN: %v", err)
		}
		cfg := mysql.NewConfig()
		cfg.User = u.User.Username()
		cfg.Passwd, _ = u.User.Password()
		cfg.DBName = strings.TrimPrefix(u.Path, "/")
		cfg.Net, cfg.Addr = "tcp", u.Host
		if socket := u.Query().Get("socket"); socket != "" {
			cfg.Net, cfg.Addr = "unix", socket
		}
		sqlDriver, native = "mysql", cfg.FormatDSN()
	}
	raw, err := sql.Open(sqlDriver, native)
	if err != nil {
		t.Fatalf("open %s: %v", driver, err)
	}
	return raw
}
