package dbspec

import (
	"bytes"
	"os"
	"unicode/utf8"
)

// Signature는 모든 dbspec document 파일의 첫 byte다. header `dbspec 1 <document>`가
// 이것으로 시작한다(docs/dbspec.md "Files").
const Signature = "dbspec "

// ReadFile은 parse할 path의 dbspec document 파일을 읽고 그 byte를 path를 이름으로
// ReadBytes로 확인한다. 읽을 수 없는 파일은 읽기의 error를 돌려준다.
func ReadFile(path string) (string, []Diagnostic, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	text, diagnostics := ReadBytes(path, b)
	return text, diagnostics, nil
}

// ReadBytes는 호출자가 자기 규칙으로 읽은 dbspec document 파일의 byte를 parse 전에
// 확인한다. name은 message가 파일을 가리키는 이름이다. Signature로 시작하지 않는 byte는
// text 없이 line 1, column 1의 RuleSignature diagnostic 하나와 message
// "<name> is not a dbspec document"를, UTF-8이 아닌 byte는 첫 잘못된 byte의 줄과 칸에서
// RuleEncoding diagnostic 하나와 message "<name> is not valid UTF-8"을 돌려준다. 그 밖의
// byte는 diagnostic 없이 그대로 text가 된다.
func ReadBytes(name string, b []byte) (string, []Diagnostic) {
	// signature는 decode 전에 byte로 확인한다. 다른 형식의 파일(예: DbSchema project XML)이나
	// 빈 파일은 dbspec header diagnostic이 아니라 파일 하나의 signature diagnostic이다.
	if !bytes.HasPrefix(b, []byte(Signature)) {
		return "", []Diagnostic{{Rule: RuleSignature, Line: 1, Column: 1, Message: name + " is not a dbspec document"}}
	}
	if !utf8.Valid(b) {
		line, column := invalidUTF8Position(b)
		return "", []Diagnostic{{Rule: RuleEncoding, Line: line, Column: column, Message: name + " is not valid UTF-8"}}
	}
	return string(b), nil
}

// invalidUTF8Position은 첫 잘못된 UTF-8 byte의 줄과 칸(code point 단위)이다. 줄은 LF로
// 나눈다.
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
