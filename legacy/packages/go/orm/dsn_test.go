package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: CFG-1, CFG-2, CFG-10, CFG-12, CFG-19, CFG-20, CFG-37.
func TestParseDSN(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	tests := []struct {
		name, input, driver, native, zone string
	}{
		{"mysql tcp", "mysql://orm:secret@127.0.0.1:3306/orm_example", "mysql", "orm:secret@tcp(127.0.0.1:3306)/orm_example?clientFoundRows=true&parseTime=true&sql_mode=%27STRICT_ALL_TABLES%2CONLY_FULL_GROUP_BY%2CNO_ZERO_DATE%2CNO_ZERO_IN_DATE%2CERROR_FOR_DIVISION_BY_ZERO%2CNO_ENGINE_SUBSTITUTION%27&time_zone=%27%2B00%3A00%27", "UTC"},
		{"mysql socket and UTC", "mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&timezone=%2B00:00", "mysql", "root@unix(/tmp/mysql.sock)/orm_example?clientFoundRows=true&parseTime=true&sql_mode=%27STRICT_ALL_TABLES%2CONLY_FULL_GROUP_BY%2CNO_ZERO_DATE%2CNO_ZERO_IN_DATE%2CERROR_FOR_DIVISION_BY_ZERO%2CNO_ENGINE_SUBSTITUTION%27&time_zone=%27%2B00%3A00%27", "UTC"},
		{"postgres", "postgres://orm:secret@127.0.0.1:5432/orm_example?timezone=UTC", "postgres", "postgres://orm:secret@127.0.0.1:5432/orm_example?sslmode=disable&timezone=UTC", "UTC"},
		{"postgres socket", "postgres:///orm_example?host=/tmp", "postgres", "postgres:///orm_example?host=%2Ftmp&sslmode=disable&timezone=UTC", "UTC"},
		{"sqlite", "sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout(5000)&timezone=UTC", "sqlite", "file:/tmp/orm_example.sqlite?_pragma=busy_timeout%285000%29&_pragma=foreign_keys%281%29", "UTC"},
		{"sqlite lock wait", "sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout(250)", "sqlite", "file:/tmp/orm_example.sqlite?_pragma=busy_timeout%28250%29&_pragma=foreign_keys%281%29", "UTC"},
		{"sqlite default lock wait", "sqlite:///tmp/orm_example.sqlite", "sqlite", "file:/tmp/orm_example.sqlite?_pragma=busy_timeout%285000%29&_pragma=foreign_keys%281%29", "UTC"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseDSN(tt.input, 0)
			if err != nil || got.driver != tt.driver || got.native != tt.native || got.location.String() != tt.zone {
				t.Fatalf("parseDSN() = %+v, %v; want %s %s %s", got, err, tt.driver, tt.native, tt.zone)
			}
		})
	}
}

// TestParseDSNHandsTheDriverNoQuery checks that a parameter of the driver is refused and that the native DSN holds only
// the values that the client sets, never the query of the DSN.
// Requirements: CFG-19, CFG-20, CFG-37.
func TestParseDSNHandsTheDriverNoQuery(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, input := range []string{
		"mysql://orm@127.0.0.1:3306/orm_example?charset=utf8mb4",
		"mysql://orm@127.0.0.1:3306/orm_example?parseTime=false",
		"postgres://orm@127.0.0.1:5432/orm_example?application_name=orm",
		"postgres://orm@127.0.0.1:5432/orm_example?options=-c%20search_path%3Dx",
		"sqlite:///tmp/orm_example.sqlite?_time_format=sqlite",
	} {
		if _, err := parseDSN(input, 0); ErrorCode(err) != CodeConfig {
			t.Errorf("parseDSN(%q) = %v, want CONFIG", input, err)
		}
	}
	got, err := parseDSN("postgres://orm@127.0.0.1:5432/orm_example?sslmode=disable&timezone=UTC", 1500)
	if want := "postgres://orm@127.0.0.1:5432/orm_example?options=-c%20statement_timeout%3D1500&sslmode=disable&timezone=UTC"; err != nil || got.native != want {
		t.Errorf("parseDSN() = %q, %v; want %q", got.native, err, want)
	}
}

// TestDriverFromDSN checks that DriverFromDSN names the database of each DSN scheme and refuses a DSN that is no URI.
// Requirements: CFG-40.
func TestDriverFromDSN(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for input, want := range map[string]string{
		"mysql://orm@127.0.0.1:3306/orm_example":    "mysql",
		"postgres://orm@127.0.0.1:5432/orm_example": "postgres",
		"sqlite:///tmp/orm_example.sqlite":          "sqlite",
	} {
		if got, err := DriverFromDSN(input); err != nil || got != want {
			t.Errorf("DriverFromDSN(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	if _, err := DriverFromDSN("orm_example"); ErrorCode(err) != CodeConfig {
		t.Errorf("DriverFromDSN of a DSN that is no URI = %v, want CONFIG", err)
	}
}
