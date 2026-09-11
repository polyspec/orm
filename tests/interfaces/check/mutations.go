package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Parse real altered source files. Mutating an already-extracted JSON map would
// test comparison only and could hide an extractor that misses a declaration.
func parserMutations(toolRoot, lang, rust string) error {
	fixtures := map[string]struct {
		ext, source string
		changes     [][2]string
	}{
		"go": {"go", `package fixture
type Binding struct{}
type Row struct{}
type Query struct { binding Binding }
func (q *Query) Gets() ([]Row, error) { return nil, nil }
`, [][2]string{
			{"Gets()", "Missing()"},
			{"Gets()", "Gets(db Binding)"},
			{"([]Row, error)", "(Row, error)"},
			{"(q *Query)", "(q *Row)"},
			{"binding Binding", "binding *Row"},
			{"type Query struct", "type Other struct"},
		}},
		"php": {"php", `<?php
class Binding {}
class Row {}
class Query {
    private Binding $binding;
    public function gets(): array { return []; }
}
`, [][2]string{
			{"function gets()", "function missing()"},
			{"function gets()", "function gets(Binding $db)"},
			{"gets(): array", "gets(): Row"},
			{"private Binding $binding", "private Row $binding"},
			{"public function gets", "private function gets"},
			{"class Query", "class Other"},
		}},
		"rust": {"rs", `pub struct Binding;
pub struct Row;
pub struct Query { binding: Binding }
impl Query { pub async fn gets(&mut self) -> Result<Vec<Row>, Error> { todo!() } }
`, [][2]string{
			{"fn gets", "fn missing"},
			{"gets(&mut self)", "gets(&mut self, db: Binding)"},
			{"Result<Vec<Row>, Error>", "Result<Row, Error>"},
			{"impl Query", "impl Row"},
			{"binding: Binding", "binding: Row"},
			{"gets(&mut self)", "gets(self)"},
		}},
	}
	f := fixtures[lang]
	dir, err := os.MkdirTemp("", "orm-interface-mutation-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "fixture."+f.ext)
	if err := os.WriteFile(path, []byte(f.source), 0600); err != nil {
		return err
	}
	baseline, err := extract(dir, lang, []string{"."}, rust, toolRoot)
	if err != nil {
		return err
	}
	if len(baseline) < 4 {
		return fmt.Errorf("%s parser returned too few fixture declarations", lang)
	}
	for i, change := range f.changes {
		if !strings.Contains(f.source, change[0]) {
			return fmt.Errorf("invalid mutation fixture")
		}
		if err := os.WriteFile(path, []byte(strings.Replace(f.source, change[0], change[1], 1)), 0600); err != nil {
			return err
		}
		got, err := extract(dir, lang, []string{"."}, rust, toolRoot)
		if err != nil {
			return err
		}
		if len(differences(baseline, got)) == 0 {
			return fmt.Errorf("%s parser missed source mutation %d (%s)", lang, i, change[1])
		}
	}
	fmt.Printf("%s: %d source mutations rejected\n", lang, len(f.changes))
	return nil
}
