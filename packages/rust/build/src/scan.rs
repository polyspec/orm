//! Reads the method calls of the scanned source files. A call's receiver
//! model is resolved from the source where it is visible: `Model::new()`,
//! typed parameters and bindings, closures that return a model, and chains of
//! model methods. Calls whose receiver cannot be resolved apply to every model
//! whose schema accepts them.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use syn::ext::IdentExt;
use syn::visit::{self, Visit};
use syn::{Expr, FnArg, Pat, Type};

/// One method call of the scanned source.
pub struct Call {
    pub name: String,
    pub args: Vec<Expr>,
    /// The model type of the receiver, when the source shows it.
    pub model: Option<String>,
    pub pos: String,
    /// For a call inside the argument of relation, relations, or a join:
    /// whether the innermost such call attaches a collection.
    pub attached_many: Option<bool>,
}

/// A variable passed to relation, relations, or a join whose initializer
/// named aliases.
pub struct AliasUse {
    pub alias: String,
    pub many: bool,
}

#[derive(Default)]
pub struct Scan {
    pub calls: Vec<Call>,
    pub alias_uses: Vec<AliasUse>,
    pub files: Vec<PathBuf>,
}

/// Methods that do not return the model they are called on.
const TERMINALS: &[&str] = &[
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
    "restore",
    "restore_or_create",
    "to_array",
    "to_json",
];

pub fn returns_model(name: &str) -> bool {
    !TERMINALS.contains(&name) && !name.starts_with("get_") && !name.starts_with("gets_by_")
}

/// Whether a method attaches its argument to the calling model, and whether as
/// a collection.
pub fn attaches(name: &str) -> Option<bool> {
    match name {
        "relation" => Some(false),
        "relations" => Some(true),
        n if n.starts_with("join_") || n.starts_with("left_join_") => Some(false),
        _ => None,
    }
}

/// The model of a receiver that is another set's class (DSL-151): its calls are not this set's, so the scan records none.
const FOREIGN: &str = "<another set>";

#[derive(Clone, Default)]
struct Binding {
    model: Option<String>,
    aliases: Vec<String>,
    result: bool,
}

struct Scanner<'a> {
    models: &'a HashSet<String>,
    /// The modules that include another set's model file (DSL-151): a model reached through one is not this set's.
    foreign: &'a HashSet<String>,
    /// The names that a `use` of this file binds to a model of a foreign module.
    hidden: HashSet<String>,
    fallible_setters: &'a HashSet<(String, String)>,
    file: String,
    scopes: Vec<HashMap<String, Binding>>,
    attached: Vec<bool>,
    out: &'a mut Scan,
}

/// Scans the files of `paths`. `model_file` is the model file this generation writes, which tells this set's model module
/// from the modules that include another set's model file.
pub fn scan(paths: &[PathBuf], models: &HashSet<String>, fallible_setters: &HashSet<(String, String)>, model_file: &Path) -> Result<Scan, String> {
    let mut out = Scan::default();
    let mut files = Vec::new();
    for p in paths {
        collect_files(p, &mut files)?;
    }
    files.sort();
    let mut parsed = Vec::new();
    for f in &files {
        let text = std::fs::read_to_string(f).map_err(|e| format!("{}: {e}", f.display()))?;
        let ast = syn::parse_file(&text).map_err(|e| {
            let at = e.span().start();
            format!("{}:{}:{}: {e}", f.display(), at.line, at.column + 1)
        })?;
        parsed.push(ast);
    }
    let mut own = HashSet::new();
    let mut foreign = HashSet::new();
    for (f, ast) in files.iter().zip(&parsed) {
        let stem = match f.file_stem().and_then(|n| n.to_str()) {
            Some("mod") => f.parent().and_then(|d| d.file_name()).and_then(|n| n.to_str()).unwrap_or(""),
            Some(stem) => stem,
            None => "",
        };
        model_modules(f, stem, &ast.items, &normalize(model_file), &mut own, &mut foreign);
    }
    let foreign: HashSet<String> = foreign.difference(&own).cloned().collect();
    for (f, ast) in files.iter().zip(&parsed) {
        let mut uses = Uses { models, foreign: &foreign, hidden: HashSet::new() };
        uses.visit_file(ast);
        let mut s = Scanner {
            models,
            foreign: &foreign,
            hidden: uses.hidden,
            fallible_setters,
            file: f.display().to_string(),
            scopes: vec![HashMap::new()],
            attached: Vec::new(),
            out: &mut out,
        };
        s.visit_file(ast);
    }
    out.files = files;
    Ok(out)
}

