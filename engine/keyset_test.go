package engine

import (
	"strings"
	"testing"
)

func TestKeysetCompilesCompositeBoundaryAndReversesBeforeOrder(t *testing.T) {
	e := testEngine(t)
	p := compile(t, e, `"kind":"all","entity":"composite_account",
	 "order":[{"column":"name"}],"keyset":{"direction":"after","values":[0,1,2]},"limit":{"offset":0,"count":2}`)
	sql := p.Steps[0].SQL
	want := "WHERE ((`a`.`name` > ?) OR (`a`.`name` = ? AND `a`.`tenant_id` > ?) OR (`a`.`name` = ? AND `a`.`tenant_id` = ? AND `a`.`account_id` > ?)) ORDER BY `a`.`name` ASC, `a`.`tenant_id` ASC, `a`.`account_id` ASC LIMIT 0, 2"
	if !strings.Contains(sql, want) {
		t.Fatalf("keyset after SQL:\n%s\nwant fragment:\n%s", sql, want)
	}
	if got := len(p.Steps[0].BindSlots); got != 6 {
		t.Fatalf("keyset after bind count = %d, want 6", got)
	}

	p = compile(t, e, `"kind":"all","entity":"composite_account",
	 "order":[{"column":"name","desc":true}],"keyset":{"direction":"before","values":[0,1,2]},"limit":{"offset":0,"count":2}`)
	sql = p.Steps[0].SQL
	if !strings.Contains(sql, "WHERE ((`a`.`name` > ?) OR (`a`.`name` = ? AND `a`.`tenant_id` < ?) OR (`a`.`name` = ? AND `a`.`tenant_id` = ? AND `a`.`account_id` < ?))") {
		t.Fatalf("keyset before boundary: %s", sql)
	}
	if !strings.Contains(sql, "ORDER BY `a`.`name` ASC, `a`.`tenant_id` DESC, `a`.`account_id` DESC") {
		t.Fatalf("keyset before order was not inverted: %s", sql)
	}
}

func TestKeysetRejectsAmbiguousOrderAndCursorShape(t *testing.T) {
	e := testEngine(t)
	for name, body := range map[string]string{
		"expression":  `"kind":"all","entity":"battle","order":[{"expr":"` + "`name`" + `"}],"keyset":{"direction":"after","values":[0]},"limit":{"offset":0,"count":1}`,
		"nullable":    `"kind":"all","entity":"battle","order":[{"column":"description"}],"keyset":{"direction":"after","values":[0]},"limit":{"offset":0,"count":1}`,
		"value-count": `"kind":"all","entity":"composite_account","order":[{"column":"name"}],"keyset":{"direction":"after","values":[0]},"limit":{"offset":0,"count":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := e.Compile([]byte(`{"ir_version":1,"schema_hash":"` + e.M.SchemaHash + `","n_params":8,` + body + `}`)); err == nil {
				t.Fatal("ambiguous keyset accepted")
			}
		})
	}
}
