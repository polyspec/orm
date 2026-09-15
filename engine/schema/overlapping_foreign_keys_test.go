package schema

import "testing"

func TestBuildAllowsColumnParticipationInMultipleForeignKeys(t *testing.T) {
	source := `erDiagram
  account {
    bigint id PK
  }
  session {
    bigint account_id PK, FK
    bigint token_hash PK
  }
  method {
    bigint account_id PK, FK
    bigint id PK
  }
  request {
    bigint account_id PK, FK
    bigint id PK
    bigint session_hash
    bigint method_id "?"
  }
  account ||--o{ session : account_id
  account ||--o{ method : account_id
  session ||--o{ request : "(account_id, session_hash) (session / requests) cascade"
  method ||--o{ request : "(account_id, method_id) (method / requests)"
`
	diagram, err := Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := Build(diagram)
	if err != nil {
		t.Fatal(err)
	}
	request := manifest.Entities["request"]
	if request.Relations["session"] == nil || request.Relations["method"] == nil {
		t.Fatalf("request relations = %#v", request.Relations)
	}
	if got := request.Relations["session"].Keys; len(got) != 2 || got[0].Local != "account_id" || got[1].Local != "session_hash" {
		t.Fatalf("session relation keys = %#v", got)
	}
	if got := request.Relations["method"].Keys; len(got) != 2 || got[0].Local != "account_id" || got[1].Local != "method_id" {
		t.Fatalf("method relation keys = %#v", got)
	}
}