/// The path with `.` and `..` removed lexically, as `include!` joins its argument to the including file's folder.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

/// The file that an `include!` names, when it names a model file (`orm_model.rs`): its string literals joined, after the value
/// of an `env!` it starts with, or relative to the folder of the including file. An `env!` variable that is not set leaves
/// the folder unknown; the path is then the literal part, which matches the model file by its tail.
fn included_file(file: &Path, tokens: &proc_macro2::TokenStream) -> Option<(PathBuf, bool)> {
    fn walk(tokens: proc_macro2::TokenStream, env: &mut Option<String>, text: &mut String) {
        let mut previous_env = false;
        for tree in tokens {
            match tree {
                proc_macro2::TokenTree::Ident(i) => previous_env = i == "env",
                proc_macro2::TokenTree::Group(g) if previous_env => {
                    let mut name = String::new();
                    walk(g.stream(), &mut None, &mut name);
                    *env = Some(name);
                    previous_env = false;
                }
                proc_macro2::TokenTree::Group(g) => walk(g.stream(), env, text),
                proc_macro2::TokenTree::Literal(l) => {
                    if let Ok(lit) = syn::parse_str::<syn::LitStr>(&l.to_string()) {
                        text.push_str(&lit.value());
                    }
                }
                proc_macro2::TokenTree::Punct(p) => previous_env = previous_env && p.as_char() == '!',
            }
        }
    }
    let mut env = None;
    let mut text = String::new();
    walk(tokens.clone(), &mut env, &mut text);
    if !text.ends_with(crate::MODEL_FILE) {
        return None;
    }
    let tail = text.trim_start_matches('/');
    Some(match env {
        Some(name) => match std::env::var_os(&name) {
            Some(dir) => (normalize(&PathBuf::from(dir).join(tail)), true),
            None => (normalize(Path::new(tail)), false),
        },
        None => (normalize(&file.parent().unwrap_or(Path::new("")).join(&text)), true),
    })
}

/// Collects the model modules of `items`: an inline module or a file whose items `include!` a model file, and `models!()`,
/// which includes `OUT_DIR/orm_model.rs` as the module `model`. A module that includes `model_file` is this set's (`own`);
/// one that includes another model file is another set's (`foreign`).
fn model_modules(file: &Path, name: &str, items: &[syn::Item], model_file: &Path, own: &mut HashSet<String>, foreign: &mut HashSet<String>) {
    for item in items {
        match item {
            syn::Item::Mod(m) => {
                if let Some((_, content)) = &m.content {
                    model_modules(file, &m.ident.unraw().to_string(), content, model_file, own, foreign);
                }
            }
            syn::Item::Macro(m) => {
                let included = if m.mac.path.is_ident("include") {
                    included_file(file, &m.mac.tokens).map(|found| (name.to_owned(), found))
                } else if m.mac.path.segments.last().is_some_and(|s| s.ident == "models") && m.mac.tokens.is_empty() {
                    let out = std::env::var_os("OUT_DIR").map(|dir| normalize(&PathBuf::from(dir).join(crate::MODEL_FILE)));
                    Some(("model".to_owned(), out.map_or_else(|| (PathBuf::from(crate::MODEL_FILE), false), |p| (p, true))))
                } else {
                    None
                };
                if let Some((module, (path, whole))) = included {
                    if module.is_empty() {
                        continue;
                    }
                    let same = if whole { path == model_file } else { model_file.ends_with(&path) };
                    if same {
                        own.insert(module)
                    } else {
                        foreign.insert(module)
                    };
                }
            }
            _ => {}
        }
    }
}

/// Collects the names that the `use` items of a file bind to a model of a foreign module: `use a::foreign::Model`, `use
/// a::foreign::{Model as Other}` and `use a::foreign::*`.
struct Uses<'a> {
    models: &'a HashSet<String>,
    foreign: &'a HashSet<String>,
    hidden: HashSet<String>,
}

