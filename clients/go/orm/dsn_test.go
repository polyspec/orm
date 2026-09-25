package orm

import "testing"

func TestParseDSN(t *testing.T) {
	tests := []struct {
		name, input, driver, native, zone string
	}{
		{"mysql tcp", "mysql://orm:secret@127.0.0.1:3306/orm_example", "mysql", "orm:secret@tcp(127.0.0.1:3306)/orm_example?clientFoundRows=true&parseTime=true", "Local"},
		{"mysql socket and zone", "mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&timezone=%2B09:00", "mysql", "root@unix(/tmp/mysql.sock)/orm_example?clientFoundRows=true&parseTime=true&time_zone=%27%2B09%3A00%27", "+09:00"},
		{"postgres", "postgres://orm:secret@127.0.0.1:5432/orm_example?timezone=Asia/Seoul", "postgres", "postgres://orm:secret@127.0.0.1:5432/orm_example?timezone=Asia/Seoul", "Asia/Seoul"},
		{"postgres offset", "postgres:///orm_example?host=/tmp&timezone=%2B09:00", "postgres", "postgres:///orm_example?host=%2Ftmp&timezone=%3C%2B09%3A00%3E-09%3A00", "+09:00"},
		{"postgres socket", "postgres:///orm_example?host=/tmp", "postgres", "postgres:///orm_example?host=/tmp", "Local"},
		{"sqlite", "sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout(5000)&timezone=UTC", "sqlite", "file:/tmp/orm_example.sqlite?_pragma=busy_timeout%285000%29&_pragma=foreign_keys%281%29&_txlock=immediate", "UTC"},
		{"sqlite lock wait", "sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout(250)", "sqlite", "file:/tmp/orm_example.sqlite?_pragma=busy_timeout%28250%29&_pragma=foreign_keys%281%29&_txlock=immediate", "Local"},
		{"sqlite default lock wait", "sqlite:///tmp/orm_example.sqlite", "sqlite", "file:/tmp/orm_example.sqlite?_pragma=busy_timeout%285000%29&_pragma=foreign_keys%281%29&_txlock=immediate", "Local"},
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

func TestParseDSNRejectsInvalidInput(t *testing.T) {
	for _, input := range []string{
		"mysql://root@localhost",
		"postgres://root@localhost",
		"sqlite://relative.sqlite",
		"sqlite:///tmp/orm_example.sqlite?_txlock=immediate",
		"sqlite:///tmp/orm_example.sqlite?_txlock=deferred",
		"mysql://root@localhost/orm_example?timezone=Nowhere/City",
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
