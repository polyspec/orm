package model_test

import (
	"reflect"
	"testing"

	"github.com/polyspec/orm/clients/go/model"
)

func TestGeneratedDecimalFieldUsesExactText(t *testing.T) {
	stringPointer := reflect.TypeOf((*string)(nil))
	getter := reflect.TypeOf((*model.AuthorModel).GetPrice)
	setter := reflect.TypeOf((*model.AuthorModel).SetPrice)
	if getter.Out(0) != stringPointer || setter.In(1) != stringPointer {
		t.Fatalf("decimal getter/setter must use *string; got %v and %v", getter, setter)
	}
}
