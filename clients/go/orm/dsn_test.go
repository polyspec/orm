package orm

import "testing"

func TestParseDSN(t *testing.T) {
	tests := []struct {
		name, input, driver, native string
	}{
		{"mysql tcp", "mysql://app:secret@127.0.0.1:3306/app?parseTime=true&clientFoundRows=true", "mysql", "app:secret@tcp(127.0.0.1:3306)/app?clientFoundRows=true&parseTime=true"},
		{"mysql socket", "mysql://root@localhost/app?socket=/tmp/mysql.sock&parseTime=true&clientFoundRows=true", "mysql", "root@unix(/tmp/mysql.sock)/app?clientFoundRows=true&parseTime=true"},
		{"postgres", "postgres://app:secret@127.0.0.1:5432/app?sslmode=disable", "postgres", "postgres://app:secret@127.0.0.1:5432/app?sslmode=disable"},
		{"sqlite", "sqlite:///tmp/app.sqlite?_pragma=busy_timeout(5000)", "sqlite", "file:/tmp/app.sqlite?_pragma=busy_timeout(5000)"},
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
		"mysql://root@localhost/app?parseTime=true",
		"mysql://root@localhost/app",
		"mysql://root@localhost",
		"postgres://root@localhost",
		"sqlite://relative.sqlite",
		"oracle://root@localhost/app",
	} {
		t.Run(input, func(t *testing.T) {
			if _, _, err := parseDSN(input); err == nil {
				t.Fatal("parseDSN accepted an invalid DSN")
			}
		})
	}
}
