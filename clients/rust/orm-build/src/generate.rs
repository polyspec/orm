//! Generates the model source: fixed methods for every model and the
//! grammar-derived methods that the scanned source calls.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;

use syn::Expr;

use crate::manifest::{check_column_name, function_column, numeric, styled, DocumentSet};
use crate::names::{column_name, parse_chain, parse_order, pascal, snake_to_pascal, split_pair, ChainKey};
use crate::scan::{Call, Scan};
use orm_schema::dbspec::{Entity, Field, RuntimeModel, Type};

pub(crate) fn fallible_setters(model: &RuntimeModel) -> HashSet<(String, String)> {
    model
        .entities
        .iter()
        .flat_map(|entity| {
            let model = pascal(&entity.name);
            entity
                .fields
                .iter()
                .filter(|column| column.styled_value() || matches!(column.ty, Type::Decimal(..)))
                .map(move |column| (model.clone(), format!("set_{}", column.name)))
        })
        .collect()
}

const RUST_RESERVED: &[&str] = &[
    "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move",
    "mut", "pub", "ref", "return", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while", "async", "await", "dyn",
    "abstract", "become", "box", "do", "final", "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try", "gen",
];

const FIXED: &[&str] = &[
    "new",
    "connect",
    "and",
    "or",
    "raw",
    "and_raw",
    "or_raw",
    "on",
    "relation",
    "relations",
    "get",
    "gets",
    "get_count",
    "gets_count",
    "get_sum",
    "get_avg",
    "gets_page",
    "get_query",
    "create",
    "creates",
    "update",
    "save",
    "delete",
    "duplication",
    "limit",
    "order_by_random",
    "order_by_raw",
    "group_by_raw",
    "remove_all_columns",
    "add_all_columns",
    "parent_node",
    "group_limit",
    "delete_lock",
    "fetch_key",
    "fetch_value",
    "for_update",
    "for_share",
    "for_update_no_wait",
    "for_share_no_wait",
    "to_array",
    "to_json",
];

/// Methods every model has from its derived traits.
const DERIVED: &[&str] = &["clone", "clone_from", "serialize"];

const COLUMN_FUNCTIONS: &[&str] = &["day_of_week", "year", "month", "date"];

fn ident(s: &str) -> String {
    if RUST_RESERVED.contains(&s) {
        format!("r#{s}")
    } else {
        s.to_owned()
    }
}

fn has_trait(column: &str) -> String {
    format!("Has{}", pascal(column))
}

fn index_method(name: &str) -> String {
    // snake(pascal(name))
    let p = pascal(name);
    let mut out = String::new();
    for (i, ch) in p.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// null을 뺀 column의 Rust value type (docs/dbspec.md, "Runtime model"). codec이
/// 있는 column은 첫 stage가 `ordered_json`이면 ordered-json styled value, 다른
/// styled value stage가 있으면 common value model의 styled value, `aes`, `hex`,
/// `ip`만 있으면 string이다.
fn base(c: &Field) -> &'static str {
    if c.codec.first().is_some_and(|s| s == "ordered_json") {
        return ORDERED;
    }
    if c.styled_value() {
        return "orm::serde_json::Value";
    }
    if !c.codec.is_empty() {
        return "String";
    }
    match c.ty {
        Type::I16 => "i16",
        Type::I32 => "i32",
        Type::I64 => "i64",
        Type::F64 => "f64",
        Type::Bool => "bool",
        Type::DateTime(_) => "orm::chrono::NaiveDateTime",
        Type::Date => "orm::chrono::NaiveDate",
        Type::Bytes => "Vec<u8>",
        Type::Decimal(..) | Type::Varchar(_) | Type::Text | Type::Uuid | Type::Time(_) => "String",
    }
}

#[cfg(test)]
mod field_type_tests {
    use super::*;

    fn field_of(ty: Type, codec: &[&str]) -> Field {
        Field {
            name: "value".into(),
            ty,
            nullable: true,
            identity: false,
            primary_key: false,
            foreign_key: false,
            default: None,
            select_explicit: false,
            codec: codec.iter().map(|s| s.to_string()).collect(),
            blind_index: None,
        }
    }

    #[test]
    fn generated_field_types_follow_the_runtime_model() {
        assert_eq!(base(&field_of(Type::Decimal(13, 3), &[])), "String");
        assert_eq!(base(&field_of(Type::I16, &[])), "i16");
        assert_eq!(base(&field_of(Type::Uuid, &[])), "String");
        assert_eq!(base(&field_of(Type::Time(3), &[])), "String");
        assert_eq!(base(&field_of(Type::Text, &["ordered_json"])), ORDERED);
        assert_eq!(base(&field_of(Type::Bytes, &["ordered_json", "aes"])), ORDERED);
        assert_eq!(base(&field_of(Type::Varchar(255), &["aes", "hex"])), "String");
        assert_eq!(base(&field_of(Type::Bytes, &["ip"])), "String");
        for codec in [&["gz"][..], &["base64"], &["serialize"], &["yaml"]] {
            let column = field_of(if codec[0] == "gz" { Type::Bytes } else { Type::Text }, codec);
            assert_eq!(base(&column), "orm::serde_json::Value", "{codec:?}");
            assert!(column.styled_value(), "{codec:?}: a styled value");
        }
    }
}

/// The type of a column with the `ordered_json` stage.
const ORDERED: &str = "orm::ordered_json::Value";

fn field(c: &Field) -> String {
    let t = base(c);
    if c.nullable {
        format!("Option<{t}>")
    } else {
        t.to_owned()
    }
}

fn copy_type(t: &str) -> bool {
    !matches!(t, "String" | "Vec<u8>" | "orm::serde_json::Value" | ORDERED)
}

