//! Extract declarations from actual Rust syntax trees, without executing model code.
//!
//! A declaration is exported when it is declared `pub` and every inline module that encloses it is `pub`. A method of an
//! impl block, and an associated type, is exported when its impl target is exported and it is `pub`, or it implements a
//! trait. A file is treated as a module of its crate; its module declaration is not followed.
use quote::ToTokens;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
};
use syn::{ImplItem, Item, TraitItem};

/// One declaration: its signature and whether it is exported.
struct Entry {
    signature: String,
    exported: bool,
}

fn is_pub(v: &syn::Visibility) -> bool {
    matches!(v, syn::Visibility::Public(_))
}

fn wire_type(t: &syn::Type) -> String {
    if let syn::Type::Path(p) = t {
        let last = p.path.segments.last().unwrap();
        let name = last.ident.to_string();
        let args: Vec<_> = if let syn::PathArguments::AngleBracketed(a) = &last.arguments {
            a.args.iter().filter_map(|a| if let syn::GenericArgument::Type(t) = a { Some(wire_type(t)) } else { None }).collect()
        } else {
            vec![]
        };
        return match name.as_str() {
            "String" => "text".into(),
            "bool" => "bool".into(),
            "u32" | "u64" | "usize" | "i32" | "i64" => "integer".into(),
            "Option" | "Box" | "Arc" => args[0].clone(),
            "Vec" => format!("list<{}>", args[0]),
            "BTreeMap" | "HashMap" if args[0] == "text" => format!("map<{}>", args[1]),
            _ => name,
        };
    }
    format!("unsupported:{}", tokens(t))
}

fn wire_fields(fields: &syn::Fields) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for f in fields {
        let Some(id) = &f.ident else { continue };
        let mut name = id.to_string().trim_start_matches("r#").to_owned();
        let mut skip = false;
        for a in &f.attrs {
            if !a.path().is_ident("serde") {
                continue;
            }
            a.parse_nested_meta(|m| {
                if m.path.is_ident("flatten") {
                    name = "@flatten".into()
                }
                if m.path.is_ident("skip") {
                    skip = true
                }
                if m.input.peek(syn::Token![=]) {
                    let value: syn::LitStr = m.value()?.parse()?;
                    if m.path.is_ident("rename") {
                        name = value.value()
                    }
                }
                Ok(())
            })
            .unwrap();
        }
        if !skip {
            out.insert(name, wire_type(&f.ty));
        }
    }
    out
}

fn tokens(t: &impl ToTokens) -> String {
    t.to_token_stream().to_string()
}

fn signature_tokens(signature: &syn::Signature) -> String {
    let mut canonical = signature.clone();
    canonical.inputs.pop_punct();
    tokens(&canonical)
}

fn enum_variants_tokens(variants: &syn::punctuated::Punctuated<syn::Variant, syn::Token![,]>) -> String {
    let mut canonical = variants.clone();
    canonical.pop_punct();
    for variant in &mut canonical {
        match &mut variant.fields {
            syn::Fields::Named(fields) => fields.named.pop_punct(),
            syn::Fields::Unnamed(fields) => fields.unnamed.pop_punct(),
            syn::Fields::Unit => None,
        };
    }
    tokens(&canonical)
}

struct ApplyEntryPoint {
    name: syn::Ident,
    command: syn::Ident,
}

impl syn::parse::Parse for ApplyEntryPoint {
    fn parse(input: syn::parse::ParseStream<'_>) -> syn::Result<Self> {
        let _attributes = syn::Attribute::parse_outer(input)?;
        let name = input.parse()?;
        input.parse::<syn::Token![,]>()?;
        let command = input.parse()?;
        if input.peek(syn::Token![,]) {
            input.parse::<syn::Token![,]>()?;
        }
        if !input.is_empty() {
            return Err(input.error("unexpected apply_entrypoint! input"));
        }
        Ok(Self { name, command })
    }
}

