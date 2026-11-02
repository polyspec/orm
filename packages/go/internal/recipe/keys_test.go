package recipe

import (
	"strings"
	"testing"
)

// testSchema names the recipe schema from this package directory, four levels below the repository root.
const testSchema = "../../../../scripts/features/schema/recipe.schema.json"

// recipeWith is a recipe of one case whose steps are the given JSON, at the path recipe.json of this package.
func recipeWith(top, steps string) string {
	return `{"$schema":"` + testSchema + `",` + top + `"cases":[{"id":"c","requirements":[],"steps":[` + steps + `]}]}`
}

func TestCheckKeysAcceptsAndRefusesByName(t *testing.T) {
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
		{"dsn on model.connect, which does not hold it", recipeWith(file, `{"op":"model.connect","pool_size":1,"as":"db","dsn":"case-socket"}`), "recipe recipe.json case c step 0 (model.connect): unknown key dsn"},
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

func TestLoadKeyTableNamesTheSchemaTable(t *testing.T) {
	table, err := loadKeyTable("recipe.json", testSchema)
	if err != nil {
		t.Fatal(err)
	}
	if len(table.Step) == 0 || !strings.Contains(strings.Join(table.Step["model.connect"], ","), "pool_size") {
		t.Fatalf("the key table holds no model.connect keys: %v", table.Step)
	}
}
