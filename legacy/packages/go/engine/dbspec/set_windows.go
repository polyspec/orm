//go:build windows

package dbspec

import (
	"strings"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// examine examines path without following a reparse point: it opens the entry
// itself (FILE_FLAG_OPEN_REPARSE_POINT) and reads its attributes and reparse
// tag from that handle. A reparse point whose tag is a name surrogate, a
// symbolic link or a junction, is a symbolic link.
func examine(path string) (entryKind, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return kindOther, err
	}
	h, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return kindOther, &pathError{op: "lstat", path: path, err: err}
	}
	defer windows.CloseHandle(h)
	var info fileAttributeTagInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileAttributeTagInfo, (*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return kindOther, &pathError{op: "lstat", path: path, err: err}
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 && info.ReparseTag&0x20000000 != 0 {
		// IsReparseTagNameSurrogate: bit 29 of the tag.
		return kindSymlink, nil
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		return kindDirectory, nil
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DEVICE != 0 {
		return kindOther, nil
	}
	var t uint32
	if t, err = windows.GetFileType(h); err != nil {
		return kindOther, &pathError{op: "lstat", path: path, err: err}
	}
	if t != windows.FILE_TYPE_DISK {
		return kindOther, nil
	}
	return kindRegular, nil
}

// fileAttributeTagInfo is FILE_ATTRIBUTE_TAG_INFO, the FileAttributeTagInfo
// class of GetFileInformationByHandleEx.
type fileAttributeTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

// pathError names the operation and the path of a failed examination.
type pathError struct {
	op, path string
	err      error
}

func (e *pathError) Error() string { return e.op + " " + e.path + ": " + e.err.Error() }
func (e *pathError) Unwrap() error { return e.err }

// nameList is the names that a directory lists, as their UTF-16 code units.
type nameList map[string]bool

// unitsKey writes UTF-16 code units as a map key, two bytes each.
func unitsKey(units []uint16) string {
	var b strings.Builder
	for _, u := range units {
		b.WriteByte(byte(u >> 8))
		b.WriteByte(byte(u))
	}
	return b.String()
}

// has reports whether the UTF-16 code units of name equal a listed name.
func (n nameList) has(name string) bool { return n[unitsKey(utf16.Encode([]rune(name)))] }

// listNames lists the names of directory as the UTF-16 code units that
// FindFirstFile and FindNextFile give, without a conversion that would replace a
// lone surrogate.
func listNames(directory string) (nameList, error) {
	pattern := directory
	if !strings.HasSuffix(pattern, `\`) && !strings.HasSuffix(pattern, "/") && !strings.HasSuffix(pattern, ":") {
		pattern += `\`
	}
	pattern += "*"
	p, err := windows.UTF16PtrFromString(pattern)
	if err != nil {
		return nil, err
	}
	var data windows.Win32finddata
	h, err := windows.FindFirstFile(p, &data)
	if err != nil {
		return nil, &pathError{op: "list", path: directory, err: err}
	}
	defer windows.FindClose(h)
	out := nameList{}
	for {
		units := data.FileName[:]
		for i, u := range units {
			if u == 0 {
				units = units[:i]
				break
			}
		}
		out[unitsKey(units)] = true
		if err := windows.FindNextFile(h, &data); err != nil {
			if err == windows.ERROR_NO_MORE_FILES {
				return out, nil
			}
			return nil, &pathError{op: "list", path: directory, err: err}
		}
	}
}
