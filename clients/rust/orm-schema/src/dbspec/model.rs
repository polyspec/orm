//! The parsed dbspec model. Every name keeps the position of its token so that
//! validation can point at it; emission ignores positions.

use super::literal::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Pos {
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct Name {
    pub text: String,
    pub pos: Pos,
}

/// A parsed dbspec document: the header name, `use` lines, tables and diagrams
/// with their attached comments.
#[derive(Clone, Debug)]
pub struct Document {
    pub(crate) name: Name,
    pub(crate) uses: Vec<Use>,
    pub(crate) tables: Vec<Table>,
    pub(crate) diagrams: Vec<Diagram>,
    /// Comment lines after the last line of the document.
    pub(crate) trailing: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Use {
    pub comments: Vec<String>,
    pub document: Name,
    pub tables: Vec<Name>,
}

#[derive(Clone, Debug)]
pub(crate) struct Table {
    pub comments: Vec<String>,
    pub name: Name,
    pub columns: Vec<Column>,
    pub primary: Vec<PrimaryKey>,
    pub uniques: Vec<Unique>,
    pub indexes: Vec<Index>,
    pub foreign_keys: Vec<ForeignKey>,
    pub checks: Vec<Check>,
    pub settings: Option<Settings>,
    /// Comment lines before the closing `}`.
    pub closing: Vec<String>,
}

impl Table {
    pub fn column(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.name.text == name)
    }
}

/// column type (docs/dbspec.md, "Types").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Type {
    I16,
    I32,
    I64,
    Bool,
    Decimal(u8, u8),
    F64,
    Varchar(u16),
    Text,
    Bytes,
    Uuid,
    Date,
    Time(u8),
    DateTime(u8),
}

