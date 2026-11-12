//go:build !windows

package dbspec

import (
	"errors"
	"os"
)

// examine examines path without following a symbolic link (lstat).
func examine(path string) (entryKind, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return kindOther, err
	}
	switch mode := info.Mode(); {
	case mode&os.ModeSymlink != 0:
		return kindSymlink, nil
	case mode.IsDir():
		return kindDirectory, nil
	case mode.IsRegular():
		return kindRegular, nil
	}
	return kindOther, nil
}

// nameList is the names that a directory lists, as their bytes.
type nameList map[string]bool

// has reports whether the UTF-8 bytes of name equal a listed name.
func (n nameList) has(name string) bool { return n[name] }

// listNames lists the names of directory as the bytes the platform gives.
func listNames(directory string) (_ nameList, err error) {
	f, err := os.Open(directory)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, f.Close()) }()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	out := make(nameList, len(names))
	for _, name := range names {
		out[name] = true
	}
	return out, nil
}
