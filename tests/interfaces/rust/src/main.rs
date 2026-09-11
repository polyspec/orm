//! Extract declarations from actual Rust syntax trees, without executing model code.
use quote::ToTokens;
use std::{collections::BTreeMap, env, fs, path::Path};
use syn::{ImplItem, Item, TraitItem};

fn wire_type(t: &syn::Type) -> String {
    if let syn::Type::Path(p) = t {
        let last = p.path.segments.last().unwrap();
        let name = last.ident.to_string();
        let args: Vec<_> = if let syn::PathArguments::AngleBracketed(a) = &last.arguments {
            a.args.iter().filter_map(|a| if let syn::GenericArgument::Type(t)=a {Some(wire_type(t))}else{None}).collect()
        } else {vec![]};
        return match name.as_str() {
            "String" => "text".into(), "bool" => "bool".into(),
            "u32"|"u64"|"usize"|"i32"|"i64" => "integer".into(),
            "Option"|"Box"|"Arc" => args[0].clone(),
            "Vec" => format!("list<{}>",args[0]),
            "BTreeMap"|"HashMap" if args[0]=="text" => format!("map<{}>",args[1]),
            _ => name,
        };
    }
    format!("unsupported:{}", tokens(t))
}

fn wire_fields(fields: &syn::Fields) -> BTreeMap<String,String> {
    let mut out=BTreeMap::new();
    for f in fields {
        let Some(id)=&f.ident else {continue};
        let mut name=id.to_string().trim_start_matches("r#").to_owned();
        let mut skip=false;
        for a in &f.attrs {
            if !a.path().is_ident("serde") {continue}
            a.parse_nested_meta(|m| {
                if m.path.is_ident("flatten") {name="@flatten".into()}
                if m.path.is_ident("skip") {skip=true}
                if m.input.peek(syn::Token![=]) {
                    let value: syn::LitStr=m.value()?.parse()?;
                    if m.path.is_ident("rename") {name=value.value()}
                }
                Ok(())
            }).unwrap();
        }
        if !skip {out.insert(name,wire_type(&f.ty));}
    }
    out
}

fn tokens(t: &impl ToTokens) -> String { t.to_token_stream().to_string() }

fn add(out: &mut BTreeMap<String, String>, key: String, value: String) {
    assert!(out.insert(key.clone(), value).is_none(), "duplicate symbol {key}");
}

fn items(out: &mut BTreeMap<String, String>, prefix: &str, list: Vec<Item>) {
    for item in list {
        match item {
            Item::Struct(s) => {
                add(out, format!("{prefix}::{}", s.ident), format!("{} struct {} {} {}", tokens(&s.vis), s.ident, tokens(&s.generics), tokens(&s.fields)));
                for (i,f) in s.fields.iter().enumerate() {
                    let name=f.ident.as_ref().map(|i|i.to_string()).unwrap_or(i.to_string());
                    add(out,format!("{prefix}::{}#field.{name}",s.ident),tokens(&f.ty));
                }
                add(out, format!("{prefix}::{}#wire", s.ident),serde_json::to_string(&wire_fields(&s.fields)).unwrap());
            },
            Item::Enum(e) => {
                add(out, format!("{prefix}::{}", e.ident), format!("{} enum {} {} {{ {} }}", tokens(&e.vis), e.ident, tokens(&e.generics), tokens(&e.variants)));
                let mut fields=BTreeMap::new();
                for v in &e.variants {fields.extend(wire_fields(&v.fields))}
                if !fields.is_empty(){add(out,format!("{prefix}::{}#wire",e.ident),serde_json::to_string(&fields).unwrap());}
            },
            Item::Type(t) => add(out, format!("{prefix}::{}", t.ident), tokens(&t)),
            Item::Fn(f) => add(out, format!("{prefix}::{}", f.sig.ident), format!("{} {}", tokens(&f.vis), tokens(&f.sig))),
            Item::Trait(t) => {
                let owner = format!("{prefix}::{}", t.ident);
                add(out, owner.clone(), format!("{} trait {} {} : {}", tokens(&t.vis), t.ident, tokens(&t.generics), tokens(&t.supertraits)));
                for i in t.items {
                    if let TraitItem::Fn(f) = i { add(out, format!("{owner}::{}", f.sig.ident), tokens(&f.sig)); }
                }
            }
            Item::Impl(i) => {
                let target = tokens(&i.self_ty);
                let tr = i.trait_.as_ref().map(|(_, p, _)| format!(" as {}", tokens(p))).unwrap_or_default();
                let owner = format!("{prefix}::{target}{tr}");
                for m in i.items {
                    match m {
                        ImplItem::Fn(f) => add(out, format!("{owner}::{}", f.sig.ident), format!("{} {}", tokens(&f.vis), tokens(&f.sig))),
                        ImplItem::Type(t) => add(out, format!("{owner}::{}", t.ident), tokens(&t)),
                        _ => {}
                    }
                }
            }
            Item::Mod(m) => {
                // Unit-test scaffolding is not a runtime declaration.
                if m.attrs.iter().any(|a| tokens(a).contains("cfg (test)")) { continue; }
                if let Some((_, inner)) = m.content { items(out, &format!("{prefix}::{}", m.ident), inner); }
            }
            _ => {}
        }
    }
}

fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
    let mut paths: Vec<_> = fs::read_dir(dir).unwrap().map(|x| x.unwrap().path()).collect();
    paths.sort();
    for p in paths {
        if p.is_dir() { visit(root, &p, out); }
        else if p.extension().is_some_and(|x| x == "rs") {
            let source = fs::read_to_string(&p).unwrap();
            let ast = syn::parse_file(&source).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            let rel = p.strip_prefix(root).unwrap().to_str().unwrap();
            items(out, rel, ast.items);
        }
    }
}

fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    let root = Path::new(&args[0]);
    let mut out = BTreeMap::new();
    for dir in &args[1..] { visit(root, &root.join(dir), &mut out); }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
