package dbspec

import (
	"bytes"
	"os"
)

// Signature는 모든 dbspec document 파일의 첫 byte다. header `dbspec 1 <document>`가
// 이것으로 시작한다(docs/dbspec.md "Files").
const Signature = "dbspec "

// ReadFile은 parse할 path의 dbspec document 파일을 읽는다. Signature로 시작하지 않는
// 파일은 text 없이 line 1, column 1의 RuleSignature diagnostic 하나와 message
// "<path> is not a dbspec document"를 돌려주며, 그 파일은 parse하지 않는다. 읽을 수 없는
// 파일은 읽기의 error를 돌려준다.
func ReadFile(path string) (string, []Diagnostic, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	// signature는 parse 전에 byte로 확인한다. 다른 형식의 파일(예: DbSchema project XML)이나
	// 빈 파일은 dbspec header diagnostic이 아니라 파일 하나의 signature diagnostic이다.
	if !bytes.HasPrefix(b, []byte(Signature)) {
		return "", []Diagnostic{{Rule: RuleSignature, Line: 1, Column: 1, Message: path + " is not a dbspec document"}}, nil
	}
	return string(b), nil, nil
}
