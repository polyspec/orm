package decimalmodel_test

import (
	"errors"
	"os"
	"testing"

	"github.com/polyspec/orm/clients/go/decimalmodel"
	"github.com/polyspec/orm/clients/go/orm"
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"
)

func decimalPhysical(t *testing.T, env string) {
	t.Helper()
	dsn := os.Getenv(env)
	if dsn == "" {
		t.Fatalf("%s is required", env)
	}
	db, err := decimalmodel.Connect(dsn, "../../../contracts/fixtures/decimal_schema.json", orm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rollback := errors.New("decimal fixture rollback")
	err = db.Transaction(func() error {
		amount, large := "48.0450", "9007199254740993"
		row, err := decimalmodel.DecimalCase().SetSeq(1).SetAmount(amount)
		if err != nil {
			return err
		}
		row, err = row.SetLargeValue(&large)
		if err != nil {
			return err
		}
		if _, err = row.Create(); err != nil {
			return err
		}
		loaded, err := decimalmodel.DecimalCase().Seq(1).Get()
		if err != nil {
			return err
		}
		if loaded.GetAmount() != amount || loaded.GetLargeValue() == nil || *loaded.GetLargeValue() != large {
			t.Errorf("decimal fields lost precision: amount=%q large=%v", loaded.GetAmount(), loaded.GetLargeValue())
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatalf("transaction did not roll back: %v", err)
	}
	count, err := decimalmodel.DecimalCase().Connect(db).Seq(1).GetCount()
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("decimal fixture row remains after rollback: %d", count)
	}
}

func TestDecimalPhysicalMySQL(t *testing.T)    { decimalPhysical(t, "DECIMAL_MYSQL_DSN") }
func TestDecimalPhysicalPostgres(t *testing.T) { decimalPhysical(t, "DECIMAL_POSTGRES_DSN") }
func TestDecimalPhysicalSQLite(t *testing.T)   { decimalPhysical(t, "DECIMAL_SQLITE_DSN") }
