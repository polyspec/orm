//go:build markdown

package markdownmodel_test

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/polyspec/orm/packages/go/markdownmodel"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestIRAnswers는 contracts/fixtures/ir_answers.json의 case마다 그 chain을 실행한다: server
// 대신 connect에 {"ok": true}, chain의 request 하나에 case의 answer를 쓰는 listener에
// 연결하고, chain의 결과가 expect와 같은지 본다(docs/protocol.md §5 Read). flowmark는
// 필요 없다.
func TestIRAnswers(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", "ir_answers.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []struct {
			ID     string          `json:"id"`
			Chain  string          `json:"chain"`
			Answer json.RawMessage `json:"answer"`
			Expect any             `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("ir_answers.json: %v", err)
	}
	funcs := conformanceCases()
	for _, c := range doc.Cases {
		t.Run(c.ID, func(t *testing.T) {
			testcase.Start(t, testcase.Compute)
			run := funcs[c.Chain]
			if run == nil {
				t.Fatalf("chain %s is no markdown conformance case", c.Chain)
			}
			dsn := answeringServer(t, string(c.Answer))
			db, err := markdownmodel.Connect(dsn, orm.Config{PoolSize: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			got, err := run(&served{db: db})
			if err != nil {
				code := orm.ErrorCode(err)
				if code == "" {
					t.Fatalf("%s failed without an orm code: %v", c.ID, err)
				}
				got = map[string]any{"error": code}
			}
			actual := normalize(t, got)
			if !reflect.DeepEqual(actual, c.Expect) {
				t.Fatalf("%s: got %s, want %s (error %v)", c.ID, jsonText(actual), jsonText(c.Expect), err)
			}
		})
	}
}

// answeringServer는 한 연결의 connect에 {"ok": true}를, 다음 message에 answer를 쓰는
// listener의 DSN이다.
func answeringServer(t *testing.T, answer string) string {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		for _, line := range []string{`{"ok":true}`, answer} {
			if _, err := r.ReadString('\n'); err != nil {
				return
			}
			if _, err := conn.Write([]byte(line + "\n")); err != nil {
				return
			}
		}
		r.ReadString('\n')
	}()
	return "markdown://" + ln.Addr().String() + "/conformance?token=0123456789abcdef0123456789abcdef"
}
