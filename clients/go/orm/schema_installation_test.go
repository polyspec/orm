package orm

import (
	"context"
	"reflect"
	"testing"
)

func TestTransactionProvidesCanonicalSchemaInstallation(t *testing.T) {
	method, ok := reflect.TypeOf((*Tx)(nil)).MethodByName("InstallSchema")
	if !ok {
		t.Fatal("transaction is missing InstallSchema(context.Context, []byte) error")
	}
	want := reflect.FuncOf(
		[]reflect.Type{reflect.TypeOf((*Tx)(nil)), reflect.TypeOf((*context.Context)(nil)).Elem(), reflect.TypeOf([]byte{})},
		[]reflect.Type{reflect.TypeOf((*error)(nil)).Elem()},
		false,
	)
	if method.Type != want {
		t.Fatalf("InstallSchema signature = %s, want %s", method.Type, want)
	}
}
