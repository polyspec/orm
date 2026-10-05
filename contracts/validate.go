package contracts

import (
	"fmt"
	"strings"
	"unicode"
)

func compact(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}

var languages = []string{"go", "php", "rust", "typescript"}

// outputs maps a common result to the native return type of each language.
// A native signature can change only together with this table, so a recorded
// symbol snapshot cannot silently change the common API.
var outputs = map[string]map[string]string{
	"Chain":             {"go": "*{Entity}Model", "php": "static", "rust": "Self", "typescript": "this"},
	"Model":             {"go": "(*{Entity}Model,error)", "php": "static", "rust": "orm::Result<Self>", "typescript": "Promise<this>"},
	"Collection<Model>": {"go": "(*orm.Collection[*{Entity}Model],error)", "php": "Orm\\Collection", "rust": "orm::Result<orm::Collection<Self>>", "typescript": "Promise<Collection<this>>"},
	"GroupRows":         {"go": "(*orm.GroupRows,error)", "php": "Orm\\GroupRows", "rust": "orm::Result<orm::GroupRows>", "typescript": "Promise<GroupRows>"},
	"Count":             {"go": "(int64,error)", "php": "int", "rust": "orm::Result<i64>", "typescript": "Promise<number>"},
	"Aggregate":         {"go": "(float64,error)", "php": "float", "rust": "orm::Result<f64>", "typescript": "Promise<number>"},
	"Page<Model>":       {"go": "(*orm.Page[*{Entity}Model],error)", "php": "Orm\\Page", "rust": "orm::Result<orm::Page<Self>>", "typescript": "Promise<Page<this>>"},
	"Statement":         {"go": "(*orm.Statement,error)", "php": "array", "rust": "orm::Result<orm::Statement>", "typescript": "Promise<{sql:string;binds:unknown[];}>"},
	"WrittenModel":      {"go": "(*{Entity}Model,error)", "php": "static", "rust": "orm::Result<Self>", "typescript": "Promise<this>"},
	// Rust updates the borrowed model in place instead of returning it.
	"UpdatedModel": {"go": "(*{Entity}Model,error)", "php": "static", "rust": "orm::Result<()>", "typescript": "Promise<this>"},
	"InsertedRows": {"go": "(int64,error)", "php": "int", "rust": "orm::Result<u64>", "typescript": "Promise<number>"},
	"ModelSuccess": {"go": "error", "php": "void", "rust": "orm::Result<()>", "typescript": "Promise<void>"},
	"Success":      {"go": "error", "php": "void", "rust": "Result<()>", "typescript": "Promise<void>"},
	// 등록은 database를 읽거나 쓰지 않으므로 Rust와 TypeScript에서도 동기 호출이다.
	"Registered":        {"go": "error", "php": "void", "rust": "Result<()>", "typescript": "void"},
	"RowMap":            {"go": "map[string]any", "php": "array", "rust": "orm::Result<orm::serde_json::Value>", "typescript": "Record<string,unknown>"},
	"Db":                {"go": "(*DB,error)", "php": "Orm\\Db", "rust": "Result<Db>", "typescript": "Promise<Db>"},
	"TransactionResult": {"go": "error", "php": "mixed", "rust": "Transaction<'_,F>", "typescript": "Promise<T>"},
	"Utils":             {"go": "*Utils", "php": "Orm\\Utils", "rust": "Utils<'_>", "typescript": "Utils"},
	"SchemaUtils":       {"go": "*SchemaUtils", "php": "Orm\\SchemaUtils", "rust": "SchemaUtils<'_>", "typescript": "SchemaUtils"},
	"AesUtils":          {"go": "*AESUtils", "php": "Orm\\AesUtils", "rust": "AesUtils<'_>", "typescript": "AesUtils"},
	"AesRotationStatus": {"go": "(AESRotationStatus,error)", "php": "Orm\\AesRotationStatus", "rust": "Result<AesRotationStatus>", "typescript": "Promise<AesRotationStatus>"},
	"RotatedRows":       {"go": "(int,error)", "php": "int", "rust": "Result<u64>", "typescript": "Promise<number>"},
	// dbspec parse returns the document or every diagnostic, never both.
	"DbspecReadResult":      {"go": "(string,[]Diagnostic,error)", "php": "Orm\\Dbspec\\ReadResult", "rust": "Result<String,ReadError>", "typescript": "DbspecReadResult"},
	"DbspecBytesResult":     {"go": "(string,[]Diagnostic)", "php": "Orm\\Dbspec\\ReadResult", "rust": "Result<String,Vec<Diagnostic>>", "typescript": "DbspecReadResult"},
	"DbspecParseResult":     {"go": "(*Document,[]Diagnostic)", "php": "Orm\\Dbspec\\ParseResult", "rust": "Result<Document,Vec<Diagnostic>>", "typescript": "DbspecParseResult"},
	"DbspecText":            {"go": "string", "php": "string", "rust": "String", "typescript": "string"},
	"DbspecRenderResult":    {"go": "([]string,[]Diagnostic)", "php": "Orm\\Dbspec\\RenderResult", "rust": "Result<Vec<String>,Vec<Diagnostic>>", "typescript": "DbspecRenderResult"},
	"DbspecManifestResult":  {"go": "(*Manifest,[]Diagnostic)", "php": "Orm\\Dbspec\\ManifestResult", "rust": "Result<Manifest,Vec<Diagnostic>>", "typescript": "DbspecManifestResult"},
	"AddedTablesAndColumns": {"go": "([]string,error)", "php": "array", "rust": "Result<Vec<String>>", "typescript": "Promise<string[]>"},
	// 구독 해제는 database를 읽거나 쓰지 않는 동기 호출이다.
	"Unsubscribe": {"go": "(unsubscribefunc())", "php": "Closure", "rust": "Subscription", "typescript": "()=>void"},
}