fn convert(t: &str) -> &'static str {
    match t {
        "i16" => "v.as_i16()?",
        "i32" => "v.as_i32()?",
        "i64" => "v.as_i64()?",
        "f64" => "v.as_f64()?",
        "bool" => "v.as_bool()?",
        "orm::chrono::NaiveDateTime" => "v.as_datetime()?",
        "orm::chrono::NaiveDate" => "v.as_date()?",
        "orm::serde_json::Value" => "v.into_json()?",
        ORDERED => "v.take_ordered()?",
        "Vec<u8>" => "v.take_bytes()?",
        _ => "v.take_string()?",
    }
}

fn to_val(t: &str, x: &str) -> String {
    match t {
        "i16" | "i32" => format!("orm::Val::I64({x} as i64)"),
        "i64" => format!("orm::Val::I64({x})"),
        "f64" => format!("orm::Val::F64({x})"),
        "bool" => format!("orm::Val::Bool({x})"),
        "orm::chrono::NaiveDateTime" => format!("orm::Val::DateTime({x})"),
        "orm::chrono::NaiveDate" => format!("orm::Val::Date({x})"),
        "orm::serde_json::Value" => format!("orm::Val::Json({x}.clone())"),
        ORDERED => format!("orm::Val::ordered({x}.clone())"),
        "Vec<u8>" => format!("orm::Val::Bytes({x}.clone())"),
        _ => format!("orm::Val::Str({x}.clone())"),
    }
}

/// The value kind that bounds the condition arguments of a column.
fn kind(c: &Field) -> String {
    let k = if styled(c) {
        "Styled"
    } else if !c.codec.is_empty() {
        "Text"
    } else {
        match c.ty {
            Type::I16 | Type::I32 | Type::I64 => "Int",
            Type::F64 => "Float",
            Type::Decimal(..) => "Decimal",
            Type::Bool => "Bool",
            Type::Date | Type::DateTime(_) => "Time",
            Type::Bytes => "Bytes",
            Type::Varchar(_) | Type::Text | Type::Uuid | Type::Time(_) => "Text",
        }
    };
    format!("orm::args::kind::{k}{}", if c.nullable { "Null" } else { "" })
}

#[derive(Clone, PartialEq)]
struct Getter {
    result: String,
    expr: String,
    origin: String,
}

struct Model<'m> {
    e: &'m Entity,
    typ: String,
    module: String,
    fixed: BTreeSet<String>,
    methods: BTreeMap<String, (usize, String)>,
    getters: BTreeMap<String, Getter>,
    /// order_by_<col>_asc/desc that take a column function, and whether a call
    /// without one was seen.
    order_fn: BTreeMap<String, bool>,
}

struct Gen<'m> {
    m: &'m RuntimeModel,
    models: Vec<Model<'m>>,
    by_type: HashMap<String, usize>,
    owners: BTreeSet<String>,
    errors: Vec<String>,
}

