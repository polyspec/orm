package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/polyspec/orm/clients/go/orm"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
)

func main() {
	if len(os.Args) != 2 {
		panic("endpoint required")
	}
	compiler, err := orm.NewConnectCompiler(os.Args[1], 5*time.Second)
	if err != nil {
		panic(err)
	}
	metadata, err := compiler.Metadata(context.Background())
	if err != nil {
		panic(err)
	}
	scope, predicate := uint32(0), uint32(1)
	plan, err := compiler.Compile(context.Background(), &compilerv1.CompileRequest{
		IrVersion: 1, SchemaHash: metadata.SchemaHash, Kind: compilerv1.QueryKind_QUERY_KIND_COUNT, ParameterCount: 2,
		Root: &compilerv1.QueryNode{Entity: "battle", ScopeParameter: &scope, Where: &compilerv1.Group{Items: []*compilerv1.Item{{Value: &compilerv1.Item_Predicate{Predicate: &compilerv1.Predicate{Column: "service_seq", Operator: "eq", Parameter: &predicate}}}}}},
	})
	if err != nil {
		panic(err)
	}
	step := plan.Steps[0]
	parameters := make([]uint32, len(step.Binds))
	for i, bind := range step.Binds {
		parameters[i] = bind.Parameter
	}
	outputColumns := 0
	if step.Assemble != nil {
		outputColumns = len(step.Assemble.Columns)
	}
	output := map[string]any{"schema_hash": metadata.SchemaHash, "dialect": metadata.Dialect, "ir_version": metadata.IrVersion, "sql": step.Sql, "bind_parameters": parameters, "output_columns": outputColumns}
	encoded, err := json.Marshal(output)
	if err != nil {
		panic(err)
	}
	fmt.Println(string(encoded))
}