impl Uses<'_> {
    fn tree(&mut self, tree: &syn::UseTree, last: Option<String>) {
        let from_foreign = last.as_ref().is_some_and(|m| self.foreign.contains(m));
        match tree {
            syn::UseTree::Path(p) => self.tree(&p.tree, Some(p.ident.unraw().to_string())),
            syn::UseTree::Name(n) => {
                let name = n.ident.unraw().to_string();
                if from_foreign && self.models.contains(&name) {
                    self.hidden.insert(name);
                }
            }
            syn::UseTree::Rename(r) => {
                if from_foreign && self.models.contains(&r.ident.unraw().to_string()) {
                    self.hidden.insert(r.rename.unraw().to_string());
                }
            }
            syn::UseTree::Glob(_) => {
                if from_foreign {
                    self.hidden.extend(self.models.iter().cloned());
                }
            }
            syn::UseTree::Group(g) => {
                for t in &g.items {
                    self.tree(t, last.clone());
                }
            }
        }
    }
}

impl<'ast> Visit<'ast> for Uses<'_> {
    fn visit_item_use(&mut self, u: &'ast syn::ItemUse) {
        self.tree(&u.tree, None);
    }
}

fn collect_files(p: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let meta = std::fs::metadata(p).map_err(|e| format!("scan {}: {e}", p.display()))?;
    if meta.is_file() {
        if p.extension().map(|x| x == "rs").unwrap_or(false) {
            out.push(p.to_path_buf());
        }
        return Ok(());
    }
    let entries = std::fs::read_dir(p).map_err(|e| format!("scan {}: {e}", p.display()))?;
    for entry in entries {
        let path = entry.map_err(|e| format!("scan {}: {e}", p.display()))?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name == "target" {
            continue;
        }
        if path.is_dir() || path.extension().map(|x| x == "rs").unwrap_or(false) {
            collect_files(&path, out)?;
        }
    }
    Ok(())
}

/// The names that a pattern binds, in any position of it: a tuple, struct, slice or reference pattern binds each of its names.
fn pattern_names(p: &Pat) -> Vec<String> {
    struct Names(Vec<String>);
    impl<'ast> Visit<'ast> for Names {
        fn visit_pat_ident(&mut self, i: &'ast syn::PatIdent) {
            self.0.push(i.ident.unraw().to_string());
            visit::visit_pat_ident(self, i);
        }
    }
    let mut names = Names(Vec::new());
    names.visit_pat(p);
    names.0
}

fn pat_ident(p: &Pat) -> Option<(String, Option<&Type>)> {
    match p {
        Pat::Ident(i) => Some((i.ident.unraw().to_string(), None)),
        Pat::Type(t) => pat_ident(&t.pat).map(|(n, _)| (n, Some(&*t.ty))),
        _ => None,
    }
}

/// The variable an argument names: `x`, `&x`, or `x.clone()`.
fn arg_var(e: &Expr) -> Option<String> {
    match e {
        Expr::Path(p) if p.path.segments.len() == 1 => Some(p.path.segments[0].ident.unraw().to_string()),
        Expr::Reference(r) => arg_var(&r.expr),
        Expr::Paren(p) => arg_var(&p.expr),
        Expr::MethodCall(m) if m.method == "clone" && m.args.is_empty() => arg_var(&m.receiver),
        _ => None,
    }
}

/// The alias names an expression sets.
fn aliases_in(e: &Expr) -> Vec<String> {
    struct Finder(Vec<String>);
    impl<'ast> Visit<'ast> for Finder {
        fn visit_expr_method_call(&mut self, m: &'ast syn::ExprMethodCall) {
            let name = m.method.unraw().to_string();
            if let Some(alias) = name.strip_prefix("alias_") {
                self.0.push(alias.to_owned());
            }
            visit::visit_expr_method_call(self, m);
        }
    }
    let mut f = Finder(Vec::new());
    f.visit_expr(e);
    f.0
}