impl Type {
    /// parameter를 뺀 type 이름: `decimal(13,2)`는 `decimal`이다.
    pub fn name(&self) -> &'static str {
        match self {
            Type::I16 => "i16",
            Type::I32 => "i32",
            Type::I64 => "i64",
            Type::Bool => "bool",
            Type::Decimal(..) => "decimal",
            Type::F64 => "f64",
            Type::Varchar(_) => "varchar",
            Type::Text => "text",
            Type::Bytes => "bytes",
            Type::Uuid => "uuid",
            Type::Date => "date",
            Type::Time(_) => "time",
            Type::DateTime(_) => "datetime",
        }
    }

    /// dbspec이 쓰는 type text.
    pub fn render(&self) -> String {
        match self {
            Type::I16 => "i16".into(),
            Type::I32 => "i32".into(),
            Type::I64 => "i64".into(),
            Type::Bool => "bool".into(),
            Type::Decimal(p, s) => format!("decimal({p},{s})"),
            Type::F64 => "f64".into(),
            Type::Varchar(n) => format!("varchar({n})"),
            Type::Text => "text".into(),
            Type::Bytes => "bytes".into(),
            Type::Uuid => "uuid".into(),
            Type::Date => "date".into(),
            Type::Time(p) => format!("time({p})"),
            Type::DateTime(p) => format!("datetime({p})"),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Column {
    pub comments: Vec<String>,
    pub name: Name,
    pub ty: Type,
    pub nullable: bool,
    /// The position of the `identity` token.
    pub identity: Option<Pos>,
    pub default: Option<DefaultValue>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DefaultValue {
    /// `default now` of a `datetime(p)` column.
    Now,
    /// A literal in its canonical text.
    Literal(String),
}

#[derive(Clone, Debug)]
pub(crate) struct PrimaryKey {
    pub comments: Vec<String>,
    /// The position of the `primary` keyword.
    pub pos: Pos,
    pub columns: Vec<Name>,
}

#[derive(Clone, Debug)]
pub(crate) struct Unique {
    pub comments: Vec<String>,
    pub name: Name,
    pub columns: Vec<Name>,
}

#[derive(Clone, Debug)]
pub(crate) struct Index {
    pub comments: Vec<String>,
    pub name: Name,
    /// Columns with their direction; `true` is `desc`.
    pub columns: Vec<(Name, bool)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Restrict,
    Cascade,
    SetNull,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Restrict => "restrict",
            Action::Cascade => "cascade",
            Action::SetNull => "set_null",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ForeignKey {
    pub comments: Vec<String>,
    pub name: Name,
    pub columns: Vec<Name>,
    pub table: Name,
    pub references: Vec<Name>,
    pub on_delete: Action,
    pub on_update: Action,
}

impl ForeignKey {
    /// A `cascade` or `set_null` action on delete or update.
    pub fn changes_rows(&self) -> bool {
        self.on_delete != Action::Restrict || self.on_update != Action::Restrict
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Check {
    pub comments: Vec<String>,
    pub name: Name,
    pub expr: Expr,
}

/// A check predicate (docs/dbspec.md, "Checks").
#[derive(Clone, Debug)]
pub(crate) enum Expr {
    /// `and` or `or`.
    Logic(Box<Expr>, &'static str, Box<Expr>),
    /// A comparison with its operator and the operator position.
    Compare(Operand, &'static str, Pos, Operand),
    /// `<column> [not] in (<literal>, ...)`.
    In(Name, bool, Vec<Literal>),
    /// `<column> is [not] null`.
    IsNull(Name, bool),
}

#[derive(Clone, Debug)]
pub(crate) enum Operand {
    Column(Name),
    Literal(Literal),
}

/// A check literal. `text` is its canonical text in the form of the column it
/// meets; validation sets it, so it is empty until the document is valid.
#[derive(Clone, Debug)]
pub(crate) struct Literal {
    pub value: Value,
    pub pos: Pos,
    pub text: String,
}

impl Expr {
    /// `op` predicate의 한 side인 이 expression이 `and` 안의 `or`이라 괄호가
    /// 필요한지 여부. tree는 그 밖의 괄호를 갖지 않는다.
    pub fn needs_parentheses(&self, op: &str) -> bool {
        op == "and" && matches!(self, Expr::Logic(_, "or", _))
    }

    /// The column references of the expression in source order.
    pub fn columns<'e>(&'e self, out: &mut Vec<&'e Name>) {
        match self {
            Expr::In(name, _, _) | Expr::IsNull(name, _) => out.push(name),
            Expr::Logic(left, _, right) => {
                left.columns(out);
                right.columns(out);
            }
            Expr::Compare(left, _, _, right) => {
                for operand in [left, right] {
                    if let Operand::Column(name) = operand {
                        out.push(name);
                    }
                }
            }
        }
    }

    /// The literals of the expression in source order.
    pub fn literals_mut<'e>(&'e mut self, out: &mut Vec<&'e mut Literal>) {
        match self {
            Expr::IsNull(_, _) => {}
            Expr::Logic(left, _, right) => {
                left.literals_mut(out);
                right.literals_mut(out);
            }
            Expr::Compare(left, _, _, right) => {
                for operand in [left, right] {
                    if let Operand::Literal(literal) = operand {
                        out.push(literal);
                    }
                }
            }
            Expr::In(_, _, list) => out.extend(list.iter_mut()),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Settings {
    pub comments: Vec<String>,
    pub lines: Vec<SettingLine>,
    pub closing: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct SettingLine {
    pub comments: Vec<String>,
    /// The position of the setting keyword.
    pub pos: Pos,
    pub setting: Setting,
}

#[derive(Clone, Debug)]
pub(crate) enum Setting {
    Entity(Name),
    Updated(Name),
    SoftDelete(Name),
    SelectExplicit(Vec<Name>),
    Codec(Name, Vec<Name>),
    AesVersion(Name),
    BlindIndex(Name, Name),
    Navigation(Name, Name, Name),
    Immutable,
    Audit { into: Name, operation: Name, action: Name, previous: Name },
}

impl Setting {
    /// The canonical position of the setting kind within a settings block.
    pub fn rank(&self) -> u8 {
        match self {
            Setting::Entity(_) => 0,
            Setting::Updated(_) => 1,
            Setting::SoftDelete(_) => 2,
            Setting::SelectExplicit(_) => 3,
            Setting::Codec(..) => 4,
            Setting::AesVersion(_) => 5,
            Setting::BlindIndex(..) => 6,
            Setting::Navigation(..) => 7,
            Setting::Immutable => 8,
            Setting::Audit { .. } => 9,
        }
    }

    /// The name that orders repeated lines of one kind: the codec column or the navigation foreign key.
    pub fn sort_name(&self) -> &str {
        match self {
            Setting::Codec(column, _) | Setting::BlindIndex(column, _) => &column.text,
            Setting::Navigation(key, _, _) => &key.text,
            _ => "",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Diagram {
    pub comments: Vec<String>,
    pub name: Name,
    pub placements: Vec<Placement>,
    pub closing: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Placement {
    pub comments: Vec<String>,
    pub table: Name,
    pub x: i32,
    pub y: i32,
}
