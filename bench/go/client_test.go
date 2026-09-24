package bench

import (
	"testing"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

// BenchmarkClientList100 reads the 100-row list of TestHotPathGate through the
// generated client; compare its B/op and allocs/op with BenchmarkList100.
func BenchmarkClientList100(b *testing.B) {
	db, err := model.Connect(dsn(b), "../../schema/schema.json", orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := model.Battle().Connect(db).ServiceSeq(7).AndIsClose(false).OrderBySeqDesc().Limit(0, 100).Gets(); err != nil {
			b.Fatal(err)
		}
	}
}
