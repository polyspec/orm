package dbspec

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// setVectors is tests/dbspec/set-files.json (docs/spec/dbspec.md "Document sets").
type setVectors struct {
	Requirements map[string][]string `json:"requirements"`
	Version      *int                `json:"version"`
	Note         *string             `json:"note"`
	Cases        *[]setVectorCase    `json:"cases"`
}

type setVectorCase struct {
	ID   *string          `json:"id"`
	Tree *json.RawMessage `json:"tree"`
	Set  *string          `json:"set"`
	Want *setVectorWant   `json:"want"`
}

type setVectorWant struct {
	Documents *[]string          `json:"documents"`
	External  *[]string          `json:"external"`
	Errors    *[]setVectorErrors `json:"errors"`
}

type setVectorErrors struct {
	Rule *string `json:"rule"`
	Path *string `json:"path"`
}

// setTreeEntry is one path of a case tree: exactly one field is present.
type setTreeEntry struct {
	File     *string `json:"file"`
	Hex      *string `json:"hex"`
	Symlink  *string `json:"symlink"`
	Hardlink *string `json:"hardlink"`
}

type setTreePath struct {
	path  string
	entry setTreeEntry
}

// decodeStrict decodes raw into v and refuses unknown fields and trailing data.
func decodeStrict(raw []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return fmt.Errorf("trailing data after the value")
	}
	return nil
}

// readSetVectors reads the set vectors strictly: an unknown or a missing field is an error.
func readSetVectors(t *testing.T) []setVectorCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(repositoryRoot(t), "tests", "dbspec", "set-files.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v setVectors
	if err := decodeStrict(raw, &v); err != nil {
		t.Fatalf("set-files.json: %v", err)
	}
	if v.Version == nil || *v.Version != 1 || v.Note == nil || v.Cases == nil || len(*v.Cases) == 0 {
		t.Fatal("set-files.json: version 1, note and a non-empty cases list are required")
	}
	for i, c := range *v.Cases {
		if c.ID == nil || c.Tree == nil || c.Set == nil || c.Want == nil {
			t.Fatalf("set-files.json: cases[%d] needs id, tree, set and want", i)
		}
		w := c.Want
		success := w.Documents != nil && w.External != nil && w.Errors == nil
		failure := w.Documents == nil && w.External == nil && w.Errors != nil && len(*w.Errors) > 0
		if !success && !failure {
			t.Fatalf("set-files.json: case %s: want holds documents and external, or a non-empty errors list", *c.ID)
		}
		if failure {
			for j, e := range *w.Errors {
				if e.Rule == nil || e.Path == nil {
					t.Fatalf("set-files.json: case %s: errors[%d] needs rule and path", *c.ID, j)
				}
			}
		}
	}
	return *v.Cases
}

// setTree reads a case tree in written order, since a hard link names an earlier file.
func setTree(raw []byte) ([]setTreePath, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return nil, fmt.Errorf("tree is not an object")
	}
	var out []setTreePath
	seen := map[string]bool{}
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return nil, err
		}
		name := token.(string)
		if seen[name] {
			return nil, fmt.Errorf("tree path %s appears twice", name)
		}
		seen[name] = true
		var value json.RawMessage
		if err := d.Decode(&value); err != nil {
			return nil, err
		}
		var entry setTreeEntry
		if err := decodeStrict(value, &entry); err != nil {
			return nil, fmt.Errorf("tree path %s: %w", name, err)
		}
		count := 0
		for _, present := range []bool{entry.File != nil, entry.Hex != nil, entry.Symlink != nil, entry.Hardlink != nil} {
			if present {
				count++
			}
		}
		if count != 1 {
			return nil, fmt.Errorf("tree path %s holds %d of file, hex, symlink and hardlink, want one", name, count)
		}
		out = append(out, setTreePath{path: name, entry: entry})
	}
	return out, nil
}

// buildSetTree creates the tree under root with real symbolic and hard links and
// returns the bytes of each regular file by its tree path. A file reached through
// a symbolic link to a directory is also listed under the link's tree path.
func buildSetTree(root string, tree []setTreePath) (map[string][]byte, error) {
	contents := map[string][]byte{}
	links := map[string]string{}
	for _, p := range tree {
		full := root + "/" + p.path
		if err := os.MkdirAll(filepath.Dir(filepath.FromSlash(full)), 0o755); err != nil {
			return nil, err
		}
		e := p.entry
		switch {
		case e.File != nil:
			contents[p.path] = []byte(*e.File)
			if err := os.WriteFile(full, contents[p.path], 0o644); err != nil {
				return nil, err
			}
		case e.Hex != nil:
			b, err := hex.DecodeString(*e.Hex)
			if err != nil {
				return nil, fmt.Errorf("tree path %s: %w", p.path, err)
			}
			contents[p.path] = b
			if err := os.WriteFile(full, b, 0o644); err != nil {
				return nil, err
			}
		case e.Symlink != nil:
			links[p.path] = path.Clean(path.Join(path.Dir(p.path), *e.Symlink))
			if err := os.Symlink(filepath.FromSlash(*e.Symlink), full); err != nil {
				return nil, err
			}
		case e.Hardlink != nil:
			b, ok := contents[*e.Hardlink]
			if !ok {
				return nil, fmt.Errorf("tree path %s: hard link to %s, which is not an earlier file", p.path, *e.Hardlink)
			}
			if err := os.Link(root+"/"+*e.Hardlink, full); err != nil {
				return nil, err
			}
			contents[p.path] = b
		}
	}
	files := make(map[string][]byte, len(contents))
	for k, b := range contents {
		files[k] = b
	}
	for link, target := range links {
		for k, b := range contents {
			if strings.HasPrefix(k, target+"/") {
				files[link+k[len(target):]] = b
			}
		}
	}
	return files, nil
}