impl Scanner<'_> {
    /// Whether a path that ends in a model class names this set's class: not through a foreign module, and not a name that a
    /// `use` of the file binds to a foreign module's model (DSL-151).
    fn own_path(&self, segments: &[String]) -> bool {
        match segments {
            [.., module, _] => !self.foreign.contains(module) && !self.hidden.contains(module),
            [name] => !self.hidden.contains(name),
            [] => true,
        }
    }

    fn lookup(&self, name: &str) -> Option<&Binding> {
        self.scopes.iter().rev().find_map(|s| s.get(name))
    }

    fn bind(&mut self, name: String, b: Binding) {
        self.scopes.last_mut().expect("scope").insert(name, b);
    }

    /// Binds every name of a pattern that gives no model, so that it hides an outer binding of the same name.
    fn bind_pattern(&mut self, p: &Pat) {
        for name in pattern_names(p) {
            self.bind(name, Binding::default());
        }
    }

    /// Whether the type wraps its model in an Option, whose `unwrap` and `expect` give the model; Box, Rc and Arc
    /// dereference to it, so their calls are the model's.
    fn optional(t: &Type) -> bool {
        match t {
            Type::Reference(r) => Self::optional(&r.elem),
            Type::Paren(p) => Self::optional(&p.elem),
            Type::Path(p) => p.path.segments.last().is_some_and(|s| s.ident == "Option"),
            _ => false,
        }
    }

    fn type_name(&self, t: &Type) -> Option<String> {
        match t {
            Type::Reference(r) => self.type_name(&r.elem),
            Type::Paren(p) => self.type_name(&p.elem),
            Type::Path(p) => {
                let last = p.path.segments.last()?;
                let name = last.ident.to_string();
                let segments: Vec<String> = p.path.segments.iter().map(|s| s.ident.unraw().to_string()).collect();
                if !self.own_path(&segments) {
                    return Some(FOREIGN.to_owned());
                }
                if self.models.contains(&name) {
                    return Some(name);
                }
                // A model read through a getter is typed with its wrapper: Option<User>, Box<User>, Rc<User>, Arc<User>.
                if !matches!(name.as_str(), "Option" | "Box" | "Rc" | "Arc") {
                    return None;
                }
                match &last.arguments {
                    syn::PathArguments::AngleBracketed(a) if a.args.len() == 1 => match &a.args[0] {
                        syn::GenericArgument::Type(t) => self.type_name(t),
                        _ => None,
                    },
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn result_of(&self, expression: &Expr) -> bool {
        match expression {
            Expr::MethodCall(call) => {
                let name = call.method.unraw().to_string();
                self.model_of(&call.receiver).is_some_and(|model| self.fallible_setters.contains(&(model, name.clone())))
                    || (matches!(name.as_str(), "map_err" | "map") && self.result_of(&call.receiver))
            }
            Expr::Path(path) if path.path.segments.len() == 1 => {
                self.lookup(&path.path.segments[0].ident.unraw().to_string()).is_some_and(|binding| binding.result)
            }
            Expr::Reference(reference) => self.result_of(&reference.expr),
            Expr::Paren(paren) => self.result_of(&paren.expr),
            Expr::Group(group) => self.result_of(&group.expr),
            _ => false,
        }
    }

    fn model_of(&self, e: &Expr) -> Option<String> {
        match e {
            Expr::Call(c) => match &*c.func {
                Expr::Path(p) => {
                    let segs: Vec<String> = p.path.segments.iter().map(|s| s.ident.to_string()).collect();
                    match segs.as_slice() {
                        // A class of a foreign module, by its path or by the name a `use` gives it, is another set's.
                        [.., module, _, new] if new == "new" && self.foreign.contains(module) => Some(FOREIGN.to_owned()),
                        [name, new] if new == "new" && self.hidden.contains(name) => Some(FOREIGN.to_owned()),
                        [.., model, new] if new == "new" && self.models.contains(model) => {
                            Some(if self.own_path(&segs[..segs.len() - 1]) { model.clone() } else { FOREIGN.to_owned() })
                        }
                        [var] => self.lookup(var).and_then(|b| b.model.clone()),
                        _ => None,
                    }
                }
                _ => None,
            },
            Expr::MethodCall(m) => {
                let name = m.method.unraw().to_string();
                if self.result_of(&m.receiver) {
                    return match name.as_str() {
                        "map_err" | "unwrap" | "expect" => self.model_of(&m.receiver),
                        _ => None,
                    };
                }
                // A getter `get_<name>::<T>()` returns the value its one type argument declares, so the receiver of a
                // later call typed through it resolves to that model.
                if name.starts_with("get_") {
                    if let Some(t) = m.turbofish.as_ref().filter(|t| t.args.len() == 1) {
                        if let syn::GenericArgument::Type(ty) = &t.args[0] {
                            if let Some(model) = self.type_name(ty) {
                                return Some(model);
                            }
                        }
                    }
                }
                if name == "clone" || returns_model(&name) {
                    self.model_of(&m.receiver)
                } else {
                    None
                }
            }
            Expr::Try(tried) => self.model_of(&tried.expr),
            Expr::Reference(r) => self.model_of(&r.expr),
            Expr::Paren(p) => self.model_of(&p.expr),
            Expr::Group(g) => self.model_of(&g.expr),
            Expr::Closure(c) => self.model_of(&c.body),
            Expr::Path(p) if p.path.segments.len() == 1 => self.lookup(&p.path.segments[0].ident.unraw().to_string()).and_then(|b| b.model.clone()),
            _ => None,
        }
    }

    fn pos(&self, span: proc_macro2::Span) -> String {
        let at = span.start();
        format!("{}:{}:{}", self.file, at.line, at.column + 1)
    }

    fn bind_params<'p>(&mut self, params: impl Iterator<Item = &'p Pat>) {
        for p in params {
            if let Some((name, ty)) = pat_ident(p) {
                let model = ty.and_then(|t| self.type_name(t));
                let result = ty.is_some_and(Self::optional);
                self.bind(name, Binding { model, aliases: Vec::new(), result });
            } else {
                self.bind_pattern(p);
            }
        }
    }
}

impl Scanner<'_> {
    /// Visits the calls of a macro body: its comma-separated expressions or
    /// statements when the body parses, otherwise the `.name(…)` token
    /// sequences it contains.
    fn visit_macro_body(&mut self, tokens: &proc_macro2::TokenStream) {
        use syn::parse::Parser;
        type Exprs = syn::punctuated::Punctuated<Expr, syn::Token![,]>;
        if let Ok(exprs) = Exprs::parse_terminated.parse2(tokens.clone()) {
            for e in &exprs {
                self.visit_expr(e);
            }
            return;
        }
        if let Ok(stmts) = syn::Block::parse_within.parse2(tokens.clone()) {
            self.scopes.push(HashMap::new());
            for st in &stmts {
                self.visit_stmt(st);
            }
            self.scopes.pop();
            return;
        }
        self.visit_tokens(tokens);
    }

    fn visit_tokens(&mut self, tokens: &proc_macro2::TokenStream) {
        use proc_macro2::{Delimiter, TokenTree};
        let trees: Vec<TokenTree> = tokens.clone().into_iter().collect();
        for (i, t) in trees.iter().enumerate() {
            match t {
                TokenTree::Punct(p) if p.as_char() == '.' => {
                    let (Some(TokenTree::Ident(name)), Some(TokenTree::Group(g))) = (trees.get(i + 1), trees.get(i + 2)) else { continue };
                    if g.delimiter() != Delimiter::Parenthesis {
                        continue;
                    }
                    use syn::parse::Parser;
                    type Exprs = syn::punctuated::Punctuated<Expr, syn::Token![,]>;
                    let args: Vec<Expr> = Exprs::parse_terminated.parse2(g.stream()).map(|a| a.into_iter().collect()).unwrap_or_default();
                    let name = name.unraw().to_string();
                    self.out.calls.push(Call { name, args, model: None, pos: self.pos(g.span()), attached_many: self.attached.last().copied() });
                }
                TokenTree::Group(g) => self.visit_macro_body(&g.stream()),
                _ => {}
            }
        }
    }
}

impl<'ast> Visit<'ast> for Scanner<'_> {
    fn visit_macro(&mut self, m: &'ast syn::Macro) {
        if m.path.is_ident("macro_rules") {
            return;
        }
        self.visit_macro_body(&m.tokens);
    }

    fn visit_item_fn(&mut self, f: &'ast syn::ItemFn) {
        // A function item sees no local of the function that contains it, so the scopes of the outer function are set aside.
        let outer = std::mem::take(&mut self.scopes);
        self.scopes.push(HashMap::new());
        let pats: Vec<Pat> = f
            .sig
            .inputs
            .iter()
            .filter_map(|a| match a {
                FnArg::Typed(t) => Some(Pat::Type(t.clone())),
                FnArg::Receiver(_) => None,
            })
            .collect();
        self.bind_params(pats.iter());
        visit::visit_item_fn(self, f);
        self.scopes = outer;
    }

    fn visit_impl_item_fn(&mut self, f: &'ast syn::ImplItemFn) {
        let outer = std::mem::take(&mut self.scopes);
        self.scopes.push(HashMap::new());
        let pats: Vec<Pat> = f
            .sig
            .inputs
            .iter()
            .filter_map(|a| match a {
                FnArg::Typed(t) => Some(Pat::Type(t.clone())),
                FnArg::Receiver(_) => None,
            })
            .collect();
        self.bind_params(pats.iter());
        visit::visit_impl_item_fn(self, f);
        self.scopes = outer;
    }

    fn visit_block(&mut self, b: &'ast syn::Block) {
        self.scopes.push(HashMap::new());
        visit::visit_block(self, b);
        self.scopes.pop();
    }

    fn visit_local(&mut self, l: &'ast syn::Local) {
        if let Some(init) = &l.init {
            self.visit_expr(&init.expr);
            if let Some((_, diverge)) = &init.diverge {
                self.visit_expr(diverge);
            }
        }
        if let Some((name, ty)) = pat_ident(&l.pat) {
            let model = match ty {
                Some(t) => self.type_name(t),
                None => l.init.as_ref().and_then(|i| self.model_of(&i.expr)),
            };
            let aliases = l.init.as_ref().map(|i| aliases_in(&i.expr)).unwrap_or_default();
            let result = ty.is_some_and(Self::optional) || l.init.as_ref().is_some_and(|init| self.result_of(&init.expr));
            self.bind(name, Binding { model, aliases, result });
        } else {
            self.bind_pattern(&l.pat);
        }
    }

    fn visit_expr_for_loop(&mut self, f: &'ast syn::ExprForLoop) {
        self.visit_expr(&f.expr);
        self.scopes.push(HashMap::new());
        self.bind_pattern(&f.pat);
        self.visit_block(&f.body);
        self.scopes.pop();
    }

    fn visit_expr_let(&mut self, l: &'ast syn::ExprLet) {
        self.visit_expr(&l.expr);
        self.bind_pattern(&l.pat);
    }

    /// The bindings of an `if let` condition belong to the then branch only.
    fn visit_expr_if(&mut self, i: &'ast syn::ExprIf) {
        self.scopes.push(HashMap::new());
        self.visit_expr(&i.cond);
        self.visit_block(&i.then_branch);
        self.scopes.pop();
        if let Some((_, otherwise)) = &i.else_branch {
            self.visit_expr(otherwise);
        }
    }

    fn visit_expr_while(&mut self, w: &'ast syn::ExprWhile) {
        self.scopes.push(HashMap::new());
        self.visit_expr(&w.cond);
        self.visit_block(&w.body);
        self.scopes.pop();
    }

    fn visit_arm(&mut self, a: &'ast syn::Arm) {
        self.scopes.push(HashMap::new());
        self.bind_pattern(&a.pat);
        if let Some((_, guard)) = &a.guard {
            self.visit_expr(guard);
        }
        self.visit_expr(&a.body);
        self.scopes.pop();
    }

    fn visit_expr_closure(&mut self, c: &'ast syn::ExprClosure) {
        self.scopes.push(HashMap::new());
        self.bind_params(c.inputs.iter());
        self.visit_expr(&c.body);
        self.scopes.pop();
    }

    fn visit_expr_method_call(&mut self, m: &'ast syn::ExprMethodCall) {
        let name = m.method.unraw().to_string();
        self.visit_expr(&m.receiver);
        if self.result_of(&m.receiver) {
            for argument in &m.args {
                self.visit_expr(argument);
            }
            return;
        }
        let model = self.model_of(&m.receiver);
        if model.as_deref() == Some(FOREIGN) {
            for argument in &m.args {
                self.visit_expr(argument);
            }
            return;
        }
        let call = Call {
            name: name.clone(),
            args: m.args.iter().cloned().collect(),
            model,
            pos: self.pos(m.method.span()),
            attached_many: self.attached.last().copied(),
        };
        self.out.calls.push(call);
        match attaches(&name) {
            Some(many) => {
                if m.args.len() == 1 {
                    if let Some(var) = arg_var(&m.args[0]) {
                        let aliases = self.lookup(&var).map(|b| b.aliases.clone()).unwrap_or_default();
                        for alias in aliases {
                            self.out.alias_uses.push(AliasUse { alias, many });
                        }
                    }
                }
                self.attached.push(many);
                for a in &m.args {
                    self.visit_expr(a);
                }
                self.attached.pop();
            }
            None => {
                for a in &m.args {
                    self.visit_expr(a);
                }
            }
        }
    }
}
