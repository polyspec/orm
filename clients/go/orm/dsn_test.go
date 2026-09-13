package orm

import "testing"

func TestParseDSN(t *testing.T) {
	tests := []struct {
		name, input, driver, native string
	}{
		{"mysql tcp", "mysql://orm:secret@127.0.0.1:3306/orm_example?parseTime=true&clientFoundRows=true", "mysql", "orm:secret@tcp(127.0.0.1:3306)/orm_example?clientFoundRows=true&parseTime=true"},
		{"mysql socket", "mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&parseTime=true&clientFoundRows=true", "mysql", "root@unix(/tmp/mysql.sock)/orm_example?clientFoundRows=true&parseTime=true"},
		{"postgres", "postgres://orm:secret@127.0.0.1:5432/orm_example?sslmode=disable", "postgres", "postgres://orm:secret@127.0.0.1:5432/orm_example?sslmode=disable"},
		{"sqlite", "sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout(5000)", "sqlite", "file:/tmp/orm_example.sqlite?_pragma=busy_timeout(5000)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			driver, native, err := parseDSN(tt.input)
			if err != nil || driver != tt.driver || native != tt.native {
				t.Fatalf("parseDSN() = driver=%q native=%q err=%v, want driver=%q native=%q", driver, native, err, tt.driver, tt.native)
			}
		})
	}
}

func TestParseDSNRejectsUnsupportedOrUnsafeDSN(t *testing.T) {
	for _, input := range []string{
		"mysql://root@localhost/orm_example?parseTime=true",
		"mysql://root@localhost/orm_example",
		"mysql://root@localhost",
		"postgres://root@localhost",
		"sqlite://relative.sqlite",
		"oracle://root@localhost/orm_example",
	} {
		t.Run(input, func(t *testing.T) {
			if _, _, err := parseDSN(input); err == nil {
				t.Fatal("parseDSN accepted an invalid DSN")
			}
		})
	}
}