// TestReadSetVectors runs every case of tests/dbspec/set-files.json through ReadSet.
func TestReadSetVectors(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	cases := readSetVectors(t)
	for _, c := range cases {
		t.Run(*c.ID, func(t *testing.T) {
			tree, err := setTree(*c.Tree)
			if err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			contents, err := buildSetTree(root, tree)
			if err != nil {
				t.Fatalf("build the tree: %v", err)
			}
			set, errors := ReadSet(root + "/" + *c.Set)
			if c.Want.Errors != nil {
				var got, want []string
				for _, e := range errors {
					got = append(got, e.Rule+" "+e.Path)
					if !strings.Contains(e.Message, e.Path) {
						t.Errorf("message %q does not name the path %s", e.Message, e.Path)
					}
				}
				for _, e := range *c.Want.Errors {
					want = append(want, *e.Rule+" "+root+"/"+*e.Path)
				}
				if strings.Join(got, "\n") != strings.Join(want, "\n") {
					t.Fatalf("errors\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
				}
				if set.Documents != nil || set.External != nil {
					t.Fatalf("a failed read returned files %v", set)
				}
				return
			}
			if len(errors) > 0 {
				t.Fatalf("errors %v, want none", errors)
			}
			check := func(list string, got []SetFile, want []string) {
				if len(got) != len(want) {
					t.Fatalf("%s: %d files, want %d", list, len(got), len(want))
				}
				for i, w := range want {
					if got[i].Path != root+"/"+w {
						t.Errorf("%s[%d] path %s, want %s", list, i, got[i].Path, root+"/"+w)
					}
					b, ok := contents[path.Clean(w)]
					if !ok {
						t.Fatalf("%s[%d]: %s is not a file of the tree", list, i, w)
					}
					if !bytes.Equal(got[i].Bytes, b) {
						t.Errorf("%s[%d] bytes %q, want %q", list, i, got[i].Bytes, b)
					}
				}
			}
			check("documents", set.Documents, *c.Want.Documents)
			check("external", set.External, *c.Want.External)
		})
	}
}

// TestSetJSONChecks covers the token checks of step 2 that the vectors reach
// only once: escaped pairs, escaped duplicate keys and nested objects.
func TestSetJSONChecks(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, c := range []struct {
		json, rule string
	}{
		{`{"schema": 1, "documents": ["😀.dbs"]}`, ""},
		{`{"schema": 1, "documents": ["\\ud800.dbs"]}`, ""},
		{`{"schema": 1, "documents": ["\udc00.dbs"]}`, RuleSetJSON},
		{`{"schema": 1, "documents": ["\ud800A.dbs"]}`, RuleSetJSON},
		{`{"\ud800": 1}`, RuleSetJSON},
		{`{"schema": 1, "schema": 1, "documents": ["a.dbs"]}`, RuleSetKey},
		{`{"schema": 1, "documents": ["a.dbs"], "x": {"a": 1, "a": 2}}`, RuleSetKey},
		{`{"schema": 1, "documents": ["a.dbs"], "x": [{"a": 1}, {"a": 2}]}`, RuleSetKey},
		{`{"schema": 1, "schema": 1, "documents": ["a.dbs"]`, RuleSetJSON},
		{`{"schema": 1.0000000000000000001, "documents": ["a.dbs"]}`, ""},
		{`{"schema": -1, "documents": ["a.dbs"]}`, RuleSetSchema},
		{`{"schema": 1, "documents": ["a.dbs"]}` + " \n", ""},
		{`{} {}`, RuleSetJSON},
		{``, RuleSetJSON},
	} {
		_, _, failure := parseSetJSON("dbspec-set.json", []byte(c.json))
		got := ""
		if failure != nil {
			got = failure.Rule
		}
		if c.json == `{"schema": 1, "documents": ["a.dbs"], "x": [{"a": 1}, {"a": 2}]}` {
			// Keys repeat only within one object; two objects of an array are apart.
			if got != RuleSetKey || !strings.Contains(failure.Message, "unknown keys") {
				t.Errorf("%s: %v, want the unknown key x", c.json, failure)
			}
			continue
		}
		if got != c.rule {
			t.Errorf("%s: rule %q (%v), want %q", c.json, got, failure, c.rule)
		}
	}
}

// TestSetRoot covers the prefix and the root of step 1.
func TestSetRoot(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, c := range []struct{ path, prefix, root string }{
		{"dbspec-set.json", "", "."},
		{"/dbspec-set.json", "/", "/"},
		{"a/dbspec-set.json", "a/", "a"},
		{"a//dbspec-set.json", "a//", "a"},
		{"/x/a/dbspec-set.json", "/x/a/", "/x/a"},
	} {
		prefix, last := splitSetPath(c.path)
		if prefix != c.prefix || last != SetFileName || setRoot(prefix) != c.root {
			t.Errorf("%s: prefix %q last %q root %q, want %q and %q", c.path, prefix, last, setRoot(prefix), c.prefix, c.root)
		}
	}
}
