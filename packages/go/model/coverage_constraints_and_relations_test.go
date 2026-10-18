//go:build featurecoverage

package model_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageConstraintErrors checks that a foreign key, check, and unique violation against a seed row
// yield FOREIGN_KEY, CONSTRAINT, and DUPLICATE_KEY respectively, and
// that no row changes.
func TestCoverageConstraintErrors(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, _, _ := connectFeature(t)
	user := must(model.User().Connect(db).Seq(1).Get())
	if err := user.Delete(); orm.ErrorCode(err) != orm.CodeForeignKey {
		t.Fatalf("delete of a referenced user = %v, want FOREIGN_KEY", err)
	}
	if got := must(model.User().Connect(db).Seq(1).Get()).GetName(); got != "user-1" {
		t.Fatalf("user 1 name = %q after the rejected delete", got)
	}

	first := must(model.Author().Connect(db).GetBySeq(1))
	second := must(model.Author().Connect(db).GetBySeq(2))
	likes, uuid := first.GetLikeCount(), first.GetUuid()
	if uuid == nil || second.GetUuid() == nil || *uuid == *second.GetUuid() {
		t.Fatalf("seed uuids of author 1 and 2 are not distinct values: %v %v", uuid, second.GetUuid())
	}
	if _, err := must(model.Author().Connect(db).GetBySeq(1)).SetLikeCount(-1).Update(); orm.ErrorCode(err) != orm.CodeConstraint {
		t.Fatalf("negative like_count = %v, want CONSTRAINT", err)
	}
	if _, err := must(model.Author().Connect(db).GetBySeq(1)).SetUuid(second.GetUuid()).Update(); orm.ErrorCode(err) != orm.CodeDuplicateKey {
		t.Fatalf("duplicate uuid = %v, want DUPLICATE_KEY", err)
	}
	after := must(model.Author().Connect(db).GetBySeq(1))
	if after.GetLikeCount() != likes || after.GetUuid() == nil || *after.GetUuid() != *uuid ||
		!after.GetUpdatedTs().Equal(first.GetUpdatedTs()) {
		t.Fatalf("author 1 changed: like_count %d uuid %v updated_ts %v", after.GetLikeCount(), after.GetUuid(), after.GetUpdatedTs())
	}
}
