//! The dbspec document file reader (`docs/spec/dbspec.md`, "Files"). Every tool that reads a file
//! reads it with [`read_file`], which rejects a file without a signature before parsing.

use super::Diagnostic;
use std::fmt;
use std::io;
use std::path::Path;

/// The first byte of every dbspec document file. The header `dbspec 1 <document>` starts with it.
pub const SIGNATURE: &str = "dbspec ";

/// Failure of [`read_file`]: the file cannot be read, or its bytes produce a diagnostic of [`read_bytes`]
/// yield.
#[derive(Debug)]
pub enum ReadError {
    Io(io::Error),
    Diagnostics(Vec<Diagnostic>),
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadError::Io(error) => write!(f, "{error}"),
            ReadError::Diagnostics(diagnostics) => {
                let lines: Vec<String> = diagnostics.iter().map(ToString::to_string).collect();
                write!(f, "{}", lines.join("\n"))
            }
        }
    }
}

impl std::error::Error for ReadError {}

/// Reads the dbspec document file at `path` to parse, and checks its bytes with [`read_bytes`], naming them by path.
/// A file that cannot be read is [`ReadError::Io`]; a byte diagnostic is
/// [`ReadError::Diagnostics`].
pub fn read_file(path: &Path) -> Result<String, ReadError> {
    let bytes = std::fs::read(path).map_err(ReadError::Io)?;
    read_bytes(&path.display().to_string(), bytes).map_err(ReadError::Diagnostics)
}

/// Checks the bytes of a dbspec document file that the caller read by its own rules, before parsing. `name`
/// is the name the message uses to refer to the file. Bytes that do not start with [`SIGNATURE`] produce, without text, line 1,
/// column 1 one `signature` diagnostic and the message `<name> is not a dbspec document`,
/// Bytes that are not UTF-8 produce one `encoding` diagnostic at the line and column of the first invalid byte, and the message
/// `<name> is not valid UTF-8`. Other bytes become text with no diagnostic.
pub fn read_bytes(name: &str, bytes: Vec<u8>) -> Result<String, Vec<Diagnostic>> {
    // The signature is checked as bytes before decoding. A file of another format, and an empty file, get a signature diagnostic, not a header one.
    if !bytes.starts_with(SIGNATURE.as_bytes()) {
        return Err(vec![diagnostic("signature", 1, 1, format!("{name} is not a dbspec document"))]);
    }
    String::from_utf8(bytes).map_err(|error| {
        // Up to valid_up_to the bytes are valid UTF-8, so the line and column are counted by the LFs and code points before it.
        let valid = &error.as_bytes()[..error.utf8_error().valid_up_to()];
        let prefix = std::str::from_utf8(valid).expect("the prefix before valid_up_to is UTF-8");
        let line = prefix.matches('\n').count() + 1;
        let column = prefix.rsplit('\n').next().unwrap_or("").chars().count() + 1;
        vec![diagnostic("encoding", line, column, format!("{name} is not valid UTF-8"))]
    })
}

fn diagnostic(rule: &str, line: usize, column: usize, message: String) -> Diagnostic {
    Diagnostic { rule: rule.to_owned(), line, column, message }
}
