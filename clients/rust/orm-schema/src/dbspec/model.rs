//! The parsed dbspec model (`docs/dbspec.md`). Every name keeps the position of
//! its token so that validation can point at it; emission ignores positions.
//! Tools read a parsed document, change it and emit it again.

pub use super::literal::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pos {
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug)]
pub struct Name {
    pub text: String,
    pub pos: Pos,
}

/// A parsed dbspec document: the header name, `use` lines, tables and diagrams
/// with their attached comments.
#[derive(Clone, Debug)]
pub struct Document {
    pub name: Name,
    pub uses: Vec<Use>,
    pub tables: Vec<Table>,
    pub diagrams: Vec<Diagram>,
    /// Comment lines after the last line of the document.
    pub trailing: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Use {
    pub comments: Vec<String>,
    pub document: Name,
    pub tables: Vec<Name>,
}

#[derive(Clone, Debug)]
pub struct Table {
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
pub struct Column {
    pub comments: Vec<String>,
    pub name: Name,
    pub ty: Type,
    pub nullable: bool,
    /// The position of the `identity` token.
    pub identity: Option<Pos>,
    pub default: Option<DefaultValue>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DefaultValue {
    /// `default now` of a `datetime(p)` column.
    Now,
    /// A literal in its canonical text.
    Literal(String),
}

#[derive(Clone, Debug)]
pub struct PrimaryKey {
    pub comments: Vec<String>,
    /// The position of the `primary` keyword.
    pub pos: Pos,
    pub columns: Vec<Name>,
}

#[derive(Clone, Debug)]
pub struct Unique {
    pub comments: Vec<String>,
    pub name: Name,
    pub columns: Vec<Name>,
}

#[derive(Clone, Debug)]
pub struct Index {
    pub comments: Vec<String>,
    pub name: Name,
    /// Columns with their direction; `true` is `desc`.
    pub columns: Vec<(Name, bool)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
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
pub struct ForeignKey {
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
pub struct Check {
    pub comments: Vec<String>,
    pub name: Name,
    pub expr: Expr,
}

/// A check predicate (docs/dbspec.md, "Checks").
#[derive(Clone, Debug)]
pub enum Expr {
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
pub enum Operand {
    Column(Name),
    Literal(Literal),
}

/// A check literal. `text` is its canonical text in the form of the column it
/// meets; validation sets it, so it is empty until the document is valid.
#[derive(Clone, Debug)]
pub struct Literal {
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
pub struct Settings {
    pub comments: Vec<String>,
    pub lines: Vec<SettingLine>,
    pub closing: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct SettingLine {
    pub comments: Vec<String>,
    /// The position of the setting keyword.
    pub pos: Pos,
    pub setting: Setting,
}

#[derive(Clone, Debug)]
pub enum Setting {
    Entity(Name),
    Updated(Name),
    SoftDelete(Name),
    SelectExplicit(Vec<Name>),
    Codec(Name, Vec<Name>),
    AesVersion(Name),
    BlindIndex(Name, Name),
    Navigation(Name, Name, Name),
    Immutable,
    /// `lists`는 exclude와 include 목록이다. 유효한 문서는 많아야 하나를 가진다(docs/dbspec.md "Audit").
    Audit {
        into: Name,
        operation: Name,
        action: Name,
        previous: Name,
        lists: Vec<AuditList>,
    },
}

/// audit의 `exclude (<column>, ...)`나 `include (<column>, ...)` 목록. `keyword`는 `exclude`나 `include`다.
#[derive(Clone, Debug)]
pub struct AuditList {
    pub keyword: Name,
    pub columns: Vec<Name>,
}

/// audit setting 줄. `list`의 column이 비면 목록 없이, 아니면 list keyword와 그 column을 쓴다.
pub fn audit_line(into: &str, operation: &str, action: &str, previous: &str, list: &str, columns: &[&str]) -> String {
    let line = format!("audit into {into} operation {operation} action {action} previous {previous}");
    if columns.is_empty() {
        line
    } else {
        format!("{line} {list} ({})", columns.join(", "))
    }
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

    /// audit trigger가 column을 복사하는지 알린다. operation column은 언제나, exclude 목록의
    /// column은 언제나 아니며, include 목록이 있으면 그 column만 복사한다. audit이 아닌 setting은
    /// 참이다.
    pub fn records(&self, column: &str) -> bool {
        let Setting::Audit { operation, lists, .. } = self else { return true };
        if column == operation.text {
            return true;
        }
        match lists.first() {
            Some(list) if list.keyword.text == "include" => list.columns.iter().any(|c| c.text == column),
            Some(list) => list.columns.iter().all(|c| c.text != column),
            None => true,
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
pub struct Diagram {
    pub comments: Vec<String>,
    pub name: Name,
    pub placements: Vec<Placement>,
    pub closing: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Placement {
    pub comments: Vec<String>,
    pub table: Name,
    pub x: i32,
    pub y: i32,
}
