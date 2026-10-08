package contracts

import "testing"

// A Python native signature has self as its receiver and "->" before its return type. pythonParts
// reads it as the parameter list and the return type of the other clients: self is no parameter.
func TestPythonSignatureReadsLikeTheOtherClients(t *testing.T) {
	for _, test := range []struct {
		name, got, ret, wantGot, wantRet string
	}{
		{"method with a parameter", "self,db:Db", "->Self", "db:Db", "Self"},
		{"method without a parameter", "self", "->int", "", "int"},
		{"function with a parameter", "dsn:str,options:dict|None=None", "->Db", "dsn:str,options:dict|None=None", "Db"},
		{"function without a parameter", "", "->None", "", "None"},
	} {
		t.Run(test.name, func(t *testing.T) {
			gotParams, gotRet := pythonParts(test.got, test.ret)
			if gotParams != test.wantGot || gotRet != test.wantRet {
				t.Fatalf("pythonParts(%q, %q) = (%q, %q), want (%q, %q)", test.got, test.ret, gotParams, gotRet, test.wantGot, test.wantRet)
			}
		})
	}
}
