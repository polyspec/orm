package orm_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// sqlitePathCase는 tests/dsn/sqlite-paths.json의 case 하나다.
type sqlitePathCase struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	File  string `json:"file"`
	Error string `json:"error"`
}

// TestSQLitePathCases는 공유 case의 DSN path가 percent-decode한 file을 여는지,
// 잘못된 path가 CONFIG인지 확인한다(docs/config.md "Runtime connection").
func TestSQLitePathCases(t *testing.T) {
	testcase.Start(t, testcase.Database)
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "dsn", "sqlite-paths.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Version int              `json:"version"`
		Cases   []sqlitePathCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if vectors.Version != 1 || len(vectors.Cases) == 0 {
		t.Fatalf("tests/dsn/sqlite-paths.json: version %d with %d cases", vectors.Version, len(vectors.Cases))
	}
	s := fixtureSchema(t, "zone")
	for _, c := range vectors.Cases {
		t.Run(c.ID, func(t *testing.T) {
			begin := time.Now()
			t.Logf("start dsn/sqlite-path/%s", c.ID)
			dir := t.TempDir()
			db, err := orm.ConnectSchema("sqlite://"+dir+"/"+c.Path, s, orm.Config{})
			if err == nil {
				err = db.Close()
			}
			entries, readErr := os.ReadDir(dir)
			if readErr != nil {
				t.Fatal(readErr)
			}
			var names []string
			for _, e := range entries {
				names = append(names, e.Name())
			}
			switch {
			case c.Error != "":
				if orm.ErrorCode(err) != c.Error || len(names) != 0 {
					t.Fatalf("result dsn/sqlite-path/%s: FAIL after %s: error %v (code %q), files %q; want %s and no file", c.ID, time.Since(begin), err, orm.ErrorCode(err), names, c.Error)
				}
			case err != nil:
				t.Fatalf("result dsn/sqlite-path/%s: FAIL after %s: %v", c.ID, time.Since(begin), err)
			default:
				allowed := []string{c.File, c.File + "-journal", c.File + "-wal", c.File + "-shm"}
				for _, name := range names {
					if !slices.Contains(allowed, name) {
						t.Fatalf("result dsn/sqlite-path/%s: FAIL after %s: files %q; %q is not %q", c.ID, time.Since(begin), names, name, c.File)
					}
				}
				if !slices.Contains(names, c.File) {
					t.Fatalf("result dsn/sqlite-path/%s: FAIL after %s: files %q; %q is missing", c.ID, time.Since(begin), names, c.File)
				}
			}
			t.Logf("result dsn/sqlite-path/%s: PASS after %s", c.ID, time.Since(begin))
		})
	}
}
