//! dbspec document 파일 reader (`docs/dbspec.md`, "Files"). 파일을 읽는 모든 tool이
//! [`read_file`]로 읽어, signature가 없는 파일을 parse 전에 거부한다.

use super::Diagnostic;
use std::fmt;
use std::io;
use std::path::Path;

/// 모든 dbspec document 파일의 첫 byte다. header `dbspec 1 <document>`가 이것으로 시작한다.
pub const SIGNATURE: &str = "dbspec ";

/// [`read_file`]의 실패: 파일을 읽을 수 없거나(UTF-8이 아닌 내용 포함), 파일에 signature가
/// 없다.
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

/// parse할 `path`의 dbspec document 파일을 읽는다. [`SIGNATURE`]로 시작하지 않는 파일은
/// text 없이 line 1, column 1의 `signature` diagnostic 하나와 message
/// `<path> is not a dbspec document`를 돌려주며 parse하지 않는다. 읽을 수 없는 파일과
/// signature 뒤의 UTF-8이 아닌 내용은 [`ReadError::Io`]다.
pub fn read_file(path: &Path) -> Result<String, ReadError> {
    let bytes = std::fs::read(path).map_err(ReadError::Io)?;
    // signature는 decode 전에 byte로 확인한다. 다른 형식의 파일과 빈 파일은 header가 아니라 signature diagnostic이다.
    if !bytes.starts_with(SIGNATURE.as_bytes()) {
        return Err(ReadError::Diagnostics(vec![Diagnostic {
            rule: "signature".to_owned(),
            line: 1,
            column: 1,
            message: format!("{} is not a dbspec document", path.display()),
        }]));
    }
    String::from_utf8(bytes).map_err(|error| ReadError::Io(io::Error::new(io::ErrorKind::InvalidData, error)))
}