/// The body of the one rule of a `macro_rules!` definition, as the text of its tokens.
fn macro_rule_body(definition: &syn::ItemMacro) -> String {
    // The text of the tokens of a group's content, which it consumes.
    let content_text = |content: syn::parse::ParseStream<'_>| -> syn::Result<String> {
        let text = content.cursor().token_stream().to_string();
        content.step(|cursor| {
            let mut rest = *cursor;
            while let Some((_, next)) = rest.token_tree() {
                rest = next;
            }
            Ok(((), rest))
        })?;
        Ok(text)
    };
    let parse = |input: syn::parse::ParseStream<'_>| -> syn::Result<String> {
        let matcher;
        syn::parenthesized!(matcher in input);
        content_text(&matcher)?;
        input.parse::<syn::Token![=>]>()?;
        let body;
        syn::braced!(body in input);
        let text = content_text(&body)?;
        input.parse::<Option<syn::Token![;]>>()?;
        Ok(text)
    };
    syn::parse::Parser::parse2(parse, definition.mac.tokens.clone()).expect("the macro_rules! definition has one rule")
}

/// The dbspec apply module emits its four public command wrappers with its `apply_entrypoint!` macro: the wrapper of
/// an invocation is the body of that macro's definition with its name and command, the documentation left out.
fn expand_apply_entrypoint(item: &syn::ItemMacro, definitions: &HashMap<String, syn::ItemMacro>) -> Option<syn::ItemFn> {
    if !item.mac.path.is_ident("apply_entrypoint") {
        return None;
    }
    let definition = definitions.get("apply_entrypoint").expect("apply_entrypoint! is used before its macro_rules! definition");
    let ApplyEntryPoint { name, command } = syn::parse2(item.mac.tokens.clone()).expect("invalid apply_entrypoint! invocation");
    let body = macro_rule_body(definition).replace("$ (# [$ doc]) *", "").replace("$ name", &name.to_string()).replace("$ command", &command.to_string());
    Some(syn::parse_str(&body).expect("the apply_entrypoint! body is a function"))
}

struct TransactionIntoFuture {
    generics: syn::Generics,
    target: syn::Type,
    where_clause: syn::WhereClause,
    future: syn::Type,
}

impl syn::parse::Parse for TransactionIntoFuture {
    fn parse(input: syn::parse::ParseStream<'_>) -> syn::Result<Self> {
        let generic_content;
        syn::bracketed!(generic_content in input);
        let params = syn::punctuated::Punctuated::<syn::GenericParam, syn::Token![,]>::parse_terminated(&generic_content)?;
        input.parse::<syn::Token![,]>()?;
        let target: syn::Type = input.parse()?;
        input.parse::<syn::Token![,]>()?;
        let bounds_content;
        syn::bracketed!(bounds_content in input);
        let predicates = syn::punctuated::Punctuated::<syn::WherePredicate, syn::Token![,]>::parse_terminated(&bounds_content)?;
        input.parse::<syn::Token![,]>()?;
        let future: syn::Type = input.parse()?;
        if !input.is_empty() {
            return Err(input.error("unexpected transaction_into_future! input"));
        }
        let generics = syn::Generics { lt_token: Some(Default::default()), params, gt_token: Some(Default::default()), where_clause: None };
        let where_clause = syn::WhereClause { where_token: Default::default(), predicates };
        Ok(Self { generics, target, where_clause, future })
    }
}

