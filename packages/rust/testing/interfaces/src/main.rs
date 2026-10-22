//! Extract declarations from actual Rust syntax trees, without executing model code.
//!
//! A declaration is exported when it is declared `pub` and every inline module that encloses it is `pub`. A method of an
//! impl block, and an associated type, is exported when its impl target is exported and it is `pub`, or it implements a
//! trait. A file is treated as a module of its crate; its module declaration is not followed.
use quote::ToTokens;
use std::{
    collections::{BTreeMap, HashSet},
    env, fs,
    path::Path,
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
                    format!("{} enum {} {} {{ {} }}", tokens(&e.vis), e.ident, tokens(&e.generics), tokens(&e.variants)),
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
            Item::Fn(f) => add(out, format!("{prefix}::{}", f.sig.ident), format!("{} {}", tokens(&f.vis), tokens(&f.sig)), scope && is_pub(&f.vis)),
            Item::Trait(t) => {
                let exported = scope && is_pub(&t.vis);
                let owner = format!("{prefix}::{}", t.ident);
                add(out, owner.clone(), format!("{} trait {} {} : {}", tokens(&t.vis), t.ident, tokens(&t.generics), tokens(&t.supertraits)), exported);
                for i in t.items {
                    if let TraitItem::Fn(f) = i {
                        add(out, format!("{owner}::{}", f.sig.ident), tokens(&f.sig), exported);
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
                            format!("{} {}", tokens(&f.vis), tokens(&f.sig)),
                            target_exported && (via_trait || is_pub(&f.vis)),
                        ),
                        ImplItem::Type(t) => add(out, format!("{owner}::{}", t.ident), tokens(&t), target_exported && (via_trait || is_pub(&t.vis))),
                        _ => {}
                    }
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

fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, Entry>, types: &HashSet<String>) {
    let mut files = Vec::new();
    collect(dir, &mut files);
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
        collect(&root.join(dir), &mut files);
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
