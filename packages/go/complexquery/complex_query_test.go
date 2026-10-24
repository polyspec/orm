package complexquery

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"

	_ "github.com/go-sql-driver/mysql"
	"github.com/polyspec/orm/packages/go/complexmodel"
	"github.com/polyspec/orm/packages/go/internal/testdb"
	"github.com/polyspec/orm/packages/go/orm"
	_ "github.com/polyspec/orm/packages/go/orm/pg"
	_ "github.com/polyspec/orm/packages/go/orm/sqlite"
	"github.com/polyspec/orm/packages/go/testcase"
)

type complexFixture struct {
	Input struct {
		CategorySeqs []int64 `json:"category_seqs"`
		Keyword      string  `json:"keyword"`
		LangID       int32   `json:"lang_id"`
		MemberSeq    int64   `json:"member_seq"`
		Page         int     `json:"page"`
		PerPage      int     `json:"per_page"`
		ServiceSeq   int64   `json:"service_seq"`
	} `json:"input"`
	SeedOrder   []string                    `json:"seed_order"`
	SeedColumns map[string][]string         `json:"seed_columns"`
	Seed        map[string][]map[string]any `json:"seed"`
	Expected    struct {
		RowSeqs              []int64            `json:"row_seqs"`
		TotalCount           int64              `json:"total_count"`
		TotalPages           int64              `json:"total_pages"`
		ProductLangSeqs      map[string]int64   `json:"product_lang_seqs"`
		BrandSeqs            map[string]int64   `json:"brand_seqs"`
		BrandLangSeqs        map[string]int64   `json:"brand_lang_seqs"`
		ReviewSeqs           map[string][]int64 `json:"review_seqs"`
		ReviewUserSeqs       map[string]int64   `json:"review_user_seqs"`
		OrderProductItemSeqs map[string]int64   `json:"order_product_item_seqs"`
	} `json:"expected"`
	ExpectedEvents map[string][]struct {
		Kind   string   `json:"kind"`
		Tables []string `json:"tables"`
	} `json:"expected_events"`
}

func TestComplexQuery(t *testing.T) {
	testcase.Start(t, testcase.Database)
	fixture := readComplexFixture(t)
	for _, driver := range []string{"mysql", "postgres", "sqlite"} {
		t.Run(driver, func(t *testing.T) {
			dsn := testdb.New(t, driver)
			db, err := complexmodel.Connect(dsn, orm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := db.Close(); err != nil {
					t.Error(err)
				}
			})
			if err := db.Utils().Schema().Install(complexmodel.Schema); err != nil {
				t.Fatal(err)
			}
			if driver == "sqlite" {
				assertComplexSearch(t, db, driver, fixture)
				return
			}
			seedComplexFixture(t, driver, dsn, fixture)
			if driver == "mysql" {
				if err := execFixtureSQL(t, driver, dsn, []string{
					"CREATE FULLTEXT INDEX ft_product_search ON product (name, short_description, content)",
					"CREATE FULLTEXT INDEX ft_product_lang_search ON product_lang (name, short_description, content)",
					"CREATE FULLTEXT INDEX ft_product_brand_lang_search ON product_brand_lang (name, description)",
				}); err != nil {
					t.Fatal(err)
				}
			}
			assertComplexSearch(t, db, driver, fixture)
		})
	}
}

