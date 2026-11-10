package recipe

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
)

// setTreeEntry is one path of the tree of dbspec.read_set: exactly one field is present.
type setTreeEntry struct {
	File     *string `json:"file"`
	Hex      *string `json:"hex"`
	Symlink  *string `json:"symlink"`
	Hardlink *string `json:"hardlink"`
}

// writeSetTree writes the tree under root with real links: the files first, then the hard links and the symbolic links,
// so that each link finds what it names and the order of the object does not matter.
func writeSetTree(root string, tree map[string]setTreeEntry) error {
	names := make([]string, 0, len(tree))
	for name := range tree {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, stage := range []func(full string, entry setTreeEntry) error{
		func(full string, entry setTreeEntry) error {
			switch {
			case entry.File != nil:
				return os.WriteFile(full, []byte(*entry.File), 0o644)
			case entry.Hex != nil:
				content, err := hex.DecodeString(*entry.Hex)
				if err != nil {
					return err
				}
				return os.WriteFile(full, content, 0o644)
			}
			return nil
		},
		func(full string, entry setTreeEntry) error {
			if entry.Hardlink != nil {
				return os.Link(root+"/"+*entry.Hardlink, full)
			}
			return nil
		},
		func(full string, entry setTreeEntry) error {
			if entry.Symlink != nil {
				return os.Symlink(filepath.FromSlash(*entry.Symlink), full)
			}
			return nil
		},
	} {
		for _, name := range names {
			full := root + "/" + name
			if err := os.MkdirAll(filepath.Dir(filepath.FromSlash(full)), 0o755); err != nil {
				return err
			}
			if err := stage(full, tree[name]); err != nil {
				return fmt.Errorf("tree path %s: %w", name, err)
			}
		}
	}
	return nil
}

// checkReadSet runs one dbspec.read_set step: it writes the tree under an empty temporary directory, reads the set with the
// public ReadSet, and compares the paths and the bytes of the files or the rule and path of each error (FCV-4, DBS-11).
func checkReadSet(s step, database string) (err error) {
	raw, ok := s.k("expect").Expect[database]
	if !ok {
		return fmt.Errorf("dbspec.read_set has no expect for %s", database)
	}
	var want struct {
		Documents []string `json:"documents"`
		External  []string `json:"external"`
		Errors    []struct {
			Rule         string       `json:"rule"`
			Path         string       `json:"path"`
			MessageHolds messageHolds `json:"message_holds"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		return err
	}
	root, err := os.MkdirTemp("", "orm-set-")
	if err != nil {
		return err
	}
	defer removeTemp(root, &err)
	if err := writeSetTree(root, s.k("tree").SetTree); err != nil {
		return err
	}
	set, failures := dbspec.ReadSet(root + "/" + s.k("set_file").SetFile)
	if len(want.Errors) > 0 {
		if set.Documents != nil || set.External != nil {
			return fmt.Errorf("a failed read returned files %v", set)
		}
		if len(failures) != len(want.Errors) {
			return fmt.Errorf("errors %v, want %d", failures, len(want.Errors))
		}
		for i, wanted := range want.Errors {
			got := failures[i]
			if got.Rule != wanted.Rule || got.Path != root+"/"+wanted.Path {
				return fmt.Errorf("error %d: %s %s, want %s %s", i, got.Rule, got.Path, wanted.Rule, root+"/"+wanted.Path)
			}
			if !strings.Contains(got.Message, got.Path) {
				return fmt.Errorf("the message %q does not name the path %s", got.Message, got.Path)
			}
			if err := wanted.MessageHolds.check(got.Message); err != nil {
				return err
			}
		}
		return nil
	}
	if len(failures) > 0 {
		return fmt.Errorf("errors %v, want none", failures)
	}
	for _, list := range []struct {
		name string
		got  []dbspec.SetFile
		want []string
	}{{"documents", set.Documents, want.Documents}, {"external", set.External, want.External}} {
		if len(list.got) != len(list.want) {
			return fmt.Errorf("%s: %d files, want %d", list.name, len(list.got), len(list.want))
		}
		for i, path := range list.want {
			if list.got[i].Path != root+"/"+path {
				return fmt.Errorf("%s[%d] path %s, want %s", list.name, i, list.got[i].Path, root+"/"+path)
			}
			content, err := os.ReadFile(root + "/" + path)
			if err != nil {
				return err
			}
			if !bytes.Equal(list.got[i].Bytes, content) {
				return fmt.Errorf("%s[%d] bytes %q, want %q", list.name, i, list.got[i].Bytes, content)
			}
		}
	}
	return nil
}
