//! The declaration positions of a parsed document (docs/dbspec.md "Declaration positions"). The parser
//! records each declaration where its name token is read; this module turns the records into the sorted
//! positions and gives each setting its identity.

use super::parser::{Declaration, SettingWords};
use super::Position;

/// Returns the positions of the declarations in source order, by line and then column. A setting's path is
/// its table, its keyword as written and its identity words, and the identity words are those of
/// `setting_identity`.
pub(crate) fn positions(declarations: &[Declaration]) -> Vec<Position> {
    let mut out: Vec<Position> = declarations
        .iter()
        .map(|declaration| {
            let mut path = declaration.path.clone();
            if let Some(words) = &declaration.setting {
                path.push(words.keyword.clone());
                path.extend(setting_identity(words));
            }
            Position { kind: declaration.kind.to_owned(), path, line: declaration.pos.line, column: declaration.pos.column }
        })
        .collect();
    // A stable sort keeps the order of declarations that share a token, which the parser never produces.
    out.sort_by_key(|position| (position.line, position.column));
    out
}

/// The words that make a setting's repeat unique (docs/dbspec.md "Settings"): the column of codec and
/// markdown, the foreign key of navigation, the AES column of blind_index, the column and state of checkbox,
/// and the form and states of a state_machine line, whose column is left out since a table holds one
/// machine. Every other setting appears at most once and has no identity.
fn setting_identity(words: &SettingWords) -> Vec<String> {
    let args = &words.args;
    match words.keyword.as_str() {
        "codec" | "markdown" | "navigation" | "blind_index" => vec![args[0].clone()],
        "checkbox" => vec![args[0].clone(), args[1].clone()],
        "state_machine" => match words.form.as_str() {
            "transition" => vec!["transition".to_owned(), args[1].clone(), args[2].clone()],
            "history" => vec!["history".to_owned()],
            form => vec![form.to_owned(), args[1].clone()],
        },
        _ => Vec::new(),
    }
}