fn expand_transaction_macro(item: syn::ItemMacro) -> Option<syn::ItemImpl> {
    if item.mac.path.is_ident("transaction_options") {
        let target: syn::Type = syn::parse2(item.mac.tokens).expect("invalid transaction_options! invocation");
        return Some(syn::parse_quote! {
            impl #target {
                pub fn isolation(mut self, level: Isolation) -> Self { self }
                pub fn read_only(mut self) -> Self { self }
                pub fn timeout_ms(mut self, ms: u64) -> Self { self }
                pub fn retry(mut self, n: u32) -> Self { self }
                pub fn audit<K: Into<String>, V: Into<Param>>(mut self, values: impl IntoIterator<Item = (K, V)>) -> Self { self }
            }
        });
    }
    if item.mac.path.is_ident("transaction_into_future") {
        let TransactionIntoFuture { mut generics, target, where_clause, future } =
            syn::parse2(item.mac.tokens).expect("invalid transaction_into_future! invocation");
        generics.where_clause = Some(where_clause);
        let mut expanded: syn::ItemImpl = syn::parse_quote! {
            impl IntoFuture for #target {
                type Output = Result<T>;
                type IntoFuture = #future;
                fn into_future(self) -> Self::IntoFuture { todo!() }
            }
        };
        expanded.generics = generics;
        return Some(expanded);
    }
    None
}

fn add(out: &mut BTreeMap<String, Entry>, key: String, signature: String, exported: bool) {
    assert!(out.insert(key.clone(), Entry { signature, exported }).is_none(), "duplicate symbol {key}");
}

/// The names of the public structs, enums, type aliases and traits of the crate, which an impl target must name to export
/// its methods.
fn public_types(names: &mut HashSet<String>, list: &[Item]) {
    for item in list {
        match item {
            Item::Struct(s) if is_pub(&s.vis) => {
                names.insert(s.ident.to_string());
            }
            Item::Enum(e) if is_pub(&e.vis) => {
                names.insert(e.ident.to_string());
            }
            Item::Type(t) if is_pub(&t.vis) => {
                names.insert(t.ident.to_string());
            }
            Item::Trait(t) if is_pub(&t.vis) => {
                names.insert(t.ident.to_string());
            }
            Item::Mod(m) => {
                if let Some((_, inner)) = &m.content {
                    public_types(names, inner);
                }
            }
            _ => {}
        }
    }
}

