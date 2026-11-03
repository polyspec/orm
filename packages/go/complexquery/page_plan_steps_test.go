package complexquery

import (
	"path/filepath"
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/complexmodel"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: DSL-159.
func TestGetPagePlanSteps(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db := openComplexDB(t, "sqlite://"+filepath.Join(t.TempDir(), "plan-steps.sqlite"), orm.Config{})
	if err := db.Utils().Schema().Install(complexmodel.Schema); err != nil {
		t.Fatal(err)
	}
	query := func() *complexmodel.ProductModel {
		return complexmodel.Product().Connect(db).
			Relations(complexmodel.ProductReview().MatchSeqWithProductSeq().AliasReviews()).
			ServiceSeq(7).OrderBySeqDesc()
	}
	steps, err := query().GetPagePlanSteps(2, 20)
	if err != nil {
		t.Fatal(err)
	}
	var roles []string
	for _, step := range steps {
		roles = append(roles, step.Role)
	}
	if !slices.Equal(roles, []string{"main", "count", "relation"}) {
		t.Fatalf("roles = %v, want main, count, relation", roles)
	}
	for i, tables := range [][]string{{"product"}, {"product"}, {"product_review"}} {
		if !slices.Equal(steps[i].Tables, tables) {
			t.Errorf("step %d tables = %v, want %v", i, steps[i].Tables, tables)
		}
	}
	// The steps are the statements that getsPage sends.
	recorder := testcase.NewEventRecorder[orm.StatementEvent]()
	unsubscribe, err := db.Subscribe(recorder.Record)
	if err != nil {
		t.Fatal(err)
	}
	_, err = query().GetsPage(2, 20)
	unsubscribe()
	if err != nil {
		t.Fatal(err)
	}
	events := recorder.Events()
	if len(events) != 2 || events[0].SQL != steps[0].SQL || events[1].SQL != steps[1].SQL {
		t.Fatalf("getsPage of no rows sent %v, want the main and count steps %q and %q", events, steps[0].SQL, steps[1].SQL)
	}
	for name, run := range map[string]func() ([]orm.QueryPlanStep, error){
		"page 0":     func() ([]orm.QueryPlanStep, error) { return query().GetPagePlanSteps(0, 20) },
		"perPage 0":  func() ([]orm.QueryPlanStep, error) { return query().GetPagePlanSteps(1, 0) },
		"limit":      func() ([]orm.QueryPlanStep, error) { return query().Limit(0, 1).GetPagePlanSteps(1, 20) },
		"no connect": func() ([]orm.QueryPlanStep, error) { return complexmodel.Product().GetPagePlanSteps(1, 20) },
	} {
		if _, err := run(); orm.ErrorCode(err) != orm.CodeConfig {
			t.Errorf("%s error = %v, want %s", name, err, orm.CodeConfig)
		}
	}
	fulltext := complexmodel.Product().Connect(db).FulltextBooleanNameWithShortDescriptionWithContent("alpha")
	if _, err := fulltext.GetPagePlanSteps(1, 20); orm.ErrorCode(err) != orm.CodeOperatorNotAllowed {
		t.Errorf("SQLite full-text error = %v, want %s", err, orm.CodeOperatorNotAllowed)
	}
}

func openComplexDB(t *testing.T, dsn string, config orm.Config) *orm.DB {
	t.Helper()
	db, err := complexmodel.Connect(dsn, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testcase.Close(t, db) })
	return db
}
