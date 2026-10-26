package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

func TestIPHostInputIsValidatedBeforeModelAndPredicateBinding(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	const document = `dbspec 1 ip_host_input

table author {
  id i64 identity
  ip bytes null
  primary key (id)
  settings {
    codec ip ip
  }
}
`
	m, diagnostics := runtimemodel.LoadDocuments([]string{document})
	if len(diagnostics) != 0 {
		t.Fatal(runtimemodel.DiagnosticsError(diagnostics))
	}
	ent := m.Entities["author"]
	assignment := &request{}
	if _, err := assignment.assign(ent, setSpec{column: "ip", value: "10. 0.0.1"}); ErrorCode(err) != CodeCodecEncode || len(assignment.params) != 0 {
		t.Fatalf("invalid IP assignment = err %q, params %v; want early CODEC_ENCODE and no binding", ErrorCode(err), assignment.params)
	}
	assignment = &request{}
	if _, err := assignment.assign(ent, setSpec{column: "ip", value: "10.0.0.1"}); err != nil || len(assignment.params) != 1 || assignment.params[0] != "10.0.0.1" {
		t.Fatalf("valid IP assignment = err %v, params %v; want unchanged input bind", err, assignment.params)
	}
	assignment = &request{}
	if _, err := assignment.assign(ent, setSpec{column: "ip", value: nil}); err != nil || len(assignment.params) != 0 {
		t.Fatalf("SQL NULL assignment = err %v, params %v; want no error and no bind", err, assignment.params)
	}
	assignment = &request{}
	if _, err := assignment.assign(ent, setSpec{column: "ip", value: Null}); err != nil || len(assignment.params) != 0 {
		t.Fatalf("typed SQL NULL assignment = err %v, params %v; want no error and no bind", err, assignment.params)
	}

	schema := &Schema{Hash: m.ManifestHash, Text: m.ManifestText}
	owner := &Core{ent: &Entity{Name: "author", Schema: schema}, statement: &statement{}}
	req := &request{}
	req.pred(&predSpec{column: "ip", op: "eq", value: "10. 0.0.1"}, owner, newFrame(owner, nil))
	if ErrorCode(req.err) != CodeCodecEncode || len(req.params) != 0 {
		t.Fatalf("invalid IP predicate = err %q, params %v; want early CODEC_ENCODE and no binding", ErrorCode(req.err), req.params)
	}

	req = &request{}
	req.pred(&predSpec{column: "ip", op: "eq", value: nil}, owner, newFrame(owner, nil))
	if req.err != nil || len(req.params) != 1 || req.params[0] != nil {
		t.Fatalf("NULL IP predicate = err %v, params %v; want nil error and one NULL bind", req.err, req.params)
	}
	req = &request{}
	req.pred(&predSpec{column: "ip", op: "eq", value: Null}, owner, newFrame(owner, nil))
	if req.err != nil || len(req.params) != 1 {
		t.Fatalf("typed NULL IP predicate = err %v, params %v; want nil error and one bind", req.err, req.params)
	}
}