func assertComplexSearch(t *testing.T, db *orm.DB, driver string, fixture complexFixture) {
	t.Helper()
	var events []orm.StatementEvent
	unsubscribe, err := db.Subscribe(func(event orm.StatementEvent) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	page, err := Search(db, inputFromFixture(fixture))
	unsubscribe()
	if driver == "sqlite" {
		if orm.ErrorCode(err) != orm.CodeOperatorNotAllowed || len(events) != 0 {
			t.Fatalf("SQLite full-text request = %v with %d events, want OPERATOR_NOT_ALLOWED before statements", err, len(events))
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if page.TotalCount != fixture.Expected.TotalCount || page.TotalPages != fixture.Expected.TotalPages {
		t.Fatalf("page total = %d/%d, want %d/%d", page.TotalCount, page.TotalPages, fixture.Expected.TotalCount, fixture.Expected.TotalPages)
	}
	var got []int64
	for _, product := range page.Items.Slice() {
		got = append(got, mustSeq(t, product.GetSeq))
	}
	if !slices.Equal(got, fixture.Expected.RowSeqs) {
		t.Fatalf("page product sequences = %v, want %v", got, fixture.Expected.RowSeqs)
	}
	for _, product := range page.Items.Slice() {
		productSeq := mustSeq(t, product.GetSeq)
		key := strconv.FormatInt(productSeq, 10)
		if want, ok := fixture.Expected.ProductLangSeqs[key]; ok {
			localized, err := product.GetProductLangModel()
			if err != nil || localized == nil || mustSeq(t, localized.GetSeq) != want {
				t.Fatalf("product %d language relation does not have sequence %d: %v", productSeq, want, err)
			}
		}
		if want, ok := fixture.Expected.BrandSeqs[key]; ok {
			brand, err := product.GetBrand()
			if err != nil || brand == nil || mustSeq(t, brand.GetSeq) != want {
				t.Fatalf("product %d brand relation does not have sequence %d: %v", productSeq, want, err)
			}
			if langWant, ok := fixture.Expected.BrandLangSeqs[strconv.FormatInt(want, 10)]; ok {
				lang, err := brand.GetProductBrandLangModel()
				if err != nil || lang == nil || mustSeq(t, lang.GetSeq) != langWant {
					t.Fatalf("brand %d language relation does not have sequence %d: %v", want, langWant, err)
				}
			}
		}
		if want, ok := fixture.Expected.ReviewSeqs[key]; ok {
			reviews, err := product.GetReviews()
			if err != nil || reviews == nil {
				t.Fatalf("product %d review relation: %v", productSeq, err)
			}
			var got []int64
			for _, review := range reviews.Slice() {
				reviewSeq := mustSeq(t, review.GetSeq)
				got = append(got, reviewSeq)
				if userWant, ok := fixture.Expected.ReviewUserSeqs[strconv.FormatInt(reviewSeq, 10)]; ok {
					user, err := review.GetUser()
					if err != nil || user == nil || mustSeq(t, user.GetSeq) != userWant {
						t.Fatalf("review %d user relation does not have sequence %d: %v", reviewSeq, userWant, err)
					}
				}
			}
			if !slices.Equal(got, want) {
				t.Fatalf("product %d review sequences = %v, want %v", productSeq, got, want)
			}
		}
		if want, ok := fixture.Expected.OrderProductItemSeqs[key]; ok {
			item, err := product.GetMyOrderItem()
			if err != nil || item == nil || mustSeq(t, item.GetSeq) != want {
				t.Fatalf("product %d order item relation does not have sequence %d: %v", productSeq, want, err)
			}
		}
	}
	wantEvents := fixture.ExpectedEvents[driver]
	if len(events) != len(wantEvents) {
		t.Fatalf("statement events = %d, want %d", len(events), len(wantEvents))
	}
	for i, want := range wantEvents {
		if events[i].Kind != want.Kind || !slices.Equal(events[i].Tables, want.Tables) {
			t.Errorf("statement event %d = %s %v, want %s %v", i, events[i].Kind, events[i].Tables, want.Kind, want.Tables)
		}
	}
}

func mustSeq(t *testing.T, read func() (int64, error)) int64 {
	t.Helper()
	seq, err := read()
	if err != nil {
		t.Fatal(err)
	}
	return seq
}

func readComplexFixture(t *testing.T) complexFixture {
	t.Helper()
	path := filepath.Join("..", "..", "..", "contracts", "fixtures", "complex_query", "complex_query.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture complexFixture
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func inputFromFixture(f complexFixture) Input {
	return Input{CategorySeqs: f.Input.CategorySeqs, Keyword: f.Input.Keyword, LangID: f.Input.LangID, MemberSeq: f.Input.MemberSeq,
		Page: f.Input.Page, PerPage: f.Input.PerPage, ServiceSeq: f.Input.ServiceSeq}
}

func seedComplexFixture(t *testing.T, driver, dsn string, fixture complexFixture) {
	t.Helper()
	db := testdb.Open(t, driver, dsn)
	defer db.Close()
	for _, table := range fixture.SeedOrder {
		columns := fixture.SeedColumns[table]
		for _, row := range fixture.Seed[table] {
			values := make([]any, len(columns))
			placeholders := make([]string, len(columns))
			for i, column := range columns {
				value, ok := row[column]
				if !ok {
					t.Fatalf("seed %s omits column %s", table, column)
				}
				if number, ok := value.(json.Number); ok {
					if integer, err := number.Int64(); err == nil {
						value = integer
					} else if decimal, err := number.Float64(); err == nil {
						value = decimal
					}
				}
				values[i] = value
				if driver == "postgres" {
					placeholders[i] = fmt.Sprintf("$%d", i+1)
				} else {
					placeholders[i] = "?"
				}
			}
			query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, joinColumns(columns), joinStrings(placeholders))
			if _, err := db.Exec(query, values...); err != nil {
				t.Fatalf("seed %s: %v", table, err)
			}
		}
	}
}

func joinColumns(values []string) string { return joinStrings(values) }

func joinStrings(values []string) string {
	var out string
	for i, value := range values {
		if i > 0 {
			out += ", "
		}
		out += value
	}
	return out
}

func execFixtureSQL(t *testing.T, driver, dsn string, statements []string) error {
	t.Helper()
	db := testdb.Open(t, driver, dsn)
	defer db.Close()
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}
