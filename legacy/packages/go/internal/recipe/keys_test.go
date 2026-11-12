package recipe

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// testSchema names the recipe schema from this package directory, four levels below the repository root.
const testSchema = "../../../../../scripts/features/schema/recipe.schema.json"

// recipeWith is a recipe of one case whose steps are the given JSON, at the path recipe.json of this package.
func recipeWith(top, steps string) string {
	return `{"$schema":"` + testSchema + `",` + top + `"cases":[{"id":"c","requirements":[],"steps":[` + steps + `]}]}`
}

// TestCheckKeysAcceptsAndRefusesByName checks that the loader refuses each unknown file, case, op or step key by name and
// accepts a recipe whose keys the table holds.
// Requirements: FCV-4.
func TestCheckKeysAcceptsAndRefusesByName(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	const file = `"fixture":"none",`
	for _, tc := range []struct {
		name   string
		recipe string
		want   string
	}{
		{"a known step key of its op", recipeWith(file, `{"op":"model.connect","pool_size":1,"as":"db"}`), ""},
		{"dsn on dsn.connect, which holds it", recipeWith(file, `{"op":"dsn.connect","dsn":"case","expect":{}}`), ""},
		{"an unknown file key", recipeWith(file+`"bogus":1,`, `{"op":"model.connect","pool_size":1,"as":"db"}`), "recipe recipe.json: unknown key bogus"},
		{"an unknown case key", `{"$schema":"` + testSchema + `",` + file + `"cases":[{"id":"c","requirements":[],"databases":["mysql"],"steps":[{"op":"model.connect","pool_size":1,"as":"db"}]}]}`, "recipe recipe.json case c: unknown key databases"},
		{"dsn on model.connect, which holds it", recipeWith(file, `{"op":"model.connect","pool_size":1,"as":"db","dsn":"case-socket"}`), ""},
		{"an unknown model.connect key", recipeWith(file, `{"op":"model.connect","pool_size":1,"as":"db","socket":"x"}`), "recipe recipe.json case c step 0 (model.connect): unknown key socket"},
		{"an unknown op", recipeWith(file, `{"op":"model.frob"}`), "recipe recipe.json case c step 0: unknown op model.frob"},
		{"an unknown key on a later step", recipeWith(file, `{"op":"model.connect","pool_size":1,"as":"db"},{"op":"dsn.connect","dsn":"case","typo":1,"expect":{}}`), "recipe recipe.json case c step 1 (dsn.connect): unknown key typo"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := checkKeys("recipe.json", []byte(tc.recipe))
			switch {
			case tc.want == "" && err != nil:
				t.Fatalf("refused a known key: %v", err)
			case tc.want != "" && err == nil:
				t.Fatalf("accepted an unknown key, want %q", tc.want)
			case tc.want != "" && err.Error() != tc.want:
				t.Fatalf("error %q, want %q", err.Error(), tc.want)
			}
		})
	}
}

// TestLoadKeyTableNamesTheSchemaTable checks that the key table read beside the schema of the recipe holds the keys of
// its ops.
// Requirements: FCV-4.
func TestLoadKeyTableNamesTheSchemaTable(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	table, err := loadKeyTable("recipe.json", testSchema)
	if err != nil {
		t.Fatal(err)
	}
	if len(table.Step) == 0 || !strings.Contains(strings.Join(table.Step["model.connect"], ","), "pool_size") {
		t.Fatalf("the key table holds no model.connect keys: %v", table.Step)
	}
}

