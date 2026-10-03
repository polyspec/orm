//! dbspec document 파일 reader (`docs/dbspec.md`, "Files"). 파일을 읽는 모든 tool이
//! [`read_file`]로 읽어, signature가 없는 파일을 parse 전에 거부한다.

use super::Diagnostic;
use std::fmt;
use std::io;
use std::path::Path;

/// 모든 dbspec document 파일의 첫 byte다. header `dbspec 1 <document>`가 이것으로 시작한다.
pub const SIGNATURE: &str = "dbspec ";

/// [`read_file`]의 실패: 파일을 읽을 수 없거나, 파일 byte가 [`read_bytes`]의 diagnostic을
/// 낸다.
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

/// parse할 `path`의 dbspec document 파일을 읽고 그 byte를 path를 이름으로 [`read_bytes`]로
/// 확인한다. 읽을 수 없는 파일은 [`ReadError::Io`], byte의 diagnostic은
/// [`ReadError::Diagnostics`]다.
pub fn read_file(path: &Path) -> Result<String, ReadError> {
    let bytes = std::fs::read(path).map_err(ReadError::Io)?;
    read_bytes(&path.display().to_string(), bytes).map_err(ReadError::Diagnostics)
}

/// 호출자가 자기 규칙으로 읽은 dbspec document 파일의 byte를 parse 전에 확인한다. `name`은
/// message가 파일을 가리키는 이름이다. [`SIGNATURE`]로 시작하지 않는 byte는 text 없이 line 1,
/// column 1의 `signature` diagnostic 하나와 message `<name> is not a dbspec document`를,
/// UTF-8이 아닌 byte는 첫 잘못된 byte의 줄과 칸에서 `encoding` diagnostic 하나와 message
/// `<name> is not valid UTF-8`을 돌려준다. 그 밖의 byte는 diagnostic 없이 그대로 text가 된다.
pub fn read_bytes(name: &str, bytes: Vec<u8>) -> Result<String, Vec<Diagnostic>> {
    // signature는 decode 전에 byte로 확인한다. 다른 형식의 파일과 빈 파일은 header가 아니라 signature diagnostic이다.
    if !bytes.starts_with(SIGNATURE.as_bytes()) {
        return Err(vec![diagnostic("signature", 1, 1, format!("{name} is not a dbspec document"))]);
    }
    String::from_utf8(bytes).map_err(|error| {
        // valid_up_to까지는 올바른 UTF-8이므로 그 앞의 LF와 code point로 줄과 칸을 센다.
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
