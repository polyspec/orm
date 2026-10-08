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

var languages = []string{"go", "php", "rust", "typescript", "python"}

// outputs maps a common result to the native return type of each language and
// of each extension (an implementation of part of the contract, declared under
// extensions). A native signature can change only together with this table, so
// a recorded symbol snapshot cannot silently change the common API.
var outputs = map[string]map[string]string{
	"Chain":             {"go": "*{Entity}Model", "php": "static", "rust": "Self", "typescript": "this", "python": "Self"},
	"Model":             {"go": "(*{Entity}Model,error)", "php": "static", "rust": "polyspec_orm::Result<Self>", "typescript": "Promise<this>", "python": "Self"},
	"Collection<Model>": {"go": "(*orm.Collection[*{Entity}Model],error)", "php": "Polyspec\\Orm\\Collection", "rust": "polyspec_orm::Result<polyspec_orm::Collection<Self>>", "typescript": "Promise<Collection<this>>", "python": "Collection[Self]"},
	"GroupRows":         {"go": "(*orm.GroupRows,error)", "php": "Polyspec\\Orm\\GroupRows", "rust": "polyspec_orm::Result<polyspec_orm::GroupRows>", "typescript": "Promise<GroupRows>", "python": "GroupRows"},
	"Count":             {"go": "(int64,error)", "php": "int", "rust": "polyspec_orm::Result<i64>", "typescript": "Promise<number>", "python": "int"},
	"Aggregate":         {"go": "(float64,error)", "php": "float", "rust": "polyspec_orm::Result<f64>", "typescript": "Promise<number>", "python": "float"},
	"Page<Model>":       {"go": "(*orm.Page[*{Entity}Model],error)", "php": "Polyspec\\Orm\\Page", "rust": "polyspec_orm::Result<polyspec_orm::Page<Self>>", "typescript": "Promise<Page<this>>", "python": "Page[Self]"},
	"Statement":         {"go": "(*orm.Statement,error)", "php": "array", "rust": "polyspec_orm::Result<polyspec_orm::Statement>", "typescript": "Promise<{sql:string;binds:unknown[];}>", "python": "dict"},
	"WrittenModel":      {"go": "(*{Entity}Model,error)", "php": "static", "rust": "polyspec_orm::Result<Self>", "typescript": "Promise<this>", "python": "Self"},
	// Rust updates the borrowed model in place instead of returning it.
	"UpdatedModel": {"go": "(*{Entity}Model,error)", "php": "static", "rust": "polyspec_orm::Result<()>", "typescript": "Promise<this>", "python": "Self"},
	"InsertedRows": {"go": "(int64,error)", "php": "int", "rust": "polyspec_orm::Result<u64>", "typescript": "Promise<number>", "python": "int"},
	"ModelSuccess": {"go": "error", "php": "void", "rust": "polyspec_orm::Result<()>", "typescript": "Promise<void>", "python": "None"},
	"Success":      {"go": "error", "php": "void", "rust": "Result<()>", "typescript": "Promise<void>", "python": "None"},
	// 등록은 database를 읽거나 쓰지 않으므로 Rust와 TypeScript에서도 동기 호출이다.
	"Registered":        {"go": "error", "php": "void", "rust": "Result<()>", "typescript": "void", "python": "None"},
	"RowMap":            {"go": "map[string]any", "php": "array", "rust": "polyspec_orm::Result<polyspec_orm::serde_json::Value>", "typescript": "Record<string,unknown>", "python": "dict"},
	"Db":                {"go": "(*DB,error)", "php": "Polyspec\\Orm\\Db", "rust": "Result<Db>", "typescript": "Promise<Db>", "python": "Db"},
	"TransactionResult": {"go": "error", "php": "mixed", "rust": "Transaction<'_,F>", "typescript": "Promise<T>", "python": "T"},
	"Utils":             {"go": "*Utils", "php": "Polyspec\\Orm\\Utils", "rust": "Utils<'_>", "typescript": "Utils", "python": "Utils"},
	"SchemaUtils":       {"go": "*SchemaUtils", "php": "Polyspec\\Orm\\SchemaUtils", "rust": "SchemaUtils<'_>", "typescript": "SchemaUtils", "python": "SchemaUtils"},
	"AesUtils":          {"go": "*AESUtils", "php": "Polyspec\\Orm\\AesUtils", "rust": "AesUtils<'_>", "typescript": "AesUtils", "python": "AesUtils"},
	"AesRotationStatus": {"go": "(AESRotationStatus,error)", "php": "Polyspec\\Orm\\AesRotationStatus", "rust": "Result<AesRotationStatus>", "typescript": "Promise<AesRotationStatus>", "python": "AesRotationStatus"},
	"RotatedRows":       {"go": "(int,error)", "php": "int", "rust": "Result<u64>", "typescript": "Promise<number>", "python": "int"},
	// dbspec parse returns the document or every diagnostic, never both.
	"DbspecReadResult":          {"go": "(string,[]Diagnostic,error)", "php": "Polyspec\\Orm\\Dbspec\\ReadResult", "rust": "Result<String,ReadError>", "typescript": "DbspecReadResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ReadResult", "python": "tuple[str|None,list[DbspecDiagnostic]]"},
	"DbspecBytesResult":         {"go": "(string,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\ReadResult", "rust": "Result<String,Vec<Diagnostic>>", "typescript": "DbspecReadResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ReadResult", "python": "tuple[str|None,list[DbspecDiagnostic]]"},
	"DbspecParseResult":         {"go": "(*Document,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\ParseResult", "rust": "Result<Document,Vec<Diagnostic>>", "typescript": "DbspecParseResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ParseResult", "python": "tuple[DbspecDocument|None,list[DbspecDiagnostic]]"},
	"DbspecText":                {"go": "string", "php": "string", "rust": "String", "typescript": "string", "php-extension": "string", "python": "str"},
	"DbspecRenderResult":        {"go": "([]string,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\RenderResult", "rust": "Result<Vec<String>,Vec<Diagnostic>>", "typescript": "DbspecRenderResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\RenderResult", "python": "dict"},
	"DbspecManifestResult":      {"go": "(*Manifest,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\ManifestResult", "rust": "Result<Manifest,Vec<Diagnostic>>", "typescript": "DbspecManifestResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ManifestResult", "python": "tuple[DbspecManifestResult,tuple]"},
	"DbspecIntrospectResult":    {"go": "(*Document,[]Unsupported,error)", "php": "Polyspec\\Orm\\Dbspec\\IntrospectResult", "rust": "Result<Introspection,IntrospectError>", "typescript": "Promise<DbspecIntrospection>", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\IntrospectResult", "python": "dict"},
	"DbspecExternalDifferences": {"go": "[]string", "php": "array", "rust": "Vec<String>", "typescript": "string[]", "php-extension": "array", "python": "list[str]"},
	"DbspecPlanParseResult":     {"go": "(*Plan,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\PlanParseResult", "rust": "Result<Plan,Vec<Diagnostic>>", "typescript": "DbspecPlanResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\PlanParseResult", "python": "dict"},
	"DbspecChainResult":         {"go": "([]*Plan,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\ChainResult", "rust": "Result<Vec<&Plan>,Vec<Diagnostic>>", "typescript": "DbspecChainResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ChainResult", "python": "dict"},
	"DbspecDiffResult":          {"go": "([]Change,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\DiffResult", "rust": "Result<Vec<Change>,Vec<Diagnostic>>", "typescript": "DbspecDiffResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\DiffResult", "python": "dict"},
	"DbspecComparisonResult":    {"go": "([]Difference,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\ComparisonResult", "rust": "Result<Vec<Difference>,Vec<Diagnostic>>", "typescript": "DbspecComparisonResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\ComparisonResult", "python": "dict"},
	// installedDifferences는 TypeScript에서 읽기 전용 목록이다.
	"DbspecInstalledDifferences": {"go": "[]string", "php": "array", "rust": "Vec<String>", "typescript": "readonlystring[]", "php-extension": "array", "python": "list[str]"},
	"DbspecAddedSteps":           {"go": "(added[]string,steps[]PlanStep,differences[]string)", "php": "array", "rust": "AddTablesAndColumnsSteps", "typescript": "DbspecAddTablesAndColumnsSteps", "php-extension": "array", "python": "dict"},
	"DbspecPlanStepsResult":      {"go": "([]PlanStep,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\PlanStepsResult", "rust": "Result<Vec<PlanStep>,Vec<Diagnostic>>", "typescript": "DbspecPlanStepsResult", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\PlanStepsResult", "python": "dict"},
	"DbspecApplied":              {"go": "error", "php": "void", "rust": "Result<(),ApplyError>", "typescript": "Promise<void>", "php-extension": "void", "python": "None"},
	"DbspecMermaidExport":        {"go": "(string,[]Unsupported)", "php": "Polyspec\\Orm\\Dbspec\\MermaidExportResult", "rust": "(String,Vec<Unsupported>)", "typescript": "DbspecMermaidExport", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\MermaidExportResult", "python": "dict"},
	"DbspecMermaidImport":        {"go": "(*Document,[]Unsupported,[]Diagnostic)", "php": "Polyspec\\Orm\\Dbspec\\MermaidImportResult", "rust": "Result<(Document,Vec<Unsupported>),Vec<Diagnostic>>", "typescript": "DbspecMermaidImport", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\MermaidImportResult", "python": "dict"},
	"AddedTablesAndColumns":      {"go": "([]string,error)", "php": "array", "rust": "Result<Vec<String>>", "typescript": "Promise<string[]>", "python": "list[str]"},
	// 구독 해제는 database를 읽거나 쓰지 않는 동기 호출이다.
	"Unsubscribe": {"go": "(unsubscribefunc())", "php": "Closure", "rust": "Subscription", "typescript": "()=>void", "python": "Callable[[],None]"},
}

// inputs maps a common argument list to the native parameters of each
// language. Rust receivers are checked separately.
var inputs = map[string]map[string]string{
	"":                       {"go": "", "php": "", "rust": "", "typescript": "", "python": ""},
	"Connection":             {"go": "db*orm.DB", "php": "Polyspec\\Orm\\Db$db", "rust": "db:&polyspec_orm::Db", "typescript": "db:Db", "python": "db:Db"},
	"ConnectorArgument":      {"go": "args...any", "php": "mixed...$args", "rust": "arg:A", "typescript": "arg?:((q:this)=>unknown)|Model", "python": "*args"},
	"ChildModel":             {"go": "childorm.Model", "php": "Polyspec\\Orm\\Model$child", "rust": "child:implpolyspec_orm::Model", "typescript": "child:Model", "python": "child:Model"},
	"OffsetCount":            {"go": "offset,countint", "php": "int$offset,int$count", "rust": "offset:u32,count:u32", "typescript": "offset:number,count:number", "python": "offset:int,count:int"},
	"DuplicateModel":         {"go": "m*{Entity}Model", "php": "Polyspec\\Orm\\Model$model", "rust": "m:Self", "typescript": "model:this", "python": "model:Self"},
	"PagePerPage":            {"go": "page,perPageint", "php": "int$page,int$perPage", "rust": "page:u32,per_page:u32", "typescript": "page:number,perPage:number", "python": "page:int,per_page:int"},
	"Rows":                   {"go": "rows[]*{Entity}Model", "php": "array$rows", "rust": "rows:Vec<Self>", "typescript": "rows:readonlythis[]", "python": "rows:list[Self]"},
	"Optimistic":             {"go": "optimistic...bool", "php": "bool$optimistic=false", "rust": "optimistic:bool", "typescript": "optimistic=false", "python": "optimistic:bool=False"},
	"Recursive":              {"go": "recursive...bool", "php": "bool$recursive=false", "rust": "recursive:bool", "typescript": "recursive=false", "python": "recursive:bool=False"},
	"ConnectionOptions":      {"go": "dsnstring,cfgConfig", "php": "string$dsn,Polyspec\\Orm\\Config$config", "rust": "dsn:&str,pool_size:u32,mutcfg:Config", "typescript": "dsn:string,options:ConnectOptions={}", "python": "dsn:str,options:dict|None=None"},
	"SchemaConnection":       {"go": "dsnstring,s*Schema,cfgConfig", "php": "string$dsn,Polyspec\\Orm\\Schema$schema,Polyspec\\Orm\\Config$config", "rust": "dsn:&str,schema:&Schema,pool_size:u32,cfg:Config", "typescript": "dsn:string,schema:Schema,options:ConnectOptions={}", "python": "dsn:str,schema:Schema,options:dict|None=None"},
	"TransactionCallback":    {"go": "fnfunc()error,options...TransactionOption", "php": "Closure$fn,string$isolation=\"\",bool$readOnly=false,int$timeoutMs=0,int$retry=3,?array$audit=null", "rust": "f:F", "typescript": "callback:()=>Promise<T>|T,options:TransactionOptions={}", "python": "callback:Callable[[],T],options:dict|None=None"},
	"LockKey":                {"go": "keystring", "php": "string$key", "rust": "key:&str", "typescript": "key:string", "python": "key:str"},
	"GeneratedSchema":        {"go": "schema*Schema", "php": "Polyspec\\Orm\\Schema$schema", "rust": "schema:&Schema", "typescript": "schema:Schema", "python": "schema:Schema"},
	"ModelKeyring":           {"go": "mModel,keyringAESKeyring", "php": "Polyspec\\Orm\\Model$model,Polyspec\\Orm\\AesKeyring$keyring", "rust": "m:&M,keyring:&AesKeyring", "typescript": "model:unknown,keyring:AesKeyring", "python": "model:Model,keyring:AesKeyring"},
	"DbspecFilePath":         {"go": "pathstring", "php": "string$path", "rust": "path:&Path", "typescript": "path:string", "php-extension": "string$path", "python": "path:str"},
	"DbspecFileBytes":        {"go": "namestring,b[]byte", "php": "string$name,string$bytes", "rust": "name:&str,bytes:Vec<u8>", "typescript": "name:string,bytes:Uint8Array", "php-extension": "string$name,string$bytes", "python": "name:str,data:bytes"},
	"DbspecSource":           {"go": "textstring,documentsmap[string]string", "php": "string$text,array$documents", "rust": "text:&str,documents:&BTreeMap<String,String>", "typescript": "text:string,documents:Readonly<Record<string,string>>", "php-extension": "string$text,array$documents", "python": "text:str,documents:Mapping[str,str]"},
	"DbspecDocument":         {"go": "document*Document", "php": "Polyspec\\Orm\\Dbspec\\Document$document", "rust": "document:&Document", "typescript": "document:DbspecDocument", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$document", "python": "document:DbspecDocument"},
	"DbspecRenderSource":     {"go": "documents[]*Document,dialectDialect", "php": "array$documents,string$dialect", "rust": "documents:&[&Document],dialect:Dialect", "typescript": "documents:readonlyDbspecDocument[],dialect:DbspecDialect", "php-extension": "array$documents,string$dialect", "python": "documents:list[DbspecDocument],dialect:str"},
	"DbspecDocumentSet":      {"go": "documents[]*Document", "php": "array$documents", "rust": "documents:&[&Document]", "typescript": "documents:readonlyDbspecDocument[]", "php-extension": "array$documents", "python": "documents:list[DbspecDocument]"},
	"DbspecIntrospectSource": {"go": "ctxcontext.Context,qQuerier,dialectDialect,namestring", "php": "PDO$connection,string$dialect,string$name", "rust": "connection:&mutQ,dialect:Dialect,name:&str", "typescript": "connection:DbspecMySqlConnection|DbspecPostgresConnection|DbspecSqliteConnection,dialect:DbspecDialect,name:string", "php-extension": "PDO$connection,string$dialect,string$name", "python": "connection:Connection,dialect:str,name:str"},
	"DbspecExternalSource":   {"go": "live*Document,documents[]*Document", "php": "Polyspec\\Orm\\Dbspec\\Document$live,array$documents", "rust": "live:&Document,documents:&[&Document]", "typescript": "live:DbspecDocument,documents:readonlyDbspecDocument[]", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$live,array$documents", "python": "live:DbspecDocument,documents:list[DbspecDocument]"},
	"DbspecPlanText":         {"go": "textstring", "php": "string$text", "rust": "text:&str", "typescript": "text:string", "php-extension": "string$text", "python": "text:str"},
	"DbspecPlan":             {"go": "p*Plan", "php": "Polyspec\\Orm\\Dbspec\\Plan$plan", "rust": "plan:&Plan", "typescript": "plan:DbspecPlan", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Plan$plan", "python": "plan:DbspecPlan"},
	"DbspecPlans":            {"go": "plans[]*Plan", "php": "array$plans", "rust": "plans:&[Plan]", "typescript": "plans:readonlyDbspecPlan[]", "php-extension": "array$plans", "python": "plans:list[DbspecPlan]"},
	"DbspecDiffSource":       {"go": "source*Document,p*Plan", "php": "?Polyspec\\Orm\\Dbspec\\Document$source,Polyspec\\Orm\\Dbspec\\Plan$plan", "rust": "source:Option<&Document>,plan:&Plan", "typescript": "source:DbspecDocument|null,plan:DbspecPlan", "php-extension": "?Polyspec\\Orm\\Dbspec\\Native\\Document$source,Polyspec\\Orm\\Dbspec\\Native\\Plan$plan", "python": "source:DbspecDocument|None,plan:DbspecPlan"},
	"DbspecComparedSchemas":  {"go": "source,target*Document", "php": "Polyspec\\Orm\\Dbspec\\Document$source,Polyspec\\Orm\\Dbspec\\Document$target", "rust": "source:&Document,target:&Document", "typescript": "source:DbspecDocument,target:DbspecDocument", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$source,Polyspec\\Orm\\Dbspec\\Native\\Document$target", "python": "source:DbspecDocument,target:DbspecDocument"},
	"DbspecInstalledSource":  {"go": "live*Document,unsupported[]Unsupported,target*Document", "php": "Polyspec\\Orm\\Dbspec\\Document$live,array$unsupported,Polyspec\\Orm\\Dbspec\\Document$target", "rust": "live:&Document,unsupported:&[Unsupported],target:&Document", "typescript": "live:DbspecDocument,unsupported:readonlyDbspecUnsupported[],target:DbspecDocument", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$live,array$unsupported,Polyspec\\Orm\\Dbspec\\Native\\Document$target", "python": "live:DbspecDocument,unsupported:list[Unsupported],target:DbspecDocument"},
	"DbspecAddedSource":      {"go": "live*Document,unsupported[]Unsupported,target*Document,dialectDialect", "php": "Polyspec\\Orm\\Dbspec\\Document$live,array$unsupported,Polyspec\\Orm\\Dbspec\\Document$target,string$dialect", "rust": "live:&Document,unsupported:&[Unsupported],target:&Document,dialect:Dialect", "typescript": "live:DbspecDocument,unsupported:readonlyDbspecUnsupported[],target:DbspecDocument,dialect:DbspecDialect", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$live,array$unsupported,Polyspec\\Orm\\Dbspec\\Native\\Document$target,string$dialect", "python": "live:DbspecDocument,unsupported:list[Unsupported],target:DbspecDocument,dialect:str"},
	"DbspecStepsSource":      {"go": "source*Document,p*Plan,dialectDialect", "php": "?Polyspec\\Orm\\Dbspec\\Document$source,Polyspec\\Orm\\Dbspec\\Plan$plan,string$dialect", "rust": "source:Option<&Document>,plan:&Plan,dialect:Dialect", "typescript": "source:DbspecDocument|null,plan:DbspecPlan,dialect:DbspecDialect", "php-extension": "?Polyspec\\Orm\\Dbspec\\Native\\Document$source,Polyspec\\Orm\\Dbspec\\Native\\Plan$plan,string$dialect", "python": "source:DbspecDocument|None,plan:DbspecPlan,dialect:str"},
	// Rust의 apply 인자 목록은 끝에 쉼표를 둔다.
	"DbspecApplySource":      {"go": "ctxcontext.Context,cExecer,dialectDialect,plans[]*Plan,nowfunc()time.Time,eventsfunc(ApplyEvent)error", "php": "PDO$connection,string$dialect,array$plans,Closure$now,?Closure$events", "rust": "connection:&mutC,dialect:Dialect,plans:&[Plan],now:&ApplyClock<'_>,events:&mutApplyEvents<'_>,", "typescript": "connection:Connection,dialect:DbspecDialect,plans:readonlyDbspecPlan[],now:()=>number,events?:DbspecApplyHandler|null", "php-extension": "PDO$connection,string$dialect,array$plans,Closure$now,?Closure$events", "python": "connection:Connection,dialect:str,plans:list[DbspecPlan],now:Callable[[],int],events:DbspecApplyHandler|None=None"},
	"DbspecExportedDocument": {"go": "d*Document", "php": "Polyspec\\Orm\\Dbspec\\Document$document", "rust": "document:&Document", "typescript": "document:DbspecDocument", "php-extension": "Polyspec\\Orm\\Dbspec\\Native\\Document$document", "python": "document:DbspecDocument"},
	"DbspecMermaidSource":    {"go": "text,namestring", "php": "string$text,string$name", "rust": "text:&str,name:&str", "typescript": "text:string,name:string", "php-extension": "string$text,string$name", "python": "text:str,name:str"},
	"StatementSubscriber":    {"go": "fnSubscriber", "php": "Closure$subscriber", "rust": "subscriber:F", "typescript": "subscriber:(event:StatementEvent)=>void", "python": "subscriber:Callable[[StatementEvent],None]"},
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
			case "python":
				got, ret = pythonParts(got, ret)
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
// pythonParts reads a Python native signature as the parameter list and the return type that the
// other clients have: self is the receiver of a method and is no parameter, and "->" precedes the
// return type.
func pythonParts(got, ret string) (string, string) {
	ret = strings.TrimPrefix(ret, "->")
	if got == "self" {
		return "", ret
	}
	return strings.TrimPrefix(got, "self,"), ret
}

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