// TestConnectDSN checks the DSN that model.connect opens (FCV-4, CFG-10): "case" and an absent DSN are the case database,
// "case-socket" is the MySQL case database through the socket of the environment, and other text is opened as written.
func TestConnectDSN(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	const caseDSN = "mysql://root@127.0.0.1:3306/orm_test"
	t.Run("absent DSN is the case database", func(t *testing.T) {
		got, err := connectDSN("", "mysql", caseDSN)
		if err != nil || got != caseDSN {
			t.Fatalf("connectDSN absent = %q, %v; want %q", got, err, caseDSN)
		}
	})
	t.Run("case is the case database", func(t *testing.T) {
		got, err := connectDSN("case", "postgres", "postgres://orm@127.0.0.1/orm_test")
		if err != nil || got != "postgres://orm@127.0.0.1/orm_test" {
			t.Fatalf("connectDSN case = %q, %v", got, err)
		}
	})
	t.Run("text is opened as written", func(t *testing.T) {
		got, err := connectDSN("sqlite://x.sqlite", "sqlite", caseDSN)
		if err != nil || got != "sqlite://x.sqlite" {
			t.Fatalf("connectDSN text = %q, %v", got, err)
		}
	})
	t.Run("case-socket is the MySQL socket DSN", func(t *testing.T) {
		t.Setenv("ORM_TEST_MYSQL_SOCKET", "/tmp/orm-test/mysql.sock")
		got, err := connectDSN("case-socket", "mysql", caseDSN)
		want := "mysql://root@localhost/orm_test?socket=/tmp/orm-test/mysql.sock"
		if err != nil || got != want {
			t.Fatalf("connectDSN case-socket = %q, %v; want %q", got, err, want)
		}
		// The socket DSN names the case database of the case, whatever its name.
		got, err = connectDSN("case-socket", "mysql", "mysql://root@127.0.0.1:3306/orm_case_17")
		want = "mysql://root@localhost/orm_case_17?socket=/tmp/orm-test/mysql.sock"
		if err != nil || got != want {
			t.Fatalf("connectDSN case-socket on orm_case_17 = %q, %v; want %q", got, err, want)
		}
	})
	t.Run("case-socket refuses a database other than mysql", func(t *testing.T) {
		t.Setenv("ORM_TEST_MYSQL_SOCKET", "/tmp/orm-test/mysql.sock")
		if _, err := connectDSN("case-socket", "postgres", caseDSN); err == nil {
			t.Fatal("connectDSN case-socket on postgres: no error")
		}
	})
	t.Run("case-socket refuses an unset socket", func(t *testing.T) {
		t.Setenv("ORM_TEST_MYSQL_SOCKET", "")
		if _, err := connectDSN("case-socket", "mysql", caseDSN); err == nil {
			t.Fatal("connectDSN case-socket with no socket: no error")
		}
	})
}

// TestChainFromRefusesAnotherModel checks that a step with from reads a bound chain only of the model it names, so a
// wrong model cannot pass as read.
// Requirements: FCV-4.
func TestChainFromRefusesAnotherModel(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	c := &databaseContext{bound: map[string]bound{"chain": {api: orm.NewCore(&orm.Entity{Name: "held"})}}}
	s := chainStep{From: "chain", chainQuery: chainQuery{Model: "Other", reads: newStepReads([]byte(`{"op":"model.query","from":"chain","model":"Other"}`))}}
	_, err := chainBuilt(s, nil, c)
	if err == nil || err.Error() != "from chain is a chain of held, and the step names other" {
		t.Fatalf("chainBuilt: %v", err)
	}
}

// TestStepWithExpectFailsAnUnreadKey checks that a step whose expect compares equal still fails on a key the run did not
// read, so an ignored field such as page or where cannot pass.
// Requirements: FCV-4.
func TestStepWithExpectFailsAnUnreadKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	raw := []byte(`{"op":"model.query","page":true}`)
	s := databaseStep{Op: "model.query", Expect: map[string]json.RawMessage{"sqlite": json.RawMessage(`{"rows":[]}`)}, reads: newStepReads(raw)}
	c := &databaseContext{database: "sqlite", bound: map[string]bound{}}
	op := func(databaseStep, *databaseContext) (outcome, error) {
		return outcome{fields: map[string]any{"rows": []any{}}}, nil
	}
	err := runStepWith(s, c, op)
	if err == nil || err.Error() != "the helper did not read page of model.query" {
		t.Fatalf("runStepWith: %v", err)
	}
}

// TestStepReadsFailsAnUnreadKeyByName checks that a key of a step that the run does not read fails the step by name, an
// annotation aside, and that an outcome key of an expected error that no compare takes does too.
// Requirements: FCV-4.
func TestStepReadsFailsAnUnreadKeyByName(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	reads := newStepReads([]byte(`{"op":"dsn.connect","dsn":"case","reason":"for the reader","bogus":1}`))
	reads.mark("dsn")
	err := reads.check()
	if err == nil || err.Error() != "the helper did not read bogus of dsn.connect" {
		t.Fatalf("check: %v", err)
	}
	reads.mark("bogus")
	if err := reads.check(); err != nil {
		t.Fatalf("check after the read: %v", err)
	}
	err = reads.checkOutcome(map[string]any{"error": "X", "bogus": 1}, "dsn.connect", "error")
	if err == nil || err.Error() != "the helper did not read expect.bogus of dsn.connect" {
		t.Fatalf("checkOutcome: %v", err)
	}
	reads.mark("expect.bogus")
	if err := reads.checkOutcome(map[string]any{"error": "X", "bogus": 1}, "dsn.connect", "error"); err != nil {
		t.Fatalf("checkOutcome after the read: %v", err)
	}
}
