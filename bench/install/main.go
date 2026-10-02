// install은 schema/bench.dbs에서 생성한 model의 manifest를 bench database에
// 설치한다. 손으로 쓴 DDL은 없고 statement는 dbspec renderer가 만든다.
//
//	go run ./bench/install -dsn 'postgres://orm@127.0.0.1:5432/orm_bench?sslmode=disable&timezone=%2B00:00'
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
	_ "github.com/polyspec/orm/clients/go/orm/pg"
	_ "github.com/polyspec/orm/clients/go/orm/sqlite"
)

func main() {
	dsn := flag.String("dsn", "", "bench database DSN URI")
	flag.Parse()
	if *dsn == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: install -dsn <uri>")
		os.Exit(2)
	}
	db, err := model.Connect(*dsn, orm.Config{})
	if err != nil {
		fail(err)
	}
	defer db.Close()
	if err := db.Utils().Schema().Install(model.ManifestText); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "install:", err)
	os.Exit(1)
}
