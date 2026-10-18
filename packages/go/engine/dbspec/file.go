package dbspec

import (
	"bytes"
	"os"
	"unicode/utf8"
)

// Signature is the first bytes of every dbspec document file. The header `dbspec 1 <document>`
// starts with it (docs/dbspec.md "Files").
const Signature = "dbspec "

// ReadFile reads the dbspec document file at path, to parse, and checks its bytes with ReadBytes,
// using path as the name. A file that cannot be read returns the read error.
func ReadFile(path string) (string, []Diagnostic, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	text, diagnostics := ReadBytes(path, b)
	return text, diagnostics, nil
}

// ReadBytes checks the bytes of a dbspec document file that the caller read under its own rules, before parsing.
// name is the name the message uses for the file. Bytes that do not start with Signature give
// one RuleSignature diagnostic at line 1, column 1, with no text, and the message
// "<name> is not a dbspec document"; a byte that is not UTF-8 gives a diagnostic at the line and column of the first invalid byte with
// RuleEncoding and the message "<name> is not valid UTF-8". Other
// bytes become text as they are, with no diagnostic.
func ReadBytes(name string, b []byte) (string, []Diagnostic) {
	// The signature is checked on the bytes before decoding. A file of another format (for example a DbSchema project XML) or
	// an empty file gives one file-level signature diagnostic, not a dbspec header diagnostic.
	if !bytes.HasPrefix(b, []byte(Signature)) {
		return "", []Diagnostic{{Rule: RuleSignature, Line: 1, Column: 1, Message: name + " is not a dbspec document"}}
	}
	if !utf8.Valid(b) {
		line, column := invalidUTF8Position(b)
		return "", []Diagnostic{{Rule: RuleEncoding, Line: line, Column: column, Message: name + " is not valid UTF-8"}}
	}
	return string(b), nil
}

// invalidUTF8Position is the line and column (in code points) of the first invalid UTF-8 byte. Lines are split at LF
// on LF.
func invalidUTF8Position(b []byte) (int, int) {
	line, column := 1, 1
	for i := 0; i < len(b); {
		r, size := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && size == 1 {
			break
		}
		if b[i] == '\n' {
			line, column = line+1, 1
		} else {
			column++
		}
		i += size
	}
	return line, column
}
