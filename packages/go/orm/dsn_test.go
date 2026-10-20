package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: CFG-1, CFG-2, CFG-10, CFG-12, CFG-20.
func TestParseDSN(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	tests := []struct {
		name, input, driver, native, zone string
	}{
		{"mysql tcp", "mysql://orm:secret@127.0.0.1:3306/orm_example", "mysql", "orm:secret@tcp(127.0.0.1:3306)/orm_example?clientFoundRows=true&parseTime=true&sql_mode=%27STRICT_ALL_TABLES%2CONLY_FULL_GROUP_BY%2CNO_ZERO_DATE%2CNO_ZERO_IN_DATE%2CERROR_FOR_DIVISION_BY_ZERO%2CNO_ENGINE_SUBSTITUTION%27&time_zone=%27%2B00%3A00%27", "UTC"},
		{"mysql socket and UTC", "mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&timezone=%2B00:00", "mysql", "root@unix(/tmp/mysql.sock)/orm_example?clientFoundRows=true&parseTime=true&sql_mode=%27STRICT_ALL_TABLES%2CONLY_FULL_GROUP_BY%2CNO_ZERO_DATE%2CNO_ZERO_IN_DATE%2CERROR_FOR_DIVISION_BY_ZERO%2CNO_ENGINE_SUBSTITUTION%27&time_zone=%27%2B00%3A00%27", "UTC"},
		{"postgres", "postgres://orm:secret@127.0.0.1:5432/orm_example?timezone=UTC", "postgres", "postgres://orm:secret@127.0.0.1:5432/orm_example?timezone=UTC", "UTC"},
		// Another MySQL or PostgreSQL parameter reaches the driver unchanged (CFG-20).
		{"mysql driver parameter", "mysql://orm@127.0.0.1:3306/orm_example?charset=utf8mb4", "mysql", "orm@tcp(127.0.0.1:3306)/orm_example?charset=utf8mb4&clientFoundRows=true&parseTime=true&sql_mode=%27STRICT_ALL_TABLES%2CONLY_FULL_GROUP_BY%2CNO_ZERO_DATE%2CNO_ZERO_IN_DATE%2CERROR_FOR_DIVISION_BY_ZERO%2CNO_ENGINE_SUBSTITUTION%27&time_zone=%27%2B00%3A00%27", "UTC"},
		{"postgres driver parameter", "postgres://orm@127.0.0.1:5432/orm_example?application_name=orm", "postgres", "postgres://orm@127.0.0.1:5432/orm_example?application_name=orm&timezone=UTC", "UTC"},
		{"postgres socket", "postgres:///orm_example?host=/tmp", "postgres", "postgres:///orm_example?host=%2Ftmp&timezone=UTC", "UTC"},
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

// Requirements: CFG-19.
func TestParseDSNRejectsInvalidInput(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, input := range []string{
		"mysql://root@localhost",
		"postgres://root@localhost",
		"sqlite://relative.sqlite",
		"sqlite:///tmp/orm_example.sqlite?_txlock=immediate",
		"sqlite:///tmp/orm_example.sqlite?_txlock=deferred",
		"mysql://root@localhost/orm_example?timezone=Nowhere/City",
		// Every connection reads and writes datetime as UTC (docs/spec/dialects.md "Date and time").
		"mysql://root@localhost/orm_example?timezone=%2B09:00",
		"postgres://root@localhost/orm_example?timezone=Asia/Seoul",
		"sqlite:///tmp/orm_example.sqlite?timezone=Asia%2FSeoul",
		"oracle://root@localhost/orm_example",
		"root@tcp(localhost)/orm_example",
	} {
		t.Run(input, func(t *testing.T) {
			if _, err := parseDSN(input, 0); err == nil {
				t.Fatal("parseDSN accepted an invalid DSN")
			}
		})
	}
}