// inputs maps a common argument list to the native parameters of each
// language. Rust receivers are checked separately.
var inputs = map[string]map[string]string{
	"":                    {"go": "", "php": "", "rust": "", "typescript": ""},
	"Connection":          {"go": "db*orm.DB", "php": "Orm\\Db$db", "rust": "db:&orm::Db", "typescript": "db:Db"},
	"ConnectorArgument":   {"go": "args...any", "php": "mixed...$args", "rust": "arg:A", "typescript": "arg?:((q:this)=>unknown)|Model"},
	"ChildModel":          {"go": "childorm.Model", "php": "Orm\\Model$child", "rust": "child:implorm::Model", "typescript": "child:Model"},
	"OffsetCount":         {"go": "offset,countint", "php": "int$offset,int$count", "rust": "offset:u32,count:u32", "typescript": "offset:number,count:number"},
	"DuplicateModel":      {"go": "m*{Entity}Model", "php": "Orm\\Model$model", "rust": "m:Self", "typescript": "model:this"},
	"PagePerPage":         {"go": "page,perPageint", "php": "int$page,int$perPage", "rust": "page:u32,per_page:u32", "typescript": "page:number,perPage:number"},
	"Rows":                {"go": "rows[]*{Entity}Model", "php": "array$rows", "rust": "rows:Vec<Self>", "typescript": "rows:readonlythis[]"},
	"Optimistic":          {"go": "optimistic...bool", "php": "bool$optimistic=false", "rust": "optimistic:bool", "typescript": "optimistic=false"},
	"Recursive":           {"go": "recursive...bool", "php": "bool$recursive=false", "rust": "recursive:bool", "typescript": "recursive=false"},
	"ConnectionOptions":   {"go": "dsnstring,cfgConfig", "php": "string$dsn,Orm\\Config$config", "rust": "dsn:&str,pool_size:u32,mutcfg:Config", "typescript": "dsn:string,options:ConnectOptions={}"},
	"SchemaConnection":    {"go": "dsnstring,s*Schema,cfgConfig", "php": "string$dsn,Orm\\Schema$schema,Orm\\Config$config", "rust": "dsn:&str,schema:&Schema,pool_size:u32,cfg:Config", "typescript": "dsn:string,schema:Schema,options:ConnectOptions={}"},
	"TransactionCallback": {"go": "fnfunc()error,options...TransactionOption", "php": "Closure$fn,string$isolation=\"\",bool$readOnly=false,int$timeoutMs=0,int$retry=3,?array$audit=null", "rust": "f:F", "typescript": "callback:()=>Promise<T>|T,options:TransactionOptions={}"},
	"LockKey":             {"go": "keystring", "php": "string$key", "rust": "key:&str", "typescript": "key:string"},
	"GeneratedSchema":     {"go": "schema*Schema", "php": "Orm\\Schema$schema", "rust": "schema:&Schema", "typescript": "schema:Schema"},
	"ModelKeyring":        {"go": "mModel,keyringAESKeyring", "php": "Orm\\Model$model,Orm\\AesKeyring$keyring", "rust": "m:&M,keyring:&AesKeyring", "typescript": "model:unknown,keyring:AesKeyring"},
	"DbspecFilePath":      {"go": "pathstring", "php": "string$path", "rust": "path:&Path", "typescript": "path:string"},
	"DbspecFileBytes":     {"go": "namestring,b[]byte", "php": "string$name,string$bytes", "rust": "name:&str,bytes:Vec<u8>", "typescript": "name:string,bytes:Uint8Array"},
	"DbspecSource":        {"go": "textstring,documentsmap[string]string", "php": "string$text,array$documents", "rust": "text:&str,documents:&BTreeMap<String,String>", "typescript": "text:string,documents:Readonly<Record<string,string>>"},
	"DbspecDocument":      {"go": "document*Document", "php": "Orm\\Dbspec\\Document$document", "rust": "document:&Document", "typescript": "document:DbspecDocument"},
	"DbspecRenderSource":  {"go": "documents[]*Document,dialectDialect", "php": "array$documents,string$dialect", "rust": "documents:&[&Document],dialect:Dialect", "typescript": "documents:readonlyDbspecDocument[],dialect:DbspecDialect"},
	"DbspecDocumentSet":   {"go": "documents[]*Document", "php": "array$documents", "rust": "documents:&[&Document]", "typescript": "documents:readonlyDbspecDocument[]"},
	"StatementSubscriber": {"go": "fnSubscriber", "php": "Closure$subscriber", "rust": "subscriber:F", "typescript": "subscriber:(event:StatementEvent)=>void"},
}

