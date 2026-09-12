package main

import "testing"

func TestProhibitedSymbolsUseLanguageNameForms(t *testing.T) {
	for _, symbols := range []Symbols{
		{"Query.MultiStatement": "func(bool) Query"},
		{"Query::multi_statement": "public function multi_statement(bool): Query"},
		{"Query.multiStatement": "multiStatement(value: boolean): Query"},
	} {
		if got := checkProhibitedSymbols("test", symbols, []string{"multi_statement"}); len(got) != 1 {
			t.Fatalf("prohibited symbol result = %#v", got)
		}
	}
	if got := checkProhibitedSymbols("test", Symbols{"Query.stream": "func(visitor) StreamResult"}, []string{"multi_statement"}); len(got) != 0 {
		t.Fatalf("unrelated symbol rejected: %#v", got)
	}
}