fn items(out: &mut BTreeMap<String, Entry>, prefix: &str, list: Vec<Item>, scope: bool, types: &HashSet<String>) {
    // The macro_rules! definitions of this module, by name, which expand the invocations that follow them.
    let mut definitions: HashMap<String, syn::ItemMacro> = HashMap::new();
    for item in list {
        match item {
            Item::Struct(s) => {
                let exported = scope && is_pub(&s.vis);
                add(
                    out,
                    format!("{prefix}::{}", s.ident),
                    format!("{} struct {} {} {}", tokens(&s.vis), s.ident, tokens(&s.generics), tokens(&s.fields)),
                    exported,
                );
                for (i, f) in s.fields.iter().enumerate() {
                    let name = f.ident.as_ref().map(|i| i.to_string()).unwrap_or(i.to_string());
                    add(out, format!("{prefix}::{}#field.{name}", s.ident), tokens(&f.ty), exported && is_pub(&f.vis));
                }
                add(out, format!("{prefix}::{}#wire", s.ident), serde_json::to_string(&wire_fields(&s.fields)).unwrap(), exported);
            }
            Item::Enum(e) => {
                let exported = scope && is_pub(&e.vis);
                add(
                    out,
                    format!("{prefix}::{}", e.ident),
                    format!("{} enum {} {} {{ {} }}", tokens(&e.vis), e.ident, tokens(&e.generics), enum_variants_tokens(&e.variants)),
                    exported,
                );
                let mut fields = BTreeMap::new();
                for v in &e.variants {
                    fields.extend(wire_fields(&v.fields))
                }
                if !fields.is_empty() {
                    add(out, format!("{prefix}::{}#wire", e.ident), serde_json::to_string(&fields).unwrap(), exported);
                }
            }
            Item::Type(t) => add(out, format!("{prefix}::{}", t.ident), tokens(&t), scope && is_pub(&t.vis)),
            Item::Fn(f) => add(out, format!("{prefix}::{}", f.sig.ident), format!("{} {}", tokens(&f.vis), signature_tokens(&f.sig)), scope && is_pub(&f.vis)),
            Item::Trait(t) => {
                let exported = scope && is_pub(&t.vis);
                let owner = format!("{prefix}::{}", t.ident);
                add(out, owner.clone(), format!("{} trait {} {} : {}", tokens(&t.vis), t.ident, tokens(&t.generics), tokens(&t.supertraits)), exported);
                for i in t.items {
                    if let TraitItem::Fn(f) = i {
                        add(out, format!("{owner}::{}", f.sig.ident), signature_tokens(&f.sig), exported);
                    }
                }
            }
            Item::Impl(i) => {
                let target = tokens(&i.self_ty);
                let tr = i.trait_.as_ref().map(|(_, p, _)| format!(" as {}", tokens(p))).unwrap_or_default();
                let owner = format!("{prefix}::{target}{tr}");
                // The impl target's last path segment decides whether its public items are exported.
                let named = match &*i.self_ty {
                    syn::Type::Path(p) => p.path.segments.last().map(|seg| seg.ident.to_string()).unwrap_or_default(),
                    _ => String::new(),
                };
                let target_exported = scope && types.contains(&named);
                let via_trait = i.trait_.is_some();
                for m in i.items {
                    match m {
                        ImplItem::Fn(f) => add(
                            out,
                            format!("{owner}::{}", f.sig.ident),
                            format!("{} {}", tokens(&f.vis), signature_tokens(&f.sig)),
                            target_exported && (via_trait || is_pub(&f.vis)),
                        ),
                        ImplItem::Type(t) => add(out, format!("{owner}::{}", t.ident), tokens(&t), target_exported && (via_trait || is_pub(&t.vis))),
                        _ => {}
                    }
                }
            }
            Item::Macro(m) => {
                if m.mac.path.is_ident("macro_rules") {
                    if let Some(name) = &m.ident {
                        definitions.insert(name.to_string(), m.clone());
                    }
                } else if let Some(f) = expand_apply_entrypoint(&m, &definitions) {
                    add(out, format!("{prefix}::{}", f.sig.ident), format!("{} {}", tokens(&f.vis), signature_tokens(&f.sig)), scope);
                } else if let Some(i) = expand_transaction_macro(m) {
                    items(out, prefix, vec![Item::Impl(i)], scope, types);
                }
            }
            Item::Mod(m) => {
                // Unit-test scaffolding is not a runtime declaration.
                if m.attrs.iter().any(|a| tokens(a).contains("cfg (test)")) {
                    continue;
                }
                if let Some((_, inner)) = m.content {
                    items(out, &format!("{prefix}::{}", m.ident), inner, scope && is_pub(&m.vis), types);
                }
            }
            _ => {}
        }
    }
}

fn is_source(p: &Path) -> bool {
    p.extension().is_some_and(|x| x == "rs") || p.to_str().is_some_and(|x| x.ends_with(".rs.txt"))
}

fn collect(dir: &Path, files: &mut Vec<std::path::PathBuf>) {
    let mut paths: Vec<_> = fs::read_dir(dir).unwrap().map(|x| x.unwrap().path()).collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            collect(&p, files);
        } else if is_source(&p) {
            files.push(p);
        }
    }
}

fn parse(p: &Path) -> syn::File {
    let mut source = fs::read_to_string(p).unwrap();
    // orm-build keeps the fixed model methods in a Rust template that it includes as text; the template is the open
    // `impl T {` block that generated column methods continue, so it is closed to parse the fixed methods.
    if p.to_str().is_some_and(|x| x.ends_with(".rs.txt")) {
        source.push('}');
    }
    match syn::parse_file(&source) {
        Ok(file) => file,
        Err(e) => panic!("{}: {e}", p.display()),
    }
}

