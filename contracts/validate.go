package contracts

import (
	"fmt"
	"slices"
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

// outputs maps a common result to the native return type of each language and
// of each extension (an implementation of part of the contract, declared under
// extensions). A native signature can change only together with this table, so
// a recorded symbol snapshot cannot silently change the common API.
var outputs = map[string]map[string]string{
	"Chain":             {"go": "*{Entity}Model", "php": "static", "rust": "Self", "typescript": "this"},
	"Model":             {"go": "(*{Entity}Model,error)", "php": "static", "rust": "orm::Result<Self>", "typescript": "Promise<this>"},
	"Collection<Model>": {"go": "(*orm.Collection[*{Entity}Model],error)", "php": "Polyspec\\Orm\\Collection", "rust": "orm::Result<orm::Collection<Self>>", "typescript": "Promise<Collection<this>>"},
	"GroupRows":         {"go": "(*orm.GroupRows,error)", "php": "Polyspec\\Orm\\GroupRows", "rust": "orm::Result<orm::GroupRows>", "typescript": "Promise<GroupRows>"},
	"Count":             {"go": "(int64,error)", "php": "int", "rust": "orm::Result<i64>", "typescript": "Promise<number>"},
	"Aggregate":         {"go": "(float64,error)", "php": "float", "rust": "orm::Result<f64>", "typescript": "Promise<number>"},
	"Page<Model>":       {"go": "(*orm.Page[*{Entity}Model],error)", "php": "Polyspec\\Orm\\Page", "rust": "orm::Result<orm::Page<Self>>", "typescript": "Promise<Page<this>>"},
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
	"Db":                {"go": "(*DB,error)", "php": "Polyspec\\Orm\\Db", "rust": "Result<Db>", "typescript": "Promise<Db>"},
	"TransactionResult": {"go": "error", "php": "mixed", "rust": "Transaction<'_,F>", "typescript": "Promise<T>"},
	"Utils":             {"go": "*Utils", "php": "Polyspec\\Orm\\Utils", "rust": "Utils<'_>", "typescript": "Utils"},
	"SchemaUtils":       {"go": "*SchemaUtils", "php": "Polyspec\\Orm\\SchemaUtils", "rust": "SchemaUtils<'_>", "typescript": "SchemaUtils"},
	"AesUtils":          {"go": "*AESUtils", "php": "Polyspec\\Orm\\AesUtils", "rust": "AesUtils<'_>", "typescript": "AesUtils"},
	"AesRotationStatus": {"go": "(AESRotationStatus,error)", "php": "Polyspec\\Orm\\AesRotationStatus", "rust": "Result<AesRotationStatus>", "typescript": "Promise<AesRotationStatus>"},
	"RotatedRows":       {"go": "(int,error)", "php": "int", "rust": "Result<u64>", "typescript": "Promise<number>"},
	// dbspec parse returns the document or every diagnostic, never both.
	"DbspecReadResult":          {"go": "(string,[]Diagnostic,error)", "php": "Polyspec\\Orm\\Dbspec\\ReadResult", "rust": "Result<String,ReadError>", "typescript": "DbspecReadResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ReadResult"},
	"DbspecBytesResult":         {"go": "(string,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\ReadResult", "rust": "Result<String,Vec<Diagnostic>>", "typescript": "DbspecReadResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ReadResult"},
	"DbspecParseResult":         {"go": "(*Document,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\ParseResult", "rust": "Result<Document,Vec<Diagnostic>>", "typescript": "DbspecParseResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ParseResult"},
	"DbspecText":                {"go": "string", "php": "string", "rust": "String", "typescript": "string", "php-extension": "string"},
	"DbspecRenderResult":        {"go": "([]string,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\RenderResult", "rust": "Result<Vec<String>,Vec<Diagnostic>>", "typescript": "DbspecRenderResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\RenderResult"},
	"DbspecManifestResult":      {"go": "(*Manifest,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\ManifestResult", "rust": "Result<Manifest,Vec<Diagnostic>>", "typescript": "DbspecManifestResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ManifestResult"},
	"DbspecIntrospectResult":    {"go": "(*Document,[]Unsupported,error)", "php": "Polyspec\\Orm\\Dbspec\\IntrospectResult", "rust": "Result<Introspection,IntrospectError>", "typescript": "Promise<DbspecIntrospection>", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\IntrospectResult"},
	"DbspecExternalDifferences": {"go": "[]string", "php": "array", "rust": "Vec<String>", "typescript": "string[]", "php-extension": "array"},
	"DbspecPlanParseResult":     {"go": "(*Plan,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\PlanParseResult", "rust": "Result<Plan,Vec<Diagnostic>>", "typescript": "DbspecPlanResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\PlanParseResult"},
	"DbspecChainResult":         {"go": "([]*Plan,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\ChainResult", "rust": "Result<Vec<&Plan>,Vec<Diagnostic>>", "typescript": "DbspecChainResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ChainResult"},
	"DbspecDiffResult":          {"go": "([]Change,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\DiffResult", "rust": "Result<Vec<Change>,Vec<Diagnostic>>", "typescript": "DbspecDiffResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\DiffResult"},
	"DbspecComparisonResult":    {"go": "([]Difference,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\ComparisonResult", "rust": "Result<Vec<Difference>,Vec<Diagnostic>>", "typescript": "DbspecComparisonResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ComparisonResult"},
	// installedDifferences는 TypeScript에서 읽기 전용 목록이다.
	"DbspecInstalledDifferences": {"go": "[]string", "php": "array", "rust": "Vec<String>", "typescript": "readonlystring[]", "php-extension": "array"},
	"DbspecAddedSteps":           {"go": "(added[]string,steps[]PlanStep,differences[]string)", "php": "array", "rust": "AddTablesAndColumnsSteps", "typescript": "DbspecAddTablesAndColumnsSteps", "php-extension": "array"},
	"DbspecPlanStepsResult":      {"go": "([]PlanStep,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\PlanStepsResult", "rust": "Result<Vec<PlanStep>,Vec<Diagnostic>>", "typescript": "DbspecPlanStepsResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\PlanStepsResult"},
	"DbspecApplied":              {"go": "error", "php": "void", "rust": "Result<(),ApplyError>", "typescript": "Promise<void>", "php-extension": "void"},
	"DbspecMermaidExport":        {"go": "(string,[]Unsupported)", "php": "Polyspec\\Orm\\Dbspec\\MermaidExportResult", "rust": "(String,Vec<Unsupported>)", "typescript": "DbspecMermaidExport", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\MermaidExportResult"},
	"DbspecMermaidImport":        {"go": "(*Document,[]Unsupported,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\MermaidImportResult", "rust": "Result<(Document,Vec<Unsupported>),Vec<Diagnostic>>", "typescript": "DbspecMermaidImport", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\MermaidImportResult"},
	"AddedTablesAndColumns":      {"go": "([]string,error)", "php": "array", "rust": "Result<Vec<String>>", "typescript": "Promise<string[]>"},
	// 구독 해제는 database를 읽거나 쓰지 않는 동기 호출이다.
	"Unsubscribe": {"go": "(unsubscribefunc())", "php": "Closure", "rust": "Subscription", "typescript": "()=>void"},
}

// inputs maps a common argument list to the native parameters of each
// language. Rust receivers are checked separately.
var inputs = map[string]map[string]string{
	"":                       {"go": "", "php": "", "rust": "", "typescript": ""},
	"Connection":             {"go": "db*orm.DB", "php": "Polyspec\\Orm\\Db$db", "rust": "db:&orm::Db", "typescript": "db:Db"},
	"ConnectorArgument":      {"go": "args...any", "php": "mixed...$args", "rust": "arg:A", "typescript": "arg?:((q:this)=>unknown)|Model"},
	"ChildModel":             {"go": "childorm.Model", "php": "Polyspec\\Orm\\Model$child", "rust": "child:implorm::Model", "typescript": "child:Model"},
	"OffsetCount":            {"go": "offset,countint", "php": "int$offset,int$count", "rust": "offset:u32,count:u32", "typescript": "offset:number,count:number"},
	"DuplicateModel":         {"go": "m*{Entity}Model", "php": "Polyspec\\Orm\\Model$model", "rust": "m:Self", "typescript": "model:this"},
	"PagePerPage":            {"go": "page,perPageint", "php": "int$page,int$perPage", "rust": "page:u32,per_page:u32", "typescript": "page:number,perPage:number"},
	"Rows":                   {"go": "rows[]*{Entity}Model", "php": "array$rows", "rust": "rows:Vec<Self>", "typescript": "rows:readonlythis[]"},
	"Optimistic":             {"go": "optimistic...bool", "php": "bool$optimistic=false", "rust": "optimistic:bool", "typescript": "optimistic=false"},
	"Recursive":              {"go": "recursive...bool", "php": "bool$recursive=false", "rust": "recursive:bool", "typescript": "recursive=false"},
	"ConnectionOptions":      {"go": "dsnstring,cfgConfig", "php": "string$dsn,Polyspec\\Orm\\Config$config", "rust": "dsn:&str,pool_size:u32,mutcfg:Config", "typescript": "dsn:string,options:ConnectOptions={}"},
	"SchemaConnection":       {"go": "dsnstring,s*Schema,cfgConfig", "php": "string$dsn,Polyspec\\Orm\\Schema$schema,Polyspec\\Orm\\Config$config", "rust": "dsn:&str,schema:&Schema,pool_size:u32,cfg:Config", "typescript": "dsn:string,schema:Schema,options:ConnectOptions={}"},
	"TransactionCallback":    {"go": "fnfunc()error,options...TransactionOption", "php": "Closure$fn,string$isolation=\"\",bool$readOnly=false,int$timeoutMs=0,int$retry=3,?array$audit=null", "rust": "f:F", "typescript": "callback:()=>Promise<T>|T,options:TransactionOptions={}"},
	"LockKey":                {"go": "keystring", "php": "string$key", "rust": "key:&str", "typescript": "key:string"},
	"GeneratedSchema":        {"go": "schema*Schema", "php": "Polyspec\\Orm\\Schema$schema", "rust": "schema:&Schema", "typescript": "schema:Schema"},
	"ModelKeyring":           {"go": "mModel,keyringAESKeyring", "php": "Polyspec\\Orm\\Model$model,Polyspec\\Orm\\AesKeyring$keyring", "rust": "m:&M,keyring:&AesKeyring", "typescript": "model:unknown,keyring:AesKeyring"},
	"DbspecFilePath":         {"go": "pathstring", "php": "string$path", "rust": "path:&Path", "typescript": "path:string", "php-extension": "string$path"},
	"DbspecFileBytes":        {"go": "namestring,b[]byte", "php": "string$name,string$bytes", "rust": "name:&str,bytes:Vec<u8>", "typescript": "name:string,bytes:Uint8Array", "php-extension": "string$name,string$bytes"},
	"DbspecSource":           {"go": "textstring,documentsmap[string]string", "php": "string$text,array$documents", "rust": "text:&str,documents:&BTreeMap<String,String>", "typescript": "text:string,documents:Readonly<Record<string,string>>", "php-extension": "string$text,array$documents"},
	"DbspecDocument":         {"go": "document*Document", "php": "Polyspec\\Orm\\Dbspec\\Document$document", "rust": "document:&Document", "typescript": "document:DbspecDocument", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$document"},
	"DbspecRenderSource":     {"go": "documents[]*Document,dialectDialect", "php": "array$documents,string$dialect", "rust": "documents:&[&Document],dialect:Dialect", "typescript": "documents:readonlyDbspecDocument[],dialect:DbspecDialect", "php-extension": "array$documents,string$dialect"},
	"DbspecDocumentSet":      {"go": "documents[]*Document", "php": "array$documents", "rust": "documents:&[&Document]", "typescript": "documents:readonlyDbspecDocument[]", "php-extension": "array$documents"},
	"DbspecIntrospectSource": {"go": "ctxcontext.Context,qQuerier,dialectDialect,namestring", "php": "PDO$connection,string$dialect,string$name", "rust": "connection:&mutQ,dialect:Dialect,name:&str", "typescript": "connection:DbspecMySqlConnection|DbspecPostgresConnection|DbspecSqliteConnection,dialect:DbspecDialect,name:string", "php-extension": "PDO$connection,string$dialect,string$name"},
	"DbspecExternalSource":   {"go": "live*Document,documents[]*Document", "php": "Polyspec\\Orm\\Dbspec\\Document$live,array$documents", "rust": "live:&Document,documents:&[&Document]", "typescript": "live:DbspecDocument,documents:readonlyDbspecDocument[]", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$live,array$documents"},
	"DbspecPlanText":         {"go": "textstring", "php": "string$text", "rust": "text:&str", "typescript": "text:string", "php-extension": "string$text"},
	"DbspecPlan":             {"go": "p*Plan", "php": "Polyspec\\Orm\\Dbspec\\Plan$plan", "rust": "plan:&Plan", "typescript": "plan:DbspecPlan", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Plan$plan"},
	"DbspecPlans":            {"go": "plans[]*Plan", "php": "array$plans", "rust": "plans:&[Plan]", "typescript": "plans:readonlyDbspecPlan[]", "php-extension": "array$plans"},
	"DbspecDiffSource":       {"go": "source*Document,p*Plan", "php": "?Polyspec\\Orm\\Dbspec\\Document$source,Polyspec\\Orm\\Dbspec\\Plan$plan", "rust": "source:Option<&Document>,plan:&Plan", "typescript": "source:DbspecDocument|null,plan:DbspecPlan", "php-extension": "?Polyspec\\Orm\\Dbspec\\Native\\Document$source,Polyspec\\Orm\\Dbspec\\Native\\Plan$plan"},
	"DbspecComparedSchemas":  {"go": "source,target*Document", "php": "Polyspec\\Orm\\Dbspec\\Document$source,Polyspec\\Orm\\Dbspec\\Document$target", "rust": "source:&Document,target:&Document", "typescript": "source:DbspecDocument,target:DbspecDocument", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$source,Polyspec\\Orm\\Dbspec\\Native\\Document$target"},
	"DbspecInstalledSource":  {"go": "live*Document,unsupported[]Unsupported,target*Document", "php": "Polyspec\\Orm\\Dbspec\\Document$live,array$unsupported,Polyspec\\Orm\\Dbspec\\Document$target", "rust": "live:&Document,unsupported:&[Unsupported],target:&Document", "typescript": "live:DbspecDocument,unsupported:readonlyDbspecUnsupported[],target:DbspecDocument", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$live,array$unsupported,Polyspec\\Orm\\Dbspec\\Native\\Document$target"},
	"DbspecAddedSource":      {"go": "live*Document,unsupported[]Unsupported,target*Document,dialectDialect", "php": "Polyspec\\Orm\\Dbspec\\Document$live,array$unsupported,Polyspec\\Orm\\Dbspec\\Document$target,string$dialect", "rust": "live:&Document,unsupported:&[Unsupported],target:&Document,dialect:Dialect", "typescript": "live:DbspecDocument,unsupported:readonlyDbspecUnsupported[],target:DbspecDocument,dialect:DbspecDialect", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$live,array$unsupported,Polyspec\\Orm\\Dbspec\\Native\\Document$target,string$dialect"},
	"DbspecStepsSource":      {"go": "source*Document,p*Plan,dialectDialect", "php": "?Polyspec\\Orm\\Dbspec\\Document$source,Polyspec\\Orm\\Dbspec\\Plan$plan,string$dialect", "rust": "source:Option<&Document>,plan:&Plan,dialect:Dialect", "typescript": "source:DbspecDocument|null,plan:DbspecPlan,dialect:DbspecDialect", "php-extension": "?Polyspec\\Orm\\Dbspec\\Native\\Document$source,Polyspec\\Orm\\Dbspec\\Native\\Plan$plan,string$dialect"},
	// Rust의 apply 인자 목록은 끝에 쉼표를 둔다.
	"DbspecApplySource":      {"go": "ctxcontext.Context,cExecer,dialectDialect,plans[]*Plan,nowfunc()time.Time,eventsfunc(ApplyEvent)error", "php": "PDO$connection,string$dialect,array$plans,Closure$now,?Closure$events", "rust": "connection:&mutC,dialect:Dialect,plans:&[Plan],now:&ApplyClock<'_>,events:&mutApplyEvents<'_>,", "typescript": "connection:Connection,dialect:DbspecDialect,plans:readonlyDbspecPlan[],now:()=>number,events?:DbspecApplyHandler|null", "php-extension": "PDO$connection,string$dialect,array$plans,Closure$now,?Closure$events"},
	"DbspecExportedDocument": {"go": "d*Document", "php": "Polyspec\\Orm\\Dbspec\\Document$document", "rust": "document:&Document", "typescript": "document:DbspecDocument", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$document"},
	"DbspecMermaidSource":    {"go": "text,namestring", "php": "string$text,string$name", "rust": "text:&str,name:&str", "typescript": "text:string,name:string", "php-extension": "string$text,string$name"},
	"StatementSubscriber":    {"go": "fnSubscriber", "php": "Closure$subscriber", "rust": "subscriber:F", "typescript": "subscriber:(event:StatementEvent)=>void"},
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
		if err := validateExtensionRule(d, r, want, args); err != nil {
			return err
		}
	}
	for name, e := range d.Extensions {
		for _, id := range e.Rules {
			if !seen[id] {
				return fmt.Errorf("extension %s implements the unknown rule %s", name, id)
			}
		}
	}
	return nil
}

// validateExtensionRule은 extension(contracts/interfaces.json의 extensions)마다 r의 native adapter를 확인한다:
// extension이 구현한다고 적은 rule만 그 extension의 adapter를 가지며, 그 signature는 extension의 문법(syntax)으로
// 읽어 같은 공통 입력과 결과의 extension 열과 같아야 한다.
func validateExtensionRule(d document, r rule, want, args map[string]string) error {
	for name, e := range d.Extensions {
		n, has := r.Native[name]
		if implements := slices.Contains(e.Rules, r.ID); implements != has {
			if has {
				return fmt.Errorf("%s has a %s adapter, but extension %s does not list it in its rules", r.ID, name, name)
			}
			return fmt.Errorf("%s missing %s", r.ID, name)
		}
		if !has {
			continue
		}
		if e.Syntax != "php" {
			return fmt.Errorf("extension %s: unsupported syntax %q", name, e.Syntax)
		}
		sig := compact(n.Signature)
		begin := parameterStart(sig)
		end := matchingParen(sig, begin)
		if begin < 0 || end < begin {
			return fmt.Errorf("%s/%s invalid signature", r.ID, name)
		}
		got, ret := sig[begin+1:end], strings.TrimPrefix(sig[end+1:], ":")
		if wantReturn, ok := want[name]; !ok || ret != wantReturn {
			return fmt.Errorf("%s/%s return %s does not implement %s", r.ID, name, ret, r.Output)
		}
		if wantArgs, ok := args[name]; !ok || got != wantArgs {
			return fmt.Errorf("%s/%s arguments %s do not implement %v", r.ID, name, got, r.Inputs)
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
