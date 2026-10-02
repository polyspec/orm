package bench

import (
	"strings"
	"testing"
)

// TestBenchDSNIsRequired fails the bench database lookup when
// ORM_BENCH_MYSQL_DSN is unset; the bench and the gate never fall back to a
// local server.
func TestBenchDSNIsRequired(t *testing.T) {
	t.Setenv("ORM_BENCH_MYSQL_DSN", "")
	if _, err := benchDSN(); err == nil || !strings.Contains(err.Error(), "ORM_BENCH_MYSQL_DSN is required") {
		t.Fatalf("benchDSN() error = %v, want the ORM_BENCH_MYSQL_DSN requirement", err)
	}
	t.Setenv("ORM_BENCH_MYSQL_DSN", "mysql://bench@127.0.0.1:3306/orm_bench")
	if got, err := benchDSN(); err != nil || got != "mysql://bench@127.0.0.1:3306/orm_bench" {
		t.Fatalf("benchDSN() = %q, %v", got, err)
	}
}
