package dbspec

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// syntaxVectorClasses are the classes of a token in tests/dbspec/syntax.json.
var syntaxVectorClasses = map[string]bool{
	"keyword": true, "type": true, "name": true, "setting": true, "number": true, "string": true,
	"operator": true, "punctuation": true, "comment": true, "word": true,
}

// syntaxInput is one analysis that syntax.json expects: its case id, its main
// text and the other documents of its set.
type syntaxInput struct {
	id        string
	text      string
	documents map[string]string
}

// exactKeys reports a missing or an unknown field of object.
func (r vectorReader) exactKeys(object map[string]any, location string, keys ...string) error {
	return r.fields(object, location, keys)
}

// loadSyntaxVectors reads tests/dbspec/syntax.json strictly.
// syntaxVectorCase is one case of syntax.json.
type syntaxVectorCase struct {
	id     string
	tokens []Token
}

func loadSyntaxVectors(t *testing.T) map[string][]Token {
	t.Helper()
	r, object := readVectorFile(t, "syntax.json")
	if err := r.version(object); err != nil {
		t.Fatal(err)
	}
	if err := r.exactKeys(object, "", "version", "note", "cases"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.string(object, "", "note"); err != nil {
		t.Fatal(err)
	}
	cases, err := vectorCases(r, object, "cases", func(c map[string]any, location, id string) (syntaxVectorCase, error) {
		if err := r.exactKeys(c, location, "id", "tokens"); err != nil {
			return syntaxVectorCase{}, err
		}
		items, err := r.arrayField(c, location, "tokens")
		if err != nil {
			return syntaxVectorCase{}, err
		}
		tokens := make([]Token, len(items))
		for i, item := range items {
			at := fmt.Sprintf("%s.tokens[%d]", location, i)
			fields, err := r.array(item, at)
			if err != nil {
				return syntaxVectorCase{}, err
			}
			if len(fields) != 4 {
				return syntaxVectorCase{}, r.fail(at, "does not have four items")
			}
			var numbers [3]int
			for k := range numbers {
				if numbers[k], err = r.integer(fields[k], fmt.Sprintf("%s[%d]", at, k)); err != nil {
					return syntaxVectorCase{}, err
				}
			}
			class, ok := fields[3].(string)
			if !ok || !syntaxVectorClasses[class] {
				return syntaxVectorCase{}, r.fail(at+"[3]", "is not a token class")
			}
			tokens[i] = Token{Line: numbers[0], Start: numbers[1], End: numbers[2], Class: class}
		}
		return syntaxVectorCase{id: id, tokens: tokens}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][]Token{}
	for _, c := range cases {
		out[c.id] = c.tokens
	}
	if len(out) != len(cases) {
		t.Fatal("syntax.json repeats a case id")
	}
	return out
}

// syntaxInputs lists the analyses of tests/dbspec/syntax.json as its generator
// builds them (scripts/dbspec/syntax-vectors.mts, vectorInputs).
func syntaxInputs(t *testing.T) []syntaxInput {
	t.Helper()
	vectors := loadVectors(t)
	var inputs []syntaxInput
	for _, section := range []struct {
		name  string
		cases []vectorCase
	}{{"canonical", vectors.Canonical}, {"normalize", vectors.Normalize}, {"invalid", vectors.Invalid}} {
		for _, c := range section.cases {
			main, ok := c.Documents[c.Main]
			if !ok {
				t.Fatalf("%s/%s: the main document %s is missing", section.name, c.ID, c.Main)
			}
			documents := map[string]string{}
			for name, lines := range c.Documents {
				if name != c.Main {
					documents[name] = c.join(lines)
				}
			}
			inputs = append(inputs, syntaxInput{id: section.name + "." + c.ID, text: c.join(main), documents: documents})
		}
	}
	for _, c := range vectors.Sets {
		all := append(append([][]string{}, c.Documents...), c.External...)
		for i, lines := range c.Documents {
			documents := map[string]string{}
			for name, other := range c.Parsing {
				documents[name] = joinLines(other, false)
			}
			for j, other := range all {
				if j != i {
					documents[syntaxHeaderName(t, other)] = joinLines(other, false)
				}
			}
			inputs = append(inputs, syntaxInput{id: fmt.Sprintf("sets.%s.%d", c.ID, i+1), text: joinLines(lines, false), documents: documents})
		}
	}
	for _, c := range vectors.Hashes {
		names := make([]string, 0, len(c.Documents))
		for name := range c.Documents {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			documents := map[string]string{}
			for other, lines := range c.Documents {
				if other != name {
					documents[other] = joinLines(lines, false)
				}
			}
			inputs = append(inputs, syntaxInput{id: "hashes." + c.ID + "." + name, text: joinLines(c.Documents[name], false), documents: documents})
		}
	}
	return inputs
}

// syntaxHeaderName is the third space-separated word of the first line, as
// the generator reads the name of a document.
func syntaxHeaderName(t *testing.T, lines []string) string {
	t.Helper()
	if len(lines) == 0 {
		t.Fatal("a document of a sets case has no lines")
	}
	words := strings.Split(lines[0], " ")
	if len(words) < 3 {
		t.Fatalf("the first line %q has no document name", lines[0])
	}
	return words[2]
}

// checkSyntaxVectors compares the tokens of analyze with tests/dbspec/syntax.json
// for every input, and requires the same set of cases.
func checkSyntaxVectors(t *testing.T, analyze func(string, map[string]string) Analysis) {
	t.Helper()
	want := loadSyntaxVectors(t)
	inputs := syntaxInputs(t)
	seen := map[string]bool{}
	for _, in := range inputs {
		seen[in.id] = true
		t.Run(in.id, func(t *testing.T) {
			expected, ok := want[in.id]
			if !ok {
				t.Fatal("syntax.json has no tokens for this case")
			}
			got := analyze(in.text, in.documents).Tokens
			if len(got) != len(expected) || (len(got) > 0 && !reflect.DeepEqual(got, expected)) {
				t.Errorf("tokens differ\n got %v\nwant %v", got, expected)
			}
		})
	}
	if len(seen) != len(want) {
		for id := range want {
			if !seen[id] {
				t.Errorf("%s: syntax.json has a case that the inputs do not produce", id)
			}
		}
	}
}

// TestSharedSyntaxVectors matches the tokens of Analyze with tests/dbspec/syntax.json.
func TestSharedSyntaxVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	checkSyntaxVectors(t, Analyze)
}