fn has_test_cfg(attributes: &[syn::Attribute]) -> bool {
    attributes.iter().any(|attribute| attribute.path().is_ident("cfg") && attribute.parse_args::<syn::Meta>().is_ok_and(|meta| meta.path().is_ident("test")))
}

fn module_source(module: &syn::ItemMod, path_base: &Path, module_base: &Path) -> Option<PathBuf> {
    for attribute in &module.attrs {
        if !attribute.path().is_ident("path") {
            continue;
        }
        if let syn::Meta::NameValue(value) = &attribute.meta {
            if let syn::Expr::Lit(expression) = &value.value {
                if let syn::Lit::Str(path) = &expression.lit {
                    return Some(path_base.join(path.value()));
                }
            }
        }
    }
    let named = module_base.join(format!("{}.rs", module.ident));
    if named.is_file() {
        return Some(named);
    }
    let nested = module_base.join(module.ident.to_string()).join("mod.rs");
    nested.is_file().then_some(nested)
}

fn collect_test_modules(items: &[Item], path_base: &Path, module_base: &Path, test_scope: bool, out: &mut HashSet<PathBuf>) {
    for item in items {
        let Item::Mod(module) = item else { continue };
        let module_is_test = test_scope || has_test_cfg(&module.attrs);
        if let Some((_, contents)) = &module.content {
            let nested_base = module_base.join(module.ident.to_string());
            collect_test_modules(contents, &nested_base, &nested_base, module_is_test, out);
        } else if module_is_test {
            if let Some(path) = module_source(module, path_base, module_base) {
                out.insert(path);
            }
        }
    }
}

fn source_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect(dir, &mut files);
    let mut test_modules = HashSet::new();
    for path in &files {
        let ast = parse(path);
        let path_base = path.parent().unwrap_or(dir);
        let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
        let module_base =
            if matches!(file_name, "lib.rs" | "main.rs" | "mod.rs") { path_base.to_path_buf() } else { path_base.join(path.file_stem().unwrap_or_default()) };
        collect_test_modules(&ast.items, path_base, &module_base, false, &mut test_modules);
    }
    files.retain(|path| !test_modules.contains(path));
    files
}

fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, Entry>, types: &HashSet<String>) {
    let files = source_files(dir);
    for p in files {
        let ast = parse(&p);
        let rel = p.strip_prefix(root).unwrap().to_str().unwrap();
        items(out, rel, ast.items, true, types);
    }
}

fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    let root = Path::new(&args[0]);
    let mut files = Vec::new();
    for dir in &args[1..] {
        files.extend(source_files(&root.join(dir)));
    }
    let mut types = HashSet::new();
    for path in &files {
        public_types(&mut types, &parse(path).items);
    }
    let mut out = BTreeMap::new();
    for dir in &args[1..] {
        visit(root, &root.join(dir), &mut out, &types);
    }
    let json: serde_json::Map<String, serde_json::Value> =
        out.into_iter().map(|(key, e)| (key, serde_json::json!({ "signature": e.signature, "exported": e.exported }))).collect();
    println!("{}", serde_json::to_string_pretty(&serde_json::Value::Object(json)).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn canonicalizes_only_function_parameter_trailing_commas() {
        let _case = polyspec_orm_testcase::start("interface extractor canonicalizes function parameter commas", Duration::from_secs(1));
        let extract = |source: &str| {
            let file = syn::parse_file(source).expect("function source");
            let mut out = BTreeMap::new();
            items(&mut out, "fixture.rs", file.items, true, &HashSet::new());
            out.remove("fixture.rs::catalog_rows").expect("function signature extracted").signature
        };
        let with_comma = extract("pub fn catalog_rows(rows: &[Row], value: impl FnMut(&Row, usize) -> Result<CatalogValue, Error>,) -> (i32,) {}");
        let without_comma = extract("pub fn catalog_rows(rows: &[Row], value: impl FnMut(&Row, usize) -> Result<CatalogValue, Error>) -> (i32,) {}");

        assert_eq!(with_comma, without_comma);
        assert!(with_comma.ends_with("-> (i32 ,)"), "tuple return syntax must remain significant");
    }

    #[test]
    fn canonicalizes_enum_field_and_variant_trailing_commas() {
        let _case = polyspec_orm_testcase::start("interface extractor canonicalizes enum field commas", Duration::from_secs(1));
        let extract = |source: &str| {
            let file = syn::parse_file(source).expect("enum source");
            let mut out = BTreeMap::new();
            items(&mut out, "fixture.rs", file.items, true, &HashSet::new());
            out.remove("fixture.rs::Restore").expect("enum signature extracted").signature
        };
        let with_commas = extract("enum Restore { MySql { lock_wait: i64, row_wait: i64, }, Tuple((i32,),), }");
        let without_commas = extract("enum Restore { MySql { lock_wait: i64, row_wait: i64 }, Tuple((i32,)) }");

        assert_eq!(with_commas, without_commas);
        assert!(with_commas.contains("Tuple ((i32 ,))"), "tuple field syntax must remain significant");
    }

    #[test]
    fn excludes_external_modules_declared_only_for_tests() {
        let _case = polyspec_orm_testcase::start("interface extractor excludes cfg test modules", Duration::from_secs(1));
        let directory = std::env::temp_dir().join(format!(
            "orm-interface-tests-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("system clock").as_nanos()
        ));
        fs::create_dir_all(&directory).expect("temporary source directory");
        fs::write(directory.join("lib.rs"), "pub fn runtime_api() {}\n#[cfg(test)]\n#[path = \"runtime_api_tests.rs\"]\nmod runtime_api_tests;\n")
            .expect("production source");
        fs::write(directory.join("runtime_api_tests.rs"), "pub fn test_only_api() {}\n").expect("test-only source");

        let mut symbols = BTreeMap::new();
        visit(&directory, &directory, &mut symbols, &HashSet::new());
        let has_runtime_api = symbols.contains_key("lib.rs::runtime_api");
        let has_test_only_api = symbols.contains_key("runtime_api_tests.rs::test_only_api");
        fs::remove_dir_all(&directory).expect("remove temporary source directory");

        assert!(has_runtime_api, "production declarations remain in the inventory");
        assert!(!has_test_only_api, "an external cfg(test) module is not a runtime declaration");
    }

    #[test]
    fn parses_an_optional_trailing_comma() {
        let _case = polyspec_orm_testcase::start("interface extractor parses optional trailing commas", Duration::from_secs(1));
        let without_comma = syn::parse_str::<ApplyEntryPoint>("apply, Apply").expect("entrypoint without trailing comma");
        let with_comma = syn::parse_str::<ApplyEntryPoint>("apply, Apply,").expect("entrypoint with trailing comma");
        assert_eq!(without_comma.name.to_string(), "apply");
        assert_eq!(without_comma.command.to_string(), "Apply");
        assert_eq!(with_comma.name.to_string(), "apply");
        assert_eq!(with_comma.command.to_string(), "Apply");
        assert!(syn::parse_str::<ApplyEntryPoint>("apply, Apply,,").is_err(), "duplicate trailing commas are refused");
    }

    #[test]
    fn extracts_public_dbspec_apply_entrypoint_macro_invocations() {
        let _case = polyspec_orm_testcase::start("interface extractor expands dbspec apply entrypoints", Duration::from_secs(1));
        let source = r#"
            macro_rules! apply_entrypoint {
                ($(#[$doc:meta])* $name:ident, $command:ident) => {
                    $(#[$doc])*
                    pub async fn $name<C: ApplyConnection + ?Sized>() -> Result<(), ApplyError> {
                        $command::run().await
                    }
                };
            }
            apply_entrypoint!(
                /// Apply plans.
                apply,
                Apply,
            );
            apply_entrypoint!(
                /// Recover plans.
                recover,
                Recover
            );
            apply_entrypoint!(
                /// Roll back plans.
                rollback,
                Rollback
            );
            apply_entrypoint!(
                /// Finalize plans.
                finalize,
                Finalize
            );
        "#;
        let file = syn::parse_file(source).unwrap();
        let mut out = BTreeMap::new();
        items(&mut out, "apply.rs", file.items, true, &HashSet::new());
        for name in ["apply", "recover", "rollback", "finalize"] {
            let entry = out.get(&format!("apply.rs::{name}")).expect("public entrypoint was not extracted");
            assert!(entry.exported);
            assert!(entry.signature.contains(&format!("pub async fn {name}")));
            assert!(entry.signature.contains("ApplyConnection"));
            assert!(entry.signature.contains("Result < () , ApplyError >"));
        }
    }

    #[test]
    fn extracts_public_transaction_macro_methods_and_future_contracts() {
        let _case = polyspec_orm_testcase::start("interface extractor expands transaction methods and futures", Duration::from_secs(1));
        let source = r#"
            pub struct SendTransaction<'a, T>(&'a T);
            pub struct Transaction<'a, F>(&'a F);
            transaction_options!(SendTransaction<'a, T>);
            transaction_options!(Transaction<'a, F>);
            transaction_into_future!(['a, T], SendTransaction<'a, T>, [T: Send + 'a], Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>);
            transaction_into_future!(['a, F, T], Transaction<'a, F>, [F: AsyncFn() -> Result<T> + 'a, T: 'a], Pin<Box<dyn Future<Output = Result<T>> + 'a>>);
        "#;
        let file = syn::parse_file(source).unwrap();
        let mut types = HashSet::new();
        public_types(&mut types, &file.items);
        let mut out = BTreeMap::new();
        items(&mut out, "tx.rs", file.items, true, &types);
        let option_methods = [
            ("audit", "pub fn audit < K : Into < String > , V : Into < Param > > (mut self , values : impl IntoIterator < Item = (K , V) >) -> Self"),
            ("isolation", "pub fn isolation (mut self , level : Isolation) -> Self"),
            ("read_only", "pub fn read_only (mut self) -> Self"),
            ("retry", "pub fn retry (mut self , n : u32) -> Self"),
            ("timeout_ms", "pub fn timeout_ms (mut self , ms : u64) -> Self"),
        ];
        for target in ["SendTransaction < 'a , T >", "Transaction < 'a , F >"] {
            for (method, signature) in option_methods {
                let entry = out.get(&format!("tx.rs::{target}::{method}")).expect("transaction option method was not extracted");
                assert!(entry.exported);
                assert_eq!(entry.signature, signature, "transaction method signature changed: {target}::{method}");
            }
        }
        let send_future = "tx.rs::SendTransaction < 'a , T > as IntoFuture::IntoFuture";
        assert_eq!(out.get(send_future).unwrap().signature, "type IntoFuture = Pin < Box < dyn Future < Output = Result < T > > + Send + 'a > > ;");
        let local_future = "tx.rs::Transaction < 'a , F > as IntoFuture::IntoFuture";
        assert_eq!(out.get(local_future).unwrap().signature, "type IntoFuture = Pin < Box < dyn Future < Output = Result < T > > + 'a > > ;");
        assert_eq!(out.get("tx.rs::SendTransaction < 'a , T > as IntoFuture::Output").unwrap().signature, "type Output = Result < T > ;");
        assert_eq!(out.get("tx.rs::Transaction < 'a , F > as IntoFuture::Output").unwrap().signature, "type Output = Result < T > ;");
        assert!(out.contains_key("tx.rs::SendTransaction < 'a , T > as IntoFuture::into_future"));
        assert!(out.contains_key("tx.rs::Transaction < 'a , F > as IntoFuture::into_future"));
    }
}
