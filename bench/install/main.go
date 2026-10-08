// install은 schema/bench.dbs에서 생성한 model의 manifest를 bench database에
// 설치한다. 손으로 쓴 DDL은 없고 statement는 dbspec renderer가 만든다.
//
//	go run ./bench/install -dsn 'postgres://orm@127.0.0.1:5432/orm_bench?sslmode=disable&timezone=%2B00:00'
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/polyspec/orm/packages/orm-go/model"
	"github.com/polyspec/orm/packages/orm-go/orm"
	_ "github.com/polyspec/orm/packages/orm-go/orm/pg"
	_ "github.com/polyspec/orm/packages/orm-go/orm/sqlite"
)

// main은 run의 종료 코드로 끝난다. os.Exit는 defer를 실행하지 않으므로 run 안에서는 부르지 않는다: 실패한
// fail은 exit panic으로 run까지 올라오고, 그 사이의 defer(연결 닫기)가 실행된다.
func main() {
	os.Exit(run())
}

// exit는 fail이 run을 끝내는 panic이고, 값은 종료 코드다.
type exit int

func run() (code int) {
	defer func() {
		if recovered := recover(); recovered != nil {
			value, ok := recovered.(exit)
			if !ok {
				panic(recovered)
			}
			code = int(value)
		}
	}()
	dsn := flag.String("dsn", "", "bench database DSN URI")
	flag.Parse()
	if *dsn == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: install -dsn <uri>")
		return 2
	}
	db, err := model.Connect(*dsn, orm.Config{})
	if err != nil {
		fail(err)
	}
	defer db.Close()
	if err := db.Utils().Schema().Install(model.Schema); err != nil {
		fail(err)
	}
	return 0
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "install:", err)
	panic(exit(1))
}
