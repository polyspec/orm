package model_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
)

// TestCPX5DuplicateRelationNameIsRejectedDuringQueryCompilation checks the public model chain without executing SQL.
//
// Requirements: CPX-5, DSL-128.
func TestCPX5DuplicateRelationNameIsRejectedDuringQueryCompilation(t *testing.T) {
	db, err := model.Connect("sqlite://"+filepath.Join(t.TempDir(), "cpx5.db"), orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close DB: %v", err)
		}
	}()

	_, err = model.Author().Connect(db).
		Relation(model.User().MatchUserSeqWithSeq()).
		Relation(model.User().MatchUserSeqWithSeq()).
		GetQuery()
	if err == nil {
		t.Fatal("duplicate relation result name was accepted")
	}
	if got := orm.ErrorCode(err); got != orm.CodeConfig {
		t.Fatalf("duplicate relation error code = %s, want %s: %v", got, orm.CodeConfig, err)
	}
	if !strings.Contains(err.Error(), "user_model") || !strings.Contains(err.Error(), "alias<Name>()") {
		t.Fatalf("duplicate relation error does not name the result and alias call: %v", err)
	}
}
