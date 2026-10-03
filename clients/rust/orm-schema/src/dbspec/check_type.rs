//! The types of a check predicate (docs/dbspec.md, "Checks"): which operands
//! meet, which operators a `bool` operand takes, and the canonical text of each
//! literal in the default form of the column it meets.

use super::literal::{check_literal, Value};
use super::model::{Document, Expr, Literal, Name, Operand, Pos, Type};

const ORDERINGS: [&str; 4] = ["<", "<=", ">", ">="];

/// The canonical literal texts of one check in source order.
pub(crate) struct CheckLiterals {
    pub table: usize,
    pub check: usize,
    pub texts: Vec<String>,
}

/// Types `expr`. `column` gives the type of a column reference, or `None` when
/// the reference has its own diagnostic or its column line failed; operands
/// that meet such a column are not typed. Returns the canonical texts of the
/// literals in source order, or the first type diagnostic in source order.
pub(crate) fn type_check(expr: &Expr, column: &dyn Fn(&Name) -> Option<Type>) -> Result<Vec<String>, (Pos, String)> {
    let mut typing = Typing { column, first: None, texts: Vec::new() };
    typing.expr(expr);
    match typing.first {
        Some(problem) => Err(problem),
        None => Ok(typing.texts),
    }
}

/// Writes the canonical literal texts that validation computed into `document`.
pub(crate) fn set_literals(document: &mut Document, literals: Vec<CheckLiterals>) {
    for CheckLiterals { table, check, texts } in literals {
        let mut found = Vec::new();
        document.tables[table].checks[check].expr.literals_mut(&mut found);
        assert_eq!(found.len(), texts.len(), "a valid check has a canonical text for each literal");
        for (literal, text) in found.into_iter().zip(texts) {
            literal.text = text;
        }
    }
}

/// Two column types whose values the three databases compare alike.
fn meets(a: Type, b: Type) -> bool {
    use Type::*;
    match (a, b) {
        (I16 | I32 | I64, I16 | I32 | I64) | (F64, F64) | (Bool, Bool) | (Uuid, Uuid) | (Date, Date) => true,
        (Varchar(_) | Text, Varchar(_) | Text) => true,
        (Decimal(_, s), Decimal(_, t)) => s == t,
        (Time(p), Time(q)) | (DateTime(p), DateTime(q)) => p == q,
        _ => false,
    }
}

struct Typing<'f> {
    column: &'f dyn Fn(&Name) -> Option<Type>,
    first: Option<(Pos, String)>,
    texts: Vec<String>,
}

impl Typing<'_> {
    /// Keeps the diagnostic that comes first in source order.
    fn report(&mut self, pos: Pos, message: String) {
        if self.first.as_ref().is_none_or(|(first, _)| pos < *first) {
            self.first = Some((pos, message));
        }
    }

    /// The type of a column reference; a `bytes` column is reported and has none.
    fn column_type(&mut self, name: &Name) -> Option<Type> {
        let ty = (self.column)(name)?;
        if ty == Type::Bytes {
            self.report(name.pos, format!("bytes column '{}' is not part of a check predicate", name.text));
            return None;
        }
        Some(ty)
    }

    /// Checks a literal against the type of the column it meets.
    fn literal(&mut self, literal: &Literal, ty: Option<Type>) {
        let Some(ty) = ty else { return };
        match check_literal(ty, &literal.value) {
            Ok(text) => self.texts.push(text),
            Err(message) => self.report(literal.pos, message),
        }
    }

    fn operand_type(&mut self, operand: &Operand) -> Option<Type> {
        match operand {
            Operand::Column(name) => self.column_type(name),
            Operand::Literal(_) => None,
        }
    }

    fn expr(&mut self, expr: &Expr) {
        match expr {
            Expr::Logic(left, _, right) => {
                self.expr(left);
                self.expr(right);
            }
            Expr::Compare(left, op, op_pos, right) => self.compare(left, op, *op_pos, right),
            Expr::In(name, _, list) => {
                let ty = self.column_type(name);
                for literal in list {
                    self.literal(literal, ty);
                }
            }
            Expr::IsNull(name, _) => {
                self.column_type(name);
            }
        }
    }

    fn compare(&mut self, left: &Operand, op: &str, op_pos: Pos, right: &Operand) {
        let left_type = self.operand_type(left);
        let right_type = self.operand_type(right);
        let boolean = |operand: &Operand, ty: Option<Type>| match operand {
            Operand::Column(_) => ty == Some(Type::Bool),
            Operand::Literal(literal) => matches!(&literal.value, Value::Word(_)),
        };
        if ORDERINGS.contains(&op) && (boolean(left, left_type) || boolean(right, right_type)) {
            self.report(op_pos, format!("'{op}' does not apply to a bool operand"));
        }
        match (left, right) {
            // Reading rejects a comparison of two literals.
            (Operand::Literal(_), Operand::Literal(_)) => {}
            (Operand::Column(a), Operand::Column(b)) => {
                if let (Some(a_type), Some(b_type)) = (left_type, right_type) {
                    if !meets(a_type, b_type) {
                        self.report(b.pos, format!("column '{}' {} does not meet column '{}' {}", b.text, b_type.render(), a.text, a_type.render()));
                    }
                }
            }
            (Operand::Column(_), Operand::Literal(literal)) => self.literal(literal, left_type),
            (Operand::Literal(literal), Operand::Column(_)) => self.literal(literal, right_type),
        }
    }
}