impl<'m> Model<'m> {
    fn new(e: &'m Entity) -> Model<'m> {
        let mut fixed: BTreeSet<String> = FIXED.iter().map(|s| s.to_string()).collect();
        for c in &e.fields {
            for p in ["get_", "set_", "set_raw_", "add_column_", "remove_column_", "group_by_", "key_name_"] {
                fixed.insert(format!("{p}{}", c.name));
            }
            fixed.insert(format!("order_by_{}_asc", c.name));
            fixed.insert(format!("order_by_{}_desc", c.name));
            if numeric(c) {
                for p in ["plus_", "minus_", "sum_", "avg_"] {
                    fixed.insert(format!("{p}{}", c.name));
                }
            }
        }
        for name in index_names(e) {
            fixed.insert(format!("force_index_{}", index_method(name)));
        }
        let module = if RUST_RESERVED.contains(&e.name.as_str()) || matches!(e.name.as_str(), "orm" | "std" | "core" | "alloc") {
            format!("{}_model", e.name)
        } else {
            e.name.clone()
        };
        Model { e, typ: pascal(&e.name), module, fixed, methods: BTreeMap::new(), getters: BTreeMap::new(), order_fn: BTreeMap::new() }
    }
}

/// index hint를 받는 index와 unique key의 이름, 이름 순서.
fn index_names(e: &Entity) -> Vec<&str> {
    let mut names: Vec<&str> = e.indexes.iter().chain(&e.uniques).map(|k| k.name.as_str()).collect();
    names.sort_unstable();
    names
}

fn function_arg(e: &Expr) -> bool {
    match e {
        Expr::Call(c) => match &*c.func {
            Expr::Path(p) => p.path.segments.last().map(|s| COLUMN_FUNCTIONS.contains(&s.ident.to_string().as_str())).unwrap_or(false),
            _ => false,
        },
        Expr::Paren(p) => function_arg(&p.expr),
        _ => false,
    }
}

fn keys_const(keys: &[ChainKey]) -> String {
    let mut b = String::from("        const KEYS: &[orm::core::ChainKey] = &[\n");
    for k in keys {
        let cols: Vec<String> = k.columns.iter().map(|c| format!("{c:?}")).collect();
        let _ = writeln!(
            b,
            "            orm::core::ChainKey {{ conn: {:?}, op: {:?}, column: {:?}, columns: &[{}], compare: {:?} }},",
            k.conn,
            k.op,
            k.column,
            cols.join(", "),
            k.compare
        );
    }
    b.push_str("        ];\n");
    b
}

/// Inserts the receiver into a parameter list that may start with generics.
fn with_receiver(params: &str, receiver: &str) -> String {
    let mut i = params.find('(').unwrap_or(0);
    if params.starts_with('<') {
        let mut depth = 0;
        for (j, ch) in params.char_indices() {
            match ch {
                '<' => depth += 1,
                '>' => {
                    depth -= 1;
                    if depth == 0 {
                        i = j + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    let rest = &params[i + 1..];
    if rest == ")" {
        format!("{}{receiver})", &params[..=i])
    } else {
        format!("{}{receiver}, {rest}", &params[..=i])
    }
}

/// The call of a method that the generator handles.
struct Req<'c> {
    call: &'c Call,
    /// The receiver is known to be this model; errors are reported.
    typed: bool,
}

impl<'m> Gen<'m> {
    fn fail(&mut self, r: &Req<'_>, msg: String) {
        if r.typed {
            self.errors.push(format!("{}: {msg}", r.call.pos));
        }
    }

    fn add_method(&mut self, gi: usize, r: &Req<'_>, name: &str, argc: usize, code: String) {
        let gm = &mut self.models[gi];
        match gm.methods.get(name) {
            Some((n, _)) if *n != argc => {
                let msg = format!("{}::{name} is called with {n} and with {argc} arguments", gm.typ);
                self.fail(r, msg);
            }
            Some(_) => {}
            None => {
                gm.methods.insert(name.to_owned(), (argc, code));
            }
        }
    }

    fn add_getter(&mut self, gi: usize, r: &Req<'_>, name: &str, g: Getter) {
        let gm = &mut self.models[gi];
        let msg = if gm.fixed.contains(name) {
            format!("{}::{name} is a fixed method; choose another name", gm.typ)
        } else {
            match gm.getters.get(name) {
                Some(prev) if *prev != g => format!("{}::{name} is used for {} and for {}", gm.typ, prev.origin, g.origin),
                Some(_) => return,
                None => {
                    gm.getters.insert(name.to_owned(), g);
                    return;
                }
            }
        };
        self.fail(r, msg);
    }

    fn output_name(&mut self, gi: usize, r: &Req<'_>, name: &str) -> bool {
        let typ = self.models[gi].typ.clone();
        if snake_to_pascal(name).is_none() {
            self.fail(r, format!("{typ}: {name:?} is not a snake_case output name"));
            return false;
        }
        if self.models[gi].e.field(name).is_some() {
            self.fail(r, format!("{typ}: {name} is a column name"));
            return false;
        }
        true
    }

    fn value_getter(&mut self, gi: usize, r: &Req<'_>, name: &str, origin: String) {
        self.add_getter(
            gi,
            r,
            &format!("get_{name}"),
            Getter { result: "orm::Result<Option<orm::serde_json::Value>>".into(), expr: format!("self.__orm.attached({name:?})"), origin },
        );
    }

    /// The parameter list of a chain method and the argument vector passed to Core::chain.
    fn chain_params(&mut self, gi: usize, r: &Req<'_>, keys: &[ChainKey]) -> Option<(String, String)> {
        let (typ, name, args) = (self.models[gi].typ.clone(), &r.call.name, &r.call.args);
        for (i, a) in args.iter().enumerate() {
            if function_arg(a) && (keys.len() > 1 || i > 0) {
                self.fail(r, format!("{typ}::{name}: a column function is accepted only by a single-key condition"));
                return None;
            }
        }
        let e = self.models[gi].e;
        if args.len() == keys.len() + 1 {
            let k = &keys[0];
            let ok =
                keys.len() == 1 && e.field(&k.column).map(function_column).unwrap_or(false) && k.compare.is_empty() && !matches!(k.op, "between" | "lk" | "lb");
            if !ok {
                self.fail(r, format!("{typ}::{name} takes {} values, not {}", keys.len(), args.len()));
                return None;
            }
            return Some(("(f: orm::Func, v: impl orm::args::Compared)".into(), "vec![orm::core::Arg::Function(f, v.into_param())]".into()));
        }
        if args.len() != keys.len() {
            self.fail(r, format!("{typ}::{name} takes {} values, not {}", keys.len(), args.len()));
            return None;
        }
        let (mut tparams, mut params, mut call) = (Vec::new(), Vec::new(), Vec::new());
        for (i, k) in keys.iter().enumerate() {
            let p = format!("v{i}");
            match k.op {
                "tuple" | "ne_tuple" => {
                    let cols: Vec<&Field> = k.columns.iter().filter_map(|c| e.field(c)).collect();
                    let types: Vec<&str> = cols.iter().map(|c| base(c)).collect();
                    let vars: Vec<String> = (0..cols.len()).map(|j| format!("a{j}")).collect();
                    let conv: Vec<String> = (0..cols.len()).map(|j| format!("orm::Param::from(a{j})")).collect();
                    params.push(format!("{p}: Vec<({})>", types.join(", ")));
                    call.push(format!("orm::core::Arg::Tuples({p}.into_iter().map(|({})| vec![{}]).collect())", vars.join(", "), conv.join(", ")));
                }
                _ => {
                    let c = e.field(&k.column).expect("parsed column");
                    if !k.compare.is_empty() {
                        self.owners.insert(k.compare.clone());
                        params.push(format!("{p}: &impl super::{}", has_trait(&k.compare)));
                        call.push(format!("orm::core::Arg::Model(orm::Model::core({p}).id())"));
                    } else if k.op == "lk" || k.op == "lb" {
                        params.push(format!("{p}: impl orm::args::LikeArg"));
                        call.push(format!("orm::core::Arg::Value(orm::args::LikeArg::into_value({p}))"));
                    } else {
                        let tr = match k.op {
                            "" | "ne" => "EqArg",
                            "between" => "BetweenArg",
                            _ => "CmpArg",
                        };
                        let knd = kind(c);
                        tparams.push(format!("V{i}: orm::args::{tr}<{knd}>"));
                        params.push(format!("{p}: V{i}"));
                        call.push(format!("orm::core::Arg::Value(orm::args::{tr}::<{knd}>::into_value({p}))"));
                    }
                }
            }
        }
        let generics = if tparams.is_empty() { String::new() } else { format!("<{}>", tparams.join(", ")) };
        Some((format!("{generics}({})", params.join(", ")), format!("vec![{}]", call.join(", "))))
    }

    /// Generates the method of model `gi` that the call names.
    fn method(&mut self, gi: usize, r: &Req<'_>) {
        let (typ, e) = (self.models[gi].typ.clone(), self.models[gi].e);
        let name = r.call.name.as_str();
        let argc = r.call.args.len();
        if let Some((n, _)) = self.models[gi].methods.get(name) {
            if *n != argc {
                self.fail(r, format!("{typ}::{name} is called with {n} and with {argc} arguments"));
            }
            return;
        }
        let want = |g: &mut Gen<'m>, n: usize| -> bool {
            if argc != n {
                g.fail(r, format!("{typ}::{name} takes {n} arguments, not {argc}"));
                return false;
            }
            true
        };
        let part = |rest: &str| snake_to_pascal(rest).unwrap_or_default();
        if let Some((prefix, rest)) = ["get_by_", "gets_by_", "get_count_by_"].iter().find_map(|p| name.strip_prefix(p).map(|r| (*p, r))) {
            let keys = match parse_chain(self.m, e, &part(rest)) {
                Ok(k) => k,
                Err(err) => return self.fail(r, format!("{typ}::{name}: {err}")),
            };
            let Some((params, args)) = self.chain_params(gi, r, &keys) else { return };
            let (result, body) = match prefix {
                "get_by_" => ("orm::Result<Self>", format!("orm::model::get_core(&self.__orm.by(KEYS, {args})).await")),
                "gets_by_" => ("orm::Result<orm::Collection<Self>>", format!("orm::model::gets_core(&self.__orm.by(KEYS, {args}), \"all\").await")),
                _ => ("orm::Result<i64>", format!("orm::model::get_count(&self.__orm.by(KEYS, {args})).await")),
            };
            let code = format!(
                "    /// Runs the terminal with the condition {rest}.\n    pub async fn {name}{} -> {result} {{\n{}        {body}\n    }}\n",
                with_receiver(&params, "&self"),
                keys_const(&keys)
            );
            return self.add_method(gi, r, name, argc, code);
        }
        if let Some(rest) = name.strip_prefix("order_by_") {
            if !want(self, 0) {
                return;
            }
            let keys = match parse_order(e, &part(rest)) {
                Ok(k) => k,
                Err(err) => return self.fail(r, format!("{typ}::{name}: {err}")),
            };
            let mut body = String::new();
            for (col, desc) in keys {
                let _ = writeln!(body, "        self.__orm.order_by({col:?}, {desc}, None);");
            }
            let code = format!("    /// Orders by {rest}.\n    pub fn {name}(mut self) -> Self {{\n{body}        self\n    }}\n");
            return self.add_method(gi, r, name, argc, code);
        }
        let join = name.strip_prefix("join_").map(|r| ("inner", r)).or_else(|| name.strip_prefix("left_join_").map(|r| ("left", r)));
        if let Some((join_kind, rest)) = join {
            if !want(self, 1) {
                return;
            }
            let (left, right) = match split_pair(self.m, Some(e), None, &part(rest)) {
                Ok(p) => p,
                Err(err) => return self.fail(r, format!("{typ}::{name}: {err}")),
            };
            self.owners.insert(right.clone());
            let code = format!(
                "    /// Joins the child on {left} = child.{right}.\n    pub fn {name}<C: super::{}>(mut self, child: C) -> Self {{\n        self.__orm.join({join_kind:?}, {left:?}, {right:?}, orm::Model::into_core(child));\n        self\n    }}\n",
                has_trait(&right)
            );
            return self.add_method(gi, r, name, argc, code);
        }
        if let Some(rest) = name.strip_prefix("match_") {
            if !want(self, 0) {
                return;
            }
            let (left, right) = match split_pair(self.m, None, Some(e), &part(rest)) {
                Ok(p) => p,
                Err(err) => return self.fail(r, format!("{typ}::{name}: {err}")),
            };
            let code = format!(
                "    /// Adds the relation key component parent.{left} = {right}.\n    pub fn {name}(mut self) -> Self {{\n        self.__orm.add_match({left:?}, {right:?});\n        self\n    }}\n"
            );
            return self.add_method(gi, r, name, argc, code);
        }
        if let Some(rest) = name.strip_prefix("possible_") {
            if !want(self, 1) {
                return;
            }
            let Some(col) = column_name(self.m, None, &part(rest)) else {
                return self.fail(r, format!("{typ}::{name}: no model has the column {rest}"));
            };
            let code = format!(
                "    /// Loads the relation only when parent.{col} equals the value.\n    pub fn {name}(mut self, v: impl Into<orm::Param>) -> Self {{\n        self.__orm.possible({col:?}, v.into());\n        self\n    }}\n"
            );
            return self.add_method(gi, r, name, argc, code);
        }
        if let Some(alias) = name.strip_prefix("alias_") {
            if !want(self, 0) || !self.output_name(gi, r, alias) {
                return;
            }
            let code = format!(
                "    /// Names the relation or join result {alias}.\n    pub fn {name}(mut self) -> Self {{\n        self.__orm.set_alias({alias:?});\n        self\n    }}\n"
            );
            return self.add_method(gi, r, name, argc, code);
        }
        if let Some(attr) = name.strip_prefix("new_") {
            if !want(self, 1) || !self.output_name(gi, r, attr) {
                return;
            }
            let code = format!(
                "    /// Attaches {attr} to the row output.\n    pub fn {name}(mut self, v: impl Into<orm::serde_json::Value>) -> Self {{\n        self.__orm.attach({attr:?}, v.into());\n        self\n    }}\n"
            );
            self.add_method(gi, r, name, argc, code);
            return self.value_getter(gi, r, attr, format!("the value attached with {name}"));
        }
        if let Some(attr) = name.strip_prefix("add_raw_column_") {
            if !want(self, 2) || !self.output_name(gi, r, attr) {
                return;
            }
            let code = format!(
                "    /// Adds the raw column {attr}.\n    pub fn {name}(mut self, sql: &str, binds: impl orm::Binds) -> Self {{\n        self.__orm.add_raw_column({attr:?}, sql, binds.into_binds());\n        self\n    }}\n"
            );
            self.add_method(gi, r, name, argc, code);
            return self.value_getter(gi, r, attr, format!("the column added with {name}"));
        }
        if let Some(rest) = name.strip_prefix("add_column_") {
            if !want(self, 1) {
                return;
            }
            let mut from = 0;
            while let Some(j) = rest[from..].find("_alias_") {
                let i = from + j;
                from = i + 1;
                let attr = &rest[i + "_alias_".len()..];
                let Some(col) = column_name(self.m, Some(e), &part(&rest[..i])) else { continue };
                if attr.is_empty() {
                    continue;
                }
                if !self.output_name(gi, r, attr) {
                    return;
                }
                let code = format!(
                    "    /// Adds {col} as {attr}, formatted or wrapped in a column function.\n    pub fn {name}(mut self, format: impl orm::args::IntoColumnFormat) -> Self {{\n        self.__orm.add_column_as({col:?}, {attr:?}, format);\n        self\n    }}\n"
                );
                self.add_method(gi, r, name, argc, code);
                return self.value_getter(gi, r, attr, format!("the column added with {name}"));
            }
            if !self.output_name(gi, r, rest) {
                return;
            }
            let code = format!(
                "    /// Adds the scalar subquery column {rest}; the callback receives this model.\n    pub fn {name}<R: orm::Model>(mut self, f: impl Fn(&Self) -> R + Send + Sync + 'static) -> Self {{\n        self.__orm.add_column_query::<Self, R>({rest:?}, f);\n        self\n    }}\n"
            );
            self.add_method(gi, r, name, argc, code);
            return self.value_getter(gi, r, rest, format!("the column added with {name}"));
        }
        let (conn, chain) = if let Some(c) = name.strip_prefix("and_") {
            ("and", c)
        } else if let Some(c) = name.strip_prefix("or_") {
            ("or", c)
        } else {
            ("", name)
        };
        let Some(p) = snake_to_pascal(chain) else {
            return self.fail(r, format!("{typ} has no method {name}"));
        };
        let keys = match parse_chain(self.m, e, &p) {
            Ok(k) => k,
            Err(err) => return self.fail(r, format!("{typ} has no method {name}: {err}")),
        };
        let Some((params, args)) = self.chain_params(gi, r, &keys) else { return };
        let code = format!(
            "    /// Adds the condition {chain}.\n    pub fn {name}{} -> Self {{\n{}        self.__orm.chain({conn:?}, KEYS, {args});\n        self\n    }}\n",
            with_receiver(&params, "mut self"),
            keys_const(&keys)
        );
        self.add_method(gi, r, name, argc, code);
    }

    /// Switches a fixed order_by_<col>_asc/desc to the form that takes a
    /// column function; reports whether the name is such a method.
    fn order_function(&mut self, gi: usize, r: &Req<'_>) -> bool {
        let name = r.call.name.as_str();
        let argc = r.call.args.len();
        let gm = &self.models[gi];
        let Some(c) = gm.e.fields.iter().find(|c| name == format!("order_by_{}_asc", c.name) || name == format!("order_by_{}_desc", c.name)) else {
            return false;
        };
        if !function_column(c) {
            return true;
        }
        let typ = gm.typ.clone();
        let entry = self.models[gi].order_fn.entry(name.to_owned()).or_insert(false);
        match argc {
            0 => {}
            1 => *entry = true,
            _ => {
                self.fail(r, format!("{typ}::{name} takes no argument or one column function"));
                return true;
            }
        }
        true
    }

    fn relation_getter(&mut self, parent: usize, child: usize, many: bool, r: &Req<'_>, key: &str) {
        let (module, ctyp, table) = (self.models[child].module.clone(), self.models[child].typ.clone(), self.models[child].e.name.clone());
        let typ = format!("super::{module}::{ctyp}");
        let g = if many {
            Getter {
                result: format!("Option<&orm::Collection<{typ}>>"),
                expr: format!("self.__orm.related_many::<{typ}>({key:?})"),
                origin: format!("the {table} result {key}"),
            }
        } else {
            Getter { result: format!("Option<&{typ}>"), expr: format!("self.__orm.related_one::<{typ}>({key:?})"), origin: format!("the {table} result {key}") }
        };
        self.add_getter(parent, r, &r.call.name.clone(), g);
    }
}

/// 한 document set과 scan의 generated source. `manifest_file`은 manifest text를 담은 file이다.
pub fn generate(set: &DocumentSet, scan: &Scan, manifest_file: &str) -> Result<String, String> {
    let m = &set.model;
    let mut errors = Vec::new();
    for e in &m.entities {
        for c in &e.fields {
            if let Err(err) = check_column_name(&c.name) {
                errors.push(format!("{}.{}: {err}", e.name, c.name));
            }
        }
        if e.name == "schema" || e.name == "manifest_hash" {
            errors.push(format!("{}: the entity name collides with a generated item", e.name));
        }
    }
    let mut g = Gen { m, models: m.entities.iter().map(Model::new).collect(), by_type: HashMap::new(), owners: BTreeSet::new(), errors };
    for (i, gm) in g.models.iter().enumerate() {
        g.by_type.insert(gm.typ.clone(), i);
        for c in &gm.e.fields {
            if gm.fixed.contains(&c.name) {
                g.errors.push(format!("{}.{}: the condition method {} is also a fixed method of {}", gm.e.name, c.name, c.name, gm.typ));
            }
        }
    }
    let targets = |g: &Gen<'_>, call: &Call| -> Vec<(usize, bool)> {
        match call.model.as_ref().and_then(|t| g.by_type.get(t)) {
            Some(i) => vec![(*i, true)],
            None => (0..g.models.len()).map(|i| (i, false)).collect(),
        }
    };
    // the aliases each model sets, and how their results are attached
    let mut alias_models: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
    let mut alias_many: BTreeMap<String, BTreeSet<bool>> = BTreeMap::new();
    for u in &scan.alias_uses {
        alias_many.entry(u.alias.clone()).or_default().insert(u.many);
    }
    let getter = |c: &Call| c.name.starts_with("get_") && !c.name.starts_with("get_by_") && !c.name.starts_with("get_count_by_");
    for call in scan.calls.iter().filter(|c| !getter(c)) {
        for (gi, typed) in targets(&g, call) {
            let r = Req { call, typed };
            if g.models[gi].fixed.contains(&call.name) || DERIVED.contains(&call.name.as_str()) {
                g.order_function(gi, &r);
                continue;
            }
            g.method(gi, &r);
            if let Some(alias) = call.name.strip_prefix("alias_") {
                if typed {
                    alias_models.entry(alias.to_owned()).or_default().insert(gi);
                }
                if let Some(many) = call.attached_many {
                    alias_many.entry(alias.to_owned()).or_default().insert(many);
                }
            }
        }
    }
    for call in scan.calls.iter().filter(|c| getter(c)) {
        let rest = &call.name["get_".len()..];
        for (gi, typed) in targets(&g, call) {
            let r = Req { call, typed };
            if g.models[gi].fixed.contains(&call.name) || g.models[gi].getters.contains_key(&call.name) {
                continue;
            }
            if !call.args.is_empty() {
                let typ = g.models[gi].typ.clone();
                g.fail(&r, format!("{typ}::{} takes no arguments", call.name));
                continue;
            }
            let table = [("_models", true), ("_model", false)]
                .iter()
                .find_map(|(suffix, many)| rest.strip_suffix(suffix).and_then(|t| g.models.iter().position(|m| m.e.name == t)).map(|i| (i, *many)));
            if let Some((child, many)) = table {
                g.relation_getter(gi, child, many, &r, rest);
                continue;
            }
            if let Some(models) = alias_models.get(rest) {
                let typ = g.models[gi].typ.clone();
                if models.len() != 1 {
                    g.fail(&r, format!("alias_{rest} names results of more than one model; use one result name per model"));
                    continue;
                }
                let kinds = alias_many.get(rest).cloned().unwrap_or_default();
                if kinds.len() != 1 {
                    let why = if kinds.is_empty() { "is not passed to relation, relations, or a join" } else { "is passed to relation and to relations" };
                    g.errors.push(format!("{}: {typ}::{}: the result of alias_{rest} {why}", call.pos, call.name));
                    continue;
                }
                let child = *models.iter().next().unwrap();
                let many = *kinds.iter().next().unwrap();
                g.relation_getter(gi, child, many, &r, rest);
                continue;
            }
            let typ = g.models[gi].typ.clone();
            g.fail(&r, format!("{typ} has no method {}: no call attaches {rest:?}", call.name));
        }
    }
    if !g.errors.is_empty() {
        g.errors.sort();
        g.errors.dedup();
        return Err(g.errors.join("\n"));
    }
    Ok(emit(&g, &set.manifest_hash, manifest_file))
}

fn emit(g: &Gen<'_>, manifest_hash: &str, manifest_file: &str) -> String {
    let mut b = String::new();
    b.push_str("// Code generated by orm-build; DO NOT EDIT.\n\n");
    let _ = writeln!(b, "/// The manifestHash of the document set the models were generated from.\npub const MANIFEST_HASH: &str = {manifest_hash:?};\n");
    let _ = writeln!(
        b,
        "/// The manifest text of the document set the models were generated from.\npub static SCHEMA: orm::Schema = orm::Schema::new(include_str!({manifest_file:?}), MANIFEST_HASH);\n"
    );
    b.push_str(
        "/// Connects to the database selected by the DSN URI and registers the set of these models on the connection.\npub async fn connect(dsn: &str, pool_size: u32, cfg: orm::Config) -> orm::Result<orm::Db> {\n    orm::Db::connect_schema(dsn, &SCHEMA, pool_size, cfg).await\n}\n\n",
    );
    for gm in &g.models {
        let _ = writeln!(b, "pub use {}::{};", gm.module, gm.typ);
    }
    for c in &g.owners {
        let tr = has_trait(c);
        let _ = writeln!(b, "\n/// A model with the column {c}.\npub trait {tr}: orm::Model {{}}");
        for gm in &g.models {
            if gm.e.field(c).is_some() {
                let _ = writeln!(b, "impl {tr} for {} {{}}", gm.typ);
            }
        }
    }
    for gm in &g.models {
        let _ = writeln!(b, "\n/// The {} model.\npub mod {} {{", gm.e.name, gm.module);
        b.push_str(&model_source(gm));
        b.push_str("}\n");
    }
    b
}

const FIXED_CODE: &str = include_str!("fixed.rs.txt");

fn model_source(gm: &Model<'_>) -> String {
    let (e, t) = (gm.e, gm.typ.as_str());
    let mut b = String::new();
    let _ = write!(b, "/// A {} model or row.\n#[derive(Clone)]\npub struct {t} {{\n    __orm: orm::Core,\n", e.name);
    for c in &e.fields {
        let _ = writeln!(b, "    {}: {},", ident(&c.name), field(c));
    }
    b.push_str("}\n\n");
    let _ = write!(
        b,
        "/// The descriptor of {t}.\npub static ENTITY: orm::Entity = orm::Entity {{\n    name: {:?},\n    schema: &super::SCHEMA,\n    new: orm::model::new_boxed::<{t}>,\n    collect: orm::model::collect_boxed::<{t}>,\n}};\n\n",
        e.name
    );
    let _ = writeln!(b, "impl orm::Model for {t} {{");
    b.push_str("    fn entity() -> &'static orm::Entity {\n        &ENTITY\n    }\n\n");
    b.push_str("    fn core(&self) -> &orm::Core {\n        &self.__orm\n    }\n\n");
    b.push_str("    fn core_mut(&mut self) -> &mut orm::Core {\n        &mut self.__orm\n    }\n\n");
    let _ = write!(b, "    fn from_core(core: orm::Core) -> Self {{\n        {t} {{\n            __orm: core,\n");
    for c in &e.fields {
        let init = if c.nullable {
            "None"
        } else if base(c) == ORDERED {
            "orm::ordered_json::Value::null()"
        } else {
            "Default::default()"
        };
        let _ = writeln!(b, "            {}: {init},", ident(&c.name));
    }
    b.push_str("        }\n    }\n\n");
    b.push_str("    fn into_core(self) -> orm::Core {\n        self.__orm\n    }\n\n");
    b.push_str("    #[allow(unused_mut)]\n    fn assign(&mut self, name: &str, mut v: orm::Val) -> orm::Result<bool> {\n        match name {\n");
    for c in &e.fields {
        let (bt, id) = (base(c), ident(&c.name));
        let conversion = match c.ty {
            Type::Decimal(precision, scale) if c.codec.is_empty() => format!("orm::decimal::decode(v, {precision}, {scale})?"),
            _ => convert(bt).to_owned(),
        };
        if field(c) != bt {
            let _ = writeln!(b, "            {:?} => self.{id} = if v.is_null() {{ None }} else {{ Some({conversion}) }},", c.name);
        } else {
            let _ = writeln!(b, "            {:?} => self.{id} = {conversion},", c.name);
        }
    }
    b.push_str("            _ => return Ok(false),\n        }\n        self.__orm.mark_field_ready(name);\n        Ok(true)\n    }\n\n");
    b.push_str("    fn value(&self, name: &str) -> Option<orm::Val> {\n        if !self.__orm.field_ready(name) { return None; }\n        Some(match name {\n");
    for c in &e.fields {
        let (bt, id) = (base(c), ident(&c.name));
        if field(c) != bt {
            let x = if copy_type(bt) { "*x" } else { "x" };
            let _ = writeln!(
                b,
                "            {:?} => match &self.{id} {{\n                None => orm::Val::Null,\n                Some(x) => {},\n            }},",
                c.name,
                to_val(bt, x)
            );
        } else {
            let _ = writeln!(b, "            {:?} => {},", c.name, to_val(bt, &format!("self.{id}")));
        }
    }
    b.push_str("            _ => return None,\n        })\n    }\n}\n\n");
    let _ = write!(
        b,
        "impl<M> orm::GroupArg<M> for &{t} {{\n    fn apply(self, conn: &'static str, core: &mut orm::Core) {{\n        core.place(conn, self.__orm.id());\n    }}\n}}\n\n"
    );
    let _ = write!(
        b,
        "impl orm::serde::Serialize for {t} {{\n    fn serialize<S: orm::serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {{\n        orm::serde::Serialize::serialize(&orm::model::raw_json(orm::model::to_json(self)).map_err(orm::serde::ser::Error::custom)?, s)\n    }}\n}}\n\n"
    );
    b.push_str(&FIXED_CODE.replacen("impl T {", &format!("impl {t} {{"), 1));
    for c in &e.fields {
        let (bt, fd, id, col) = (base(c), field(c), ident(&c.name), c.name.as_str());
        b.push('\n');
        if c.styled_value() {
            let value = if c.nullable {
                format!("match &self.{id} {{ None => orm::StyledValue::SqlNull, Some(value) => orm::StyledValue::Value(value.clone()) }}")
            } else {
                format!("orm::StyledValue::Value(self.{id}.clone())")
            };
            let _ = write!(b, "    /// Returns the selected or assigned styled value of {col}.\n    pub fn get_{col}(&self) -> orm::Result<orm::StyledValue<{bt}>> {{\n        self.__orm.require_field({col:?})?;\n        Ok({value})\n    }}\n\n");
        } else if fd != bt && copy_type(bt) {
            let _ = write!(b, "    /// Returns {col} after checking that it was loaded or assigned.\n    pub fn get_{col}(&self) -> orm::Result<{fd}> {{\n        self.__orm.require_field({col:?})?;\n        Ok(self.{id})\n    }}\n\n");
        } else if fd != bt {
            let r = if bt == "Vec<u8>" {
                "&[u8]"
            } else if bt == "String" {
                "&str"
            } else {
                bt
            };
            let access = if bt == "Vec<u8>" || bt == "String" { "as_deref" } else { "as_ref" };
            let _ = write!(b, "    /// Returns {col} after checking that it was loaded or assigned.\n    pub fn get_{col}(&self) -> orm::Result<Option<{r}>> {{\n        self.__orm.require_field({col:?})?;\n        Ok(self.{id}.{access}())\n    }}\n\n");
        } else if copy_type(bt) {
            let _ = write!(b, "    /// Returns {col} after checking that it was loaded or assigned.\n    pub fn get_{col}(&self) -> orm::Result<{bt}> {{\n        self.__orm.require_field({col:?})?;\n        Ok(self.{id})\n    }}\n\n");
        } else if bt == "String" {
            let _ = write!(b, "    /// Returns {col} after checking that it was loaded or assigned.\n    pub fn get_{col}(&self) -> orm::Result<&str> {{\n        self.__orm.require_field({col:?})?;\n        Ok(&self.{id})\n    }}\n\n");
        } else if bt == "Vec<u8>" {
            let _ = write!(b, "    /// Returns {col} after checking that it was loaded or assigned.\n    pub fn get_{col}(&self) -> orm::Result<&[u8]> {{\n        self.__orm.require_field({col:?})?;\n        Ok(&self.{id})\n    }}\n\n");
        } else {
            let _ = write!(b, "    /// Returns {col} after checking that it was loaded or assigned.\n    pub fn get_{col}(&self) -> orm::Result<&{bt}> {{\n        self.__orm.require_field({col:?})?;\n        Ok(&self.{id})\n    }}\n\n");
        }
        if c.styled_value() {
            let store = if bt == ORDERED { "set_ordered" } else { "set_json" };
            let sql_null = if c.nullable {
                format!("self.__orm.set({col:?}, orm::Param::Null);\n                self.{id} = None;")
            } else {
                format!("return Err(orm::Error::Engine {{ code: orm::codes::CODEC_ENCODE.into(), msg: \"{col} does not accept SQL NULL\".into() }});")
            };
            let field_value = if c.nullable { "Some(value)" } else { "value" };
            let _ = write!(
                b,
                "    /// Sets {col} with an explicit SQL NULL or decoded value.\n    pub fn set_{col}(mut self, v: orm::StyledValue<{bt}>) -> orm::Result<Self> {{\n        match v {{\n            orm::StyledValue::SqlNull => {{\n                {sql_null}\n            }}\n            orm::StyledValue::Value(value) => {{\n                self.__orm.{store}({col:?}, value.clone());\n                self.{id} = {field_value};\n            }}\n        }}\n        self.__orm.mark_field_ready({col:?});\n        Ok(self)\n    }}\n\n"
            );
        } else if let Type::Decimal(precision, scale) = c.ty {
            if c.nullable {
                let _ = write!(b, "    /// Sets {col} after exact decimal validation.\n    pub fn set_{col}(mut self, v: impl orm::IntoNullable<String>) -> orm::Result<Self> {{\n        let value = v.into_nullable();\n        let value = match value {{ Some(text) => Some(orm::decimal::normalize(&text, {precision}, {scale})?), None => None }};\n        self.__orm.set({col:?}, value.clone().into());\n        self.{id} = value;\n        self.__orm.mark_field_ready({col:?});\n        Ok(self)\n    }}\n\n");
            } else {
                let _ = write!(b, "    /// Sets {col} after exact decimal validation.\n    pub fn set_{col}(mut self, v: impl Into<String>) -> orm::Result<Self> {{\n        let value = orm::decimal::normalize(&v.into(), {precision}, {scale})?;\n        self.__orm.set({col:?}, value.clone().into());\n        self.{id} = value;\n        self.__orm.mark_field_ready({col:?});\n        Ok(self)\n    }}\n\n");
            }
        } else if fd != bt {
            let _ = write!(
                b,
                "    /// Sets {col}; None or Null stores NULL.\n    pub fn set_{col}(mut self, v: impl orm::IntoNullable<{bt}>) -> Self {{\n        let v = v.into_nullable();\n        self.__orm.set({col:?}, v.clone().into());\n        self.{id} = v;\n        self.__orm.mark_field_ready({col:?});\n        self\n    }}\n\n"
            );
        } else {
            let _ = write!(
                b,
                "    /// Sets {col}.\n    pub fn set_{col}(mut self, v: impl Into<{bt}>) -> Self {{\n        let v: {bt} = v.into();\n        self.__orm.set({col:?}, v.clone().into());\n        self.{id} = v;\n        self.__orm.mark_field_ready({col:?});\n        self\n    }}\n\n"
            );
        }
        let _ = write!(
            b,
            "    /// Sets {col} from a SQL expression.\n    pub fn set_raw_{col}(mut self, sql: &str, binds: impl orm::Binds) -> Self {{\n        self.__orm.set_raw({col:?}, sql, binds.into_binds());\n        self\n    }}\n\n"
        );
        let _ = write!(b, "    /// Adds the column {col}.\n    pub fn add_column_{col}(mut self) -> Self {{\n        self.__orm.add_column({col:?});\n        self\n    }}\n\n");
        let _ = write!(b, "    /// Removes the column {col}.\n    pub fn remove_column_{col}(mut self) -> Self {{\n        self.__orm.remove_column({col:?});\n        self\n    }}\n\n");
        let _ = write!(
            b,
            "    /// Groups by {col}.\n    pub fn group_by_{col}(mut self) -> Self {{\n        self.__orm.group_by({col:?});\n        self\n    }}\n\n"
        );
        let _ = writeln!(b, "    /// Keys the collection by {col}.\n    pub fn key_name_{col}(mut self) -> Self {{\n        self.__orm.key_name({col:?});\n        self\n    }}");
        for dir in ["asc", "desc"] {
            let name = format!("order_by_{col}_{dir}");
            let desc = dir == "desc";
            if gm.order_fn.get(&name).copied().unwrap_or(false) {
                let _ = writeln!(
                    b,
                    "\n    /// Orders by a column function of {col}.\n    pub fn {name}(mut self, f: orm::Func) -> Self {{\n        self.__orm.order_by({col:?}, {desc}, Some(f));\n        self\n    }}"
                );
            } else {
                let _ = writeln!(
                    b,
                    "\n    /// Orders by {col}.\n    pub fn {name}(mut self) -> Self {{\n        self.__orm.order_by({col:?}, {desc}, None);\n        self\n    }}"
                );
            }
        }
        if numeric(c) {
            let _ = writeln!(b, "\n    /// Adds n to {col}.\n    pub fn plus_{col}(mut self, n: {bt}) -> Self {{\n        self.__orm.plus({col:?}, n.into());\n        self\n    }}");
            let _ = writeln!(b, "\n    /// Subtracts n from {col}.\n    pub fn minus_{col}(mut self, n: {bt}) -> Self {{\n        self.__orm.minus({col:?}, n.into());\n        self\n    }}");
            let _ = writeln!(b, "\n    /// Selects the sum of {col} for get_sum.\n    pub fn sum_{col}(mut self) -> Self {{\n        self.__orm.aggregate(\"sum\", {col:?});\n        self\n    }}");
            let _ = writeln!(b, "\n    /// Selects the average of {col} for get_avg.\n    pub fn avg_{col}(mut self) -> Self {{\n        self.__orm.aggregate(\"avg\", {col:?});\n        self\n    }}");
        }
    }
    for name in index_names(e) {
        let _ = writeln!(
            b,
            "\n    /// Adds the index hint {name}.\n    pub fn force_index_{}(mut self) -> Self {{\n        self.__orm.force_index({name:?});\n        self\n    }}",
            index_method(name)
        );
    }
    for (_, code) in gm.methods.values() {
        b.push('\n');
        b.push_str(code);
    }
    for (name, gt) in &gm.getters {
        let _ = writeln!(b, "\n    /// Returns {}.\n    pub fn {name}(&self) -> {} {{\n        {}\n    }}", gt.origin, gt.result, gt.expr);
    }
    b.push_str("}\n");
    b
}