// validateRules checks every native adapter against the common inputs and
// outputs. Updating a native signature and its snapshot together must not
// change the common API.
func validateRules(d document) error {
	seen := map[string]bool{}
	for _, r := range d.Rules {
		if seen[r.ID] {
			return fmt.Errorf("duplicate rule %s", r.ID)
		}
		seen[r.ID] = true
		if r.For != "entity" && r.For != "once" {
			return fmt.Errorf("%s: unsupported expansion %s", r.ID, r.For)
		}
		if r.ID == "Model.getsCount" && r.Output != "GroupRows" {
			return fmt.Errorf("%s must return GroupRows", r.ID)
		}
		want, ok := outputs[r.Output]
		if !ok {
			return fmt.Errorf("%s unknown output %s", r.ID, r.Output)
		}
		args, ok := inputs[strings.Join(r.Inputs, ",")]
		if !ok {
			return fmt.Errorf("%s unrecognized input contract %v", r.ID, r.Inputs)
		}
		for _, lang := range languages {
			n, ok := r.Native[lang]
			if !ok {
				return fmt.Errorf("%s missing %s", r.ID, lang)
			}
			sig := compact(n.Signature)
			begin := parameterStart(sig)
			end := matchingParen(sig, begin)
			if begin < 0 || end < begin {
				return fmt.Errorf("%s/%s invalid signature", r.ID, lang)
			}
			got, ret := sig[begin+1:end], sig[end+1:]
			switch lang {
			case "php", "typescript":
				ret = strings.TrimPrefix(ret, ":")
			case "rust":
				ret = strings.TrimPrefix(ret, "->")
				receiver, rest, _ := strings.Cut(got, ",")
				if strings.HasSuffix(receiver, "self") {
					got = rest
					if wantReceiver := receiverOf(r); receiver != wantReceiver {
						return fmt.Errorf("%s Rust receiver %s, want %s", r.ID, receiver, wantReceiver)
					}
				}
				// 오류가 있는 operation은 database에서 실행되므로 async다. transaction은 Transaction
				// builder를, 등록은 database 없이 동기 결과를 돌려준다.
				if len(r.Errors) > 0 && r.Output != "TransactionResult" && r.Output != "Registered" && !strings.Contains(sig, "asyncfn") {
					return fmt.Errorf("%s Rust execution must be async", r.ID)
				}
			}
			if ret != want[lang] {
				return fmt.Errorf("%s/%s return %s does not implement %s", r.ID, lang, ret, r.Output)
			}
			if got != args[lang] {
				return fmt.Errorf("%s/%s arguments %s do not implement %v", r.ID, lang, got, r.Inputs)
			}
		}
	}
	return nil
}

// receiverOf is the Rust receiver of a model method: chain methods take the
// model by value, writes that store the result borrow it mutably, and every
// other execution borrows it.
func receiverOf(r rule) string {
	switch {
	case r.For != "entity" || len(r.Errors) == 0 && r.Output != "Chain":
		return "&self"
	case r.Output == "Chain":
		return "mutself"
	case r.Output == "WrittenModel" || r.Output == "UpdatedModel":
		return "&mutself"
	}
	return "&self"
}

// parameterStart finds the parameter list after an optional generic list.
func parameterStart(sig string) int {
	depth := 0
	for i, r := range sig {
		switch r {
		case '<':
			depth++
		case '>':
			if i > 0 && sig[i-1] == '-' || i > 0 && sig[i-1] == '=' {
				continue
			}
			depth--
		case '(':
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

func matchingParen(value string, open int) int {
	if open < 0 || open >= len(value) || value[open] != '(' {
		return -1
	}
	depth := 0
	for i := open; i < len(value); i++ {
		switch value[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}
