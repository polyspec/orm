package orm

import "testing"

func TestParseDSN(t *testing.T) {
	tests := []struct {
		name, input, driver, native, zone string
	}{
		{"mysql tcp", "mysql://app:secret@127.0.0.1:3306/app", "mysql", "app:secret@tcp(127.0.0.1:3306)/app?clientFoundRows=true&parseTime=true", "Local"},
		{"mysql socket and zone", "mysql://root@localhost/app?socket=/tmp/mysql.sock&timezone=%2B09:00", "mysql", "root@unix(/tmp/mysql.sock)/app?clientFoundRows=true&parseTime=true&time_zone=%27%2B09%3A00%27", "+09:00"},
		{"postgres", "postgres://app:secret@127.0.0.1:5432/app?timezone=Asia/Seoul", "postgres", "postgres://app:secret@127.0.0.1:5432/app?timezone=Asia/Seoul", "Asia/Seoul"},
		{"postgres offset", "postgres:///app?host=/tmp&timezone=%2B09:00", "postgres", "postgres:///app?host=%2Ftmp&timezone=%3C%2B09%3A00%3E-09%3A00", "+09:00"},
		{"postgres socket", "postgres:///app?host=/tmp", "postgres", "postgres:///app?host=/tmp", "Local"},
		{"sqlite", "sqlite:///tmp/app.sqlite?_pragma=busy_timeout(5000)&timezone=UTC", "sqlite", "file:/tmp/app.sqlite?_pragma=busy_timeout%285000%29&_pragma=foreign_keys%281%29&_txlock=immediate", "UTC"},
		{"sqlite lock wait", "sqlite:///tmp/app.sqlite?_pragma=busy_timeout(250)", "sqlite", "file:/tmp/app.sqlite?_pragma=busy_timeout%28250%29&_pragma=foreign_keys%281%29&_txlock=immediate", "Local"},
		{"sqlite default lock wait", "sqlite:///tmp/app.sqlite", "sqlite", "file:/tmp/app.sqlite?_pragma=busy_timeout%285000%29&_pragma=foreign_keys%281%29&_txlock=immediate", "Local"},
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
		"sqlite:///tmp/app.sqlite?_txlock=immediate",
		"sqlite:///tmp/app.sqlite?_txlock=deferred",
		"mysql://root@localhost/app?timezone=Nowhere/City",
		"oracle://root@localhost/app",
		"root@tcp(localhost)/app",
	} {
		t.Run(input, func(t *testing.T) {
			if _, err := parseDSN(input, 0); err == nil {
				t.Fatal("parseDSN accepted an invalid DSN")
			}
		})
	}
}
