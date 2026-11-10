//! Row sources for the generated `from_row`: a MySQL driver row decoded cell by cell straight
//! into typed fields (the main step of a plan without relation steps), or a positional
//! `Vec<Val>` row (relation steps, and every PostgreSQL/SQLite row, which are read
//! positionally like Go does and decoded — host stages, then codec stages — before assembly).
//!
//! Every cell is dispatched by its column type name and decoded exactly once; a decode
//! failure is an error, never a silent NULL (F3). The typed getters coerce like `Val`'s
//! `as_*` do, so both sources yield the same field values.

use chrono::{NaiveDate, NaiveDateTime};
use sqlx::mysql::MySqlRow;
use sqlx::postgres::PgRow;
use sqlx::sqlite::SqliteRow;
use sqlx::{Column, Row as _, TypeInfo, ValueRef as _};

use crate::db::Zone;
use crate::value::Val;
use crate::{Error, Result};

/// One row as the driver returned it.
pub enum DriverRow {
    MySql(MySqlRow),
    Postgres(PgRow),
    Sqlite(SqliteRow),
    /// A row of a statement on a markdown connection, read as the SQLite driver reads it (docs/spec/protocol.md PRT-69).
    Markdown(crate::markdown::MarkdownRow),
}

impl DriverRow {
    pub fn len(&self) -> usize {
        match self {
            DriverRow::MySql(r) => r.len(),
            DriverRow::Postgres(r) => r.len(),
            DriverRow::Sqlite(r) => r.len(),
            DriverRow::Markdown(r) => r.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The driver's name of column `i` (kind raw results are keyed by it).
    pub fn column_name(&self, i: usize) -> &str {
        match self {
            DriverRow::MySql(r) => r.column(i).name(),
            DriverRow::Postgres(r) => r.column(i).name(),
            DriverRow::Sqlite(r) => r.column(i).name(),
            DriverRow::Markdown(r) => r.column_name(i),
        }
    }

    /// The MySQL row itself (the hot path keeps it undecoded until `from_row`).
    pub fn into_mysql(self) -> MySqlRow {
        match self {
            DriverRow::MySql(r) => r,
            _ => panic!("orm: a mysql pool yields mysql rows"),
        }
    }
}

/// What `from_row` reads its cells from. Methods take `&mut self` so the positional
/// source can move strings and decoded values out instead of cloning them.
pub trait Src {
    fn i64(&mut self, i: usize) -> Result<i64>;
    fn f64(&mut self, i: usize) -> Result<f64>;
    fn bool(&mut self, i: usize) -> Result<bool>;
    fn string(&mut self, i: usize) -> Result<String>;
    fn datetime(&mut self, i: usize) -> Result<NaiveDateTime>;
    fn date(&mut self, i: usize) -> Result<NaiveDate>;
    /// A styled cell after decoding (docs/spec/codec.md): `Val::Json`, `Val::Str`, or `Val::Null` for SQL NULL.
    fn styled(&mut self, i: usize, styles: &[String]) -> Result<Val>;
    /// A styled cell's decoded value; None for NULL/empty.
    fn json(&mut self, i: usize, styles: &[String]) -> Result<Option<serde_json::Value>> {
        self.styled(i, styles)?.take_json()
    }
    /// The cell as a `Val` (select_expr outputs, keys, parent values). A positional source
    /// clones: the same cell may still be read as a field afterwards.
    fn val(&mut self, i: usize) -> Result<Val>;
}

/// One row of a select step as handed to the generated code.
pub enum Cells {
    /// A positional row (styled cells already decoded).
    Pos(Vec<Val>),
}

impl Src for Cells {
    fn i64(&mut self, i: usize) -> Result<i64> {
        let Cells::Pos(v) = self;
        v[i].as_i64()
    }
    fn f64(&mut self, i: usize) -> Result<f64> {
        let Cells::Pos(v) = self;
        v[i].as_f64()
    }
    fn bool(&mut self, i: usize) -> Result<bool> {
        let Cells::Pos(v) = self;
        v[i].as_bool()
    }
    fn string(&mut self, i: usize) -> Result<String> {
        let Cells::Pos(v) = self;
        v[i].take_string()
    }
    fn datetime(&mut self, i: usize) -> Result<NaiveDateTime> {
        let Cells::Pos(v) = self;
        v[i].as_datetime()
    }
    fn date(&mut self, i: usize) -> Result<NaiveDate> {
        let Cells::Pos(v) = self;
        v[i].as_date()
    }
    fn styled(&mut self, i: usize, _styles: &[String]) -> Result<Val> {
        let Cells::Pos(v) = self;
        Ok(std::mem::take(&mut v[i]))
    }
    fn val(&mut self, i: usize) -> Result<Val> {
        let Cells::Pos(v) = self;
        Ok(v[i].clone())
    }
}

/// The cell's MySQL type name, the dispatch key of every decoder below.
fn type_name(r: &MySqlRow, i: usize) -> &str {
    r.column(i).type_info().name()
}

/// A `YEAR` cell, which `YEAR(col)` also returns. sqlx's i64 does not accept `YEAR` (only
/// unsigned Rust integers of an `UNSIGNED` column do); the value is a two-byte integer, so it is
/// decoded as i64 without that type check.
fn year_cell(r: &MySqlRow, i: usize) -> Result<Option<i64>> {
    Ok(r.try_get_unchecked::<Option<i64>, _>(i)?)
}

/// Reads one MySQL cell as a `Val` by its column type name.
pub fn read_cell_mysql(row: &MySqlRow, i: usize) -> Result<Val> {
    let v = match type_name(row, i) {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => row.try_get::<Option<i64>, _>(i)?.map(Val::I64),
        "YEAR" => year_cell(row, i)?.map(Val::I64),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
            // An unsigned value past i64 keeps its exact digits, as a text protocol sends them, so the column type that
            // reads it refuses it by its own rule and names its column (COD-1).
            return Ok(match row.try_get::<Option<u64>, _>(i)? {
                Some(value) => i64::try_from(value).map_or_else(|_| Val::Bytes(value.to_string().into_bytes()), Val::I64),
                None => Val::Null,
            });
        }
        "FLOAT" | "DOUBLE" => row.try_get::<Option<f64>, _>(i)?.map(Val::F64),
        // MySQL sends a DECIMAL as its text in both protocols, which is kept exactly: a 128-bit decimal holds 28 digits and
        // rounds a longer value, such as a sum of DSL-161, silently. A caller that requests f64 checks precision.
        "DECIMAL" => row.try_get_unchecked::<Option<String>, _>(i)?.map(Val::Str),
        // sqlx's NaiveDateTime only accepts DATETIME; TIMESTAMP columns decode as DateTime<Utc> (session tz is UTC).
        "DATETIME" => row.try_get::<Option<NaiveDateTime>, _>(i)?.map(Val::DateTime),
        "TIMESTAMP" => row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)?.map(|t| Val::DateTime(t.naive_utc())),
        "DATE" => row.try_get::<Option<NaiveDate>, _>(i)?.map(Val::Date),
        // The driver reads any nonzero TINYINT(1) as true; a cell neither 0 nor 1 stays a number, which a boolean field refuses.
        "BOOLEAN" => row.try_get::<Option<i8>, _>(i)?.map(|n| match n {
            0 => Val::Bool(false),
            1 => Val::Bool(true),
            other => Val::I64(i64::from(other)),
        }),
        // MySQL JSON columns arrive parsed; the json style then keeps the value as is.
        "JSON" => row.try_get::<Option<serde_json::Value>, _>(i)?.map(Val::Json),
        // Authenticated AES envelopes are BLOB values; decode them as text when possible.
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "VARBINARY" | "BINARY" => row.try_get::<Option<Vec<u8>>, _>(i)?.map(Val::Bytes),
        _ => row.try_get::<Option<String>, _>(i)?.map(Val::Str),
    };
    Ok(v.unwrap_or(Val::Null))
}

/// Reads one PostgreSQL cell by its column type: integers of every width as i64, float and
/// numeric as exact decimal text, boolean, timestamp(tz) and date, jsonb/json parsed, bytea as bytes,
/// inet as its text (the plans select `host(col)`, so this is for raw statements).
pub fn read_cell_pg(row: &PgRow, i: usize, zone: Zone) -> Result<Val> {
    let v = match row.column(i).type_info().name() {
        "INT2" => row.try_get::<Option<i16>, _>(i)?.map(|x| Val::I64(x as i64)),
        "INT4" => row.try_get::<Option<i32>, _>(i)?.map(|x| Val::I64(x as i64)),
        "INT8" => row.try_get::<Option<i64>, _>(i)?.map(Val::I64),
        "FLOAT4" => row.try_get::<Option<f32>, _>(i)?.map(|x| Val::F64(x as f64)),
        "FLOAT8" => row.try_get::<Option<f64>, _>(i)?.map(Val::F64),
        "NUMERIC" => numeric_text(row, i)?.map(Val::Str),
        "BOOL" => row.try_get::<Option<bool>, _>(i)?.map(Val::Bool),
        "TIMESTAMP" => row.try_get::<Option<NaiveDateTime>, _>(i)?.map(Val::DateTime),
        // an instant, shown as wall-clock time in the connection zone
        "TIMESTAMPTZ" => row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)?.map(|t| Val::DateTime(zone.local(t))),
        "DATE" => row.try_get::<Option<NaiveDate>, _>(i)?.map(Val::Date),
        "JSONB" | "JSON" => row.try_get::<Option<serde_json::Value>, _>(i)?.map(Val::Json),
        "BYTEA" => row.try_get::<Option<Vec<u8>>, _>(i)?.map(Val::Bytes),
        "INET" | "CIDR" => row.try_get::<Option<sqlx::types::ipnet::IpNet>, _>(i)?.map(|n| {
            // PostgreSQL's text form: no mask on a host address
            Val::Str(if n.prefix_len() == n.max_prefix_len() { n.addr().to_string() } else { n.to_string() })
        }),
        _ => row.try_get::<Option<String>, _>(i)?.map(Val::Str),
    };
    Ok(v.unwrap_or(Val::Null))
}

/// The exact decimal text of a PostgreSQL NUMERIC cell, or None for NULL. A 128-bit decimal holds 28 digits and rounds a
/// longer value, such as a sum of DSL-161, silently, so the cell is read from its wire form: the text form as it is, the
/// binary form as its sign, its base-10000 digits from the weight of the first one and its display scale. NaN and the
/// infinities, which no exact column holds, are CODEC_DECODE.
fn numeric_text(row: &PgRow, i: usize) -> Result<Option<String>> {
    use sqlx::postgres::PgValueFormat;
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(None);
    }
    let refused = |what: &str| crate::Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: format!("numeric cell {i} is {what}"), source: None };
    let text = match raw.format() {
        PgValueFormat::Text => raw
            .as_str()
            .map_err(|error| crate::Error::Engine {
                code: crate::codes::CODEC_DECODE.into(),
                msg: format!("numeric cell {i} is not text"),
                source: Some(error),
            })?
            .to_owned(),
        PgValueFormat::Binary => {
            let bytes = raw.as_bytes().map_err(|error| crate::Error::Engine {
                code: crate::codes::CODEC_DECODE.into(),
                msg: format!("numeric cell {i} has no bytes"),
                source: Some(error),
            })?;
            numeric_binary_text(bytes).ok_or_else(|| refused("not a binary numeric"))?
        }
    };
    if matches!(text.as_str(), "NaN" | "Infinity" | "-Infinity") {
        return Err(refused("not a finite number"));
    }
    Ok(Some(text))
}

/// The decimal text of the binary form of a PostgreSQL NUMERIC: ndigits, weight, sign and dscale as 16-bit big-endian
/// integers, then ndigits base-10000 digits, the first of weight 10000^weight; None for a malformed form. The text has
/// dscale fraction digits, as PostgreSQL writes it.
pub(crate) fn numeric_binary_text(bytes: &[u8]) -> Option<String> {
    let word = |at: usize| bytes.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]));
    let ndigits = usize::from(word(0)?);
    let weight = i64::from(word(2)? as i16);
    let sign = word(4)?;
    let dscale = usize::from(word(6)?);
    if bytes.len() != 8 + 2 * ndigits {
        return None;
    }
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        0x0000 | 0x4000 => {}
        _ => return None,
    }
    let digits: Vec<u16> = (0..ndigits).map(|k| word(8 + 2 * k)).collect::<Option<_>>()?;
    if digits.iter().any(|&d| d >= 10000) {
        return None;
    }
    // The base-10000 digit of weight w, 0 outside the stored ones.
    let digit = |w: i64| -> u16 {
        let k = weight - w;
        if k < 0 || k >= ndigits as i64 {
            0
        } else {
            digits[k as usize]
        }
    };
    let mut whole = String::new();
    for w in (0..=weight.max(0)).rev() {
        whole.push_str(&format!("{:04}", digit(w)));
    }
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let mut fraction = String::new();
    let mut w = -1;
    while fraction.len() < dscale {
        fraction.push_str(&format!("{:04}", digit(w)));
        w -= 1;
    }
    fraction.truncate(dscale);
    let zero = whole == "0" && fraction.bytes().all(|b| b == b'0');
    let sign = if sign == 0x4000 && !zero { "-" } else { "" };
    Some(if dscale == 0 { format!("{sign}{whole}") } else { format!("{sign}{whole}.{fraction}") })
}

/// Why PostgreSQL does not read a text as a numeric: its SQLSTATE, 22P02 for a text that is no numeric and 22003 for a
/// numeric past the range of the type.
pub(crate) const NUMERIC_INVALID: &str = "22P02";
pub(crate) const NUMERIC_OUT_OF_RANGE: &str = "22003";

/// The binary form of the PostgreSQL NUMERIC that PostgreSQL 17 reads from `text` (numeric_in), whatever its number of
/// digits, or the SQLSTATE with which PostgreSQL refuses the text. The text, between spaces of the C locale, is `NaN`,
/// an optionally signed `Infinity` or `inf`, any case; or an optionally signed number: a hexadecimal, octal or binary
/// integer after `0x`, `0o` or `0b`, or decimal digits with an optional point and an optional exponent, where an
/// underscore stands between two digits. The display scale is the number of fraction digits after the exponent, at
/// least 0. An exponent past 1073741823, a weight past 32767 base-10000 digits and a display scale past 16383 are
/// past the range.
pub(crate) fn numeric_text_binary(text: &str) -> std::result::Result<Vec<u8>, &'static str> {
    let header = |ndigits: u16, weight: i16, sign: u16, dscale: u16| -> Vec<u8> {
        [ndigits, weight as u16, sign, dscale].iter().flat_map(|word| word.to_be_bytes()).collect()
    };
    let space = |b: u8| matches!(b, b' ' | b'\t' | b'\n' | 0x0B | 0x0C | b'\r');
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() && space(bytes[at]) {
        at += 1;
    }
    let rest = |at: usize| &bytes[at..];
    let starts = |at: usize, word: &str| rest(at).len() >= word.len() && rest(at)[..word.len()].eq_ignore_ascii_case(word.as_bytes());
    let end = |mut at: usize| {
        while at < bytes.len() && space(bytes[at]) {
            at += 1;
        }
        at == bytes.len()
    };
    for (word, sign) in
        [("NaN", 0xC000), ("Infinity", 0xD000), ("+Infinity", 0xD000), ("-Infinity", 0xF000), ("inf", 0xD000), ("+inf", 0xD000), ("-inf", 0xF000)]
    {
        if starts(at, word) {
            return if end(at + word.len()) { Ok(header(0, 0, sign, 0)) } else { Err(NUMERIC_INVALID) };
        }
    }
    let negative = match bytes.get(at) {
        Some(b'-') => {
            at += 1;
            true
        }
        Some(b'+') => {
            at += 1;
            false
        }
        _ => false,
    };
    let radix = match (bytes.get(at), bytes.get(at + 1).map(u8::to_ascii_lowercase)) {
        (Some(b'0'), Some(b'x')) => 16,
        (Some(b'0'), Some(b'o')) => 8,
        (Some(b'0'), Some(b'b')) => 2,
        _ => 10,
    };
    // The value is the decimal digits times 10^-scale; weight10 is the decimal weight of the first digit.
    let mut digits: Vec<u8> = Vec::new();
    let mut scale: i64 = 0;
    if radix != 10 {
        at += 2;
        let first = at;
        let digit = |b: u8| (b as char).to_digit(radix).map(|d| d as u8);
        // The base-10000 digits of the integer, most significant first, multiplied by the radix for each digit.
        let mut words: Vec<u32> = Vec::new();
        while let Some(&b) = bytes.get(at) {
            if let Some(d) = digit(b) {
                let mut carry = u32::from(d);
                for w in words.iter_mut().rev() {
                    let v = *w * radix + carry;
                    *w = v % 10000;
                    carry = v / 10000;
                }
                while carry > 0 {
                    words.insert(0, carry % 10000);
                    carry /= 10000;
                }
                at += 1;
            } else if b == b'_' {
                at += 1;
                if !bytes.get(at).is_some_and(|&b| digit(b).is_some()) {
                    return Err(NUMERIC_INVALID);
                }
            } else {
                break;
            }
        }
        if at == first || !end(at) {
            return Err(NUMERIC_INVALID);
        }
        for w in words {
            digits.extend(format!("{w:04}").bytes().map(|b| b - b'0'));
        }
    } else {
        let mut point = false;
        if bytes.get(at) == Some(&b'.') {
            point = true;
            at += 1;
        }
        if !bytes.get(at).is_some_and(u8::is_ascii_digit) {
            return Err(NUMERIC_INVALID);
        }
        while let Some(&b) = bytes.get(at) {
            if b.is_ascii_digit() {
                digits.push(b - b'0');
                if point {
                    scale += 1;
                }
                at += 1;
            } else if b == b'.' {
                if point {
                    return Err(NUMERIC_INVALID);
                }
                point = true;
                at += 1;
                if bytes.get(at) == Some(&b'_') {
                    return Err(NUMERIC_INVALID);
                }
            } else if b == b'_' {
                at += 1;
                if !bytes.get(at).is_some_and(u8::is_ascii_digit) {
                    return Err(NUMERIC_INVALID);
                }
            } else {
                break;
            }
        }
        if matches!(bytes.get(at), Some(b'e' | b'E')) {
            at += 1;
            let negative_exponent = match bytes.get(at) {
                Some(b'+') => {
                    at += 1;
                    false
                }
                Some(b'-') => {
                    at += 1;
                    true
                }
                _ => false,
            };
            if !bytes.get(at).is_some_and(u8::is_ascii_digit) {
                return Err(NUMERIC_INVALID);
            }
            let mut exponent: i64 = 0;
            while let Some(&b) = bytes.get(at) {
                if b.is_ascii_digit() {
                    exponent = exponent * 10 + i64::from(b - b'0');
                    if exponent > i64::from(i32::MAX / 2) {
                        return Err(NUMERIC_OUT_OF_RANGE);
                    }
                    at += 1;
                } else if b == b'_' {
                    at += 1;
                    if !bytes.get(at).is_some_and(u8::is_ascii_digit) {
                        return Err(NUMERIC_INVALID);
                    }
                } else {
                    break;
                }
            }
            scale -= if negative_exponent { -exponent } else { exponent };
        }
        if !end(at) {
            return Err(NUMERIC_INVALID);
        }
    }
    // The decimal weight of the first digit that is not 0: one past 4 * 32767 + 3 is past a weight of 32767, which is
    // known before the digits of a large exponent are written out.
    if let Some(first) = digits.iter().position(|&d| d != 0) {
        if (digits.len() - first) as i64 - 1 - scale > 4 * 32767 + 3 {
            return Err(NUMERIC_OUT_OF_RANGE);
        }
    }
    // A negative scale is that many zero digits after the last one; the display scale is then 0.
    if scale < 0 {
        if digits.iter().any(|&d| d != 0) {
            // A count of zeros past usize is past the range, which is the whole answer of the conversion.
            let Ok(zeros) = usize::try_from(-scale) else { return Err(NUMERIC_OUT_OF_RANGE) };
            digits.extend(std::iter::repeat_n(0, zeros));
        }
        scale = 0;
    }
    // A display scale past 16383, or past u16, is past the range, which is the whole answer of the conversion.
    let dscale = match u16::try_from(scale) {
        Ok(dscale) if dscale <= 0x3FFF => dscale,
        _ => return Err(NUMERIC_OUT_OF_RANGE),
    };
    let scale = usize::from(dscale);
    if digits.len() < scale {
        let mut padded = vec![0; scale - digits.len()];
        padded.extend(digits);
        digits = padded;
    }
    let (whole, fraction) = digits.split_at(digits.len() - scale);
    let mut whole = whole.to_vec();
    whole.splice(0..0, std::iter::repeat_n(0, (4 - whole.len() % 4) % 4));
    let mut fraction = fraction.to_vec();
    fraction.extend(std::iter::repeat_n(0, (4 - fraction.len() % 4) % 4));
    let group = |part: &[u8]| -> Vec<u16> { part.chunks(4).map(|c| c.iter().fold(0u16, |n, &d| n * 10 + u16::from(d))).collect() };
    let mut groups = group(&whole);
    let mut weight = groups.len() as i64 - 1;
    groups.extend(group(&fraction));
    let leading = groups.iter().take_while(|&&g| g == 0).count();
    groups.drain(..leading);
    weight -= leading as i64;
    while groups.last() == Some(&0) {
        groups.pop();
    }
    if groups.is_empty() {
        return Ok(header(0, 0, 0x0000, dscale));
    }
    // A weight or a digit count past its 16 bits is past the range, which is the whole answer of each conversion.
    let (Ok(weight), Ok(ndigits)) = (i16::try_from(weight), u16::try_from(groups.len())) else { return Err(NUMERIC_OUT_OF_RANGE) };
    let mut out = header(ndigits, weight, if negative { 0x4000 } else { 0x0000 }, dscale);
    out.extend(groups.iter().flat_map(|g| g.to_be_bytes()));
    Ok(out)
}

/// Reads one SQLite cell by the stored value's type (SQLite is dynamically typed): INTEGER as
/// i64 (bool columns coerce in the typed getters), REAL, TEXT (datetimes stay text with six
/// fraction digits), BLOB as text-or-bytes.
pub fn read_cell_sqlite(row: &SqliteRow, i: usize) -> Result<Val> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(Val::Null);
    }
    let ty = raw.type_info();
    Ok(match ty.name() {
        "INTEGER" => Val::I64(row.try_get::<i64, _>(i)?),
        "REAL" => Val::F64(row.try_get::<f64, _>(i)?),
        // A text that is not UTF-8 is its bytes, as a markdown cell holds it, so a model column refuses it (COD-69).
        "TEXT" => match String::from_utf8(row.try_get_unchecked::<Vec<u8>, _>(i)?) {
            Ok(text) => Val::Str(text),
            Err(error) => Val::Bytes(error.into_bytes()),
        },
        "BLOB" => Val::Bytes(row.try_get::<Vec<u8>, _>(i)?),
        "BOOLEAN" => Val::Bool(row.try_get::<bool, _>(i)?),
        other => return Err(crate::Error::Config(format!("sqlite column {i} holds a {other} value"))),
    })
}

/// Reads one cell as a `Val` by its column type, whichever driver produced the row.
pub fn read_cell(row: &DriverRow, i: usize, zone: Zone) -> Result<Val> {
    match row {
        DriverRow::MySql(r) => read_cell_mysql(r, i),
        DriverRow::Postgres(r) => read_cell_pg(r, i, zone),
        DriverRow::Sqlite(r) => read_cell_sqlite(r, i),
        DriverRow::Markdown(r) => Ok(r.cell(i)?.val()),
    }
}

/// Reads one positional row of `n` cells.
pub fn read_row(row: &DriverRow, n: usize, zone: Zone) -> Result<Vec<Val>> {
    (0..n).map(|i| read_cell(row, i, zone)).collect()
}

/// Reads one row of a statement of the frame (INT-150), which has no plan to declare its columns. The MySQL driver names a text
/// column of a binary collation as binary, and only the `binary` collation is byte data, so such a column reads as text.
pub fn read_frame_row(row: &DriverRow, zone: Zone) -> Result<Vec<Val>> {
    let mut cells = read_row(row, row.len(), zone)?;
    if let DriverRow::MySql(r) = row {
        for (i, cell) in cells.iter_mut().enumerate() {
            if matches!(cell, Val::Bytes(_)) && <str as sqlx::Type<sqlx::MySql>>::compatible(r.column(i).type_info()) {
                *cell = Val::Str(r.try_get::<String, _>(i)?);
            }
        }
    }
    Ok(cells)
}

/// Decodes styled cells of every positional row of a step in place: the host stages a
/// dialect left to the executor (aes/hex/ip, with the AES secret) first, then the codec
/// stages (docs/spec/codec.md). Each node, the root and each joined child, reads the key
/// version of its own row (COD-6).
pub fn decode_styled(asm: &crate::plan::Assemble, data: &mut [Vec<Val>], aes_keys: &std::collections::BTreeMap<i32, String>) -> Result<()> {
    let mut nodes = Vec::new();
    styled_nodes(asm, &mut nodes)?;
    if nodes.is_empty() {
        return Ok(());
    }
    for row in data.iter_mut() {
        for node in &nodes {
            for (sc, name) in node.styled.iter().zip(&node.names) {
                let mut v = std::mem::take(&mut row[sc.index]);
                // A NULL value stays NULL: its version is not read, so a NULL version with a NULL value is not an error (COD-44).
                if !sc.host.is_empty() && !matches!(v, Val::Null) {
                    let key = if sc.host.iter().any(|style| style == "aes") {
                        let index = node.version_index.ok_or_else(|| Error::Engine {
                            code: crate::codes::INTERNAL.into(),
                            msg: format!("{}: the AES version column is not selected", node.entity),
                            source: None,
                        })?;
                        let version = aes_row_version(row, index).map_err(|error| crate::model::column_decode_error(node.entity, node.version_name, error))?;
                        aes_keys.get(&version).map(String::as_str).ok_or_else(|| Error::Config("aes version is not declared".into()))?
                    } else {
                        // Non-AES host stages do not consume an AES key.
                        ""
                    };
                    v = crate::codec::host_decode(&v, &sc.host, key).map_err(|error| crate::model::column_decode_error(node.entity, name, error))?;
                }
                if !sc.codec.is_empty() {
                    v = crate::codec::decode(&sc.codec, &v).map_err(|error| crate::model::column_decode_error(node.entity, name, error))?;
                }
                row[sc.index] = v;
            }
        }
    }
    Ok(())
}

/// The styled columns of one node of an assembly with the cell of its own key version; names holds the column of
/// each styled cell, which a decode error names with the entity (COD-41).
struct StyledNode<'a> {
    entity: &'a str,
    styled: Vec<crate::codec::StyledCol>,
    names: Vec<&'a str>,
    version_index: Option<usize>,
    /// The key version column, which a refusal of its cell names (COD-41).
    version_name: &'a str,
}

/// Collects the nodes with styled columns, the root first, then each joined child in plan order.
fn styled_nodes<'a>(asm: &'a crate::plan::Assemble, out: &mut Vec<StyledNode<'a>>) -> Result<()> {
    let (styled, names): (Vec<crate::codec::StyledCol>, Vec<&str>) = asm
        .columns
        .iter()
        .filter(|c| !c.styles.is_empty())
        .map(|c| {
            let (codec, host) = crate::codec::split_host(&c.styles);
            (crate::codec::StyledCol { index: c.index, codec, host }, c.name.as_str())
        })
        .unzip();
    if !styled.is_empty() {
        let has_aes = styled.iter().any(|c| c.host.iter().any(|style| style == "aes"));
        let version_index = if has_aes {
            // COD-44: the planner selects the version column of every AES column, so a plan without one is broken: no version is assumed.
            let column = asm.aes_version.map(|at| &asm.columns[at]).ok_or_else(|| Error::Engine {
                code: crate::codes::INTERNAL.into(),
                msg: format!("{}: the plan reads an AES column without its key version column", asm.entity),
                source: None,
            })?;
            Some(column)
        } else {
            None
        };
        out.push(StyledNode {
            entity: &asm.entity,
            styled,
            names,
            version_index: version_index.map(|column| column.index),
            version_name: version_index.map_or("", |column| column.name.as_str()),
        });
    }
    for child in &asm.children {
        if let Some(assemble) = &child.assemble {
            styled_nodes(assemble, out)?;
        }
    }
    Ok(())
}

/// The key version a row stores in its version column: a positive 32-bit integer, as an integer, a float with no
/// fraction or its digits, with leading zeros, as a text or bytes (COD-44, COD-49, COD-53); otherwise
/// `aes version is not a positive 32-bit integer`, which names no value (INT-163).
pub(crate) fn stored_version(value: &Val) -> Result<i32> {
    let refused = || Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: "aes version is not a positive 32-bit integer".into(), source: None };
    let stored = match value {
        Val::I64(n) => *n,
        Val::F64(x) if x.is_finite() && x.trunc() == *x && x.abs() < 4_294_967_296.0 => *x as i64,
        Val::Str(_) | Val::Bytes(_) => {
            let digits = match value {
                Val::Str(text) => text.as_bytes(),
                Val::Bytes(bytes) => bytes.as_slice(),
                _ => unreachable!(),
            };
            if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
                return Err(refused());
            }
            let significant = &digits[digits.iter().take_while(|d| **d == b'0').count()..];
            if significant.len() > 10 {
                return Err(refused());
            }
            significant.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0'))
        }
        _ => return Err(refused()),
    };
    match i32::try_from(stored) {
        Ok(version) if version >= 1 => Ok(version),
        _ => Err(refused()),
    }
}

/// The key version of a row, read from the cell at `index` (COD-44).
fn aes_row_version(row: &[Val], index: usize) -> Result<i32> {
    let value = row.get(index).ok_or_else(|| Error::internal(format!("AES version cell index {index} is absent from the selected row")))?;
    stored_version(value)
}

/// Applies declared boolean column types to positional rows, including joined rows.
/// Drivers may return a boolean as an integer; an invalid value is a decode error.
pub(crate) fn decode_boolean_columns(asm: &crate::plan::Assemble, data: &mut [Vec<Val>]) -> Result<()> {
    for column in asm.columns.iter().filter(|column| column.typ == "bool") {
        for row in data.iter_mut() {
            let value = row.get_mut(column.index).ok_or_else(|| Error::internal(format!("boolean column {} has no value", column.name)))?;
            if !value.is_null() {
                *value = Val::Bool(value.as_bool().map_err(|error| crate::model::column_decode_error(&asm.entity, &column.name, error))?);
            }
        }
    }
    for child in &asm.children {
        if let Some(assemble) = &child.assemble {
            decode_boolean_columns(assemble, data)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod declared_boolean_tests {
    use super::{decode_boolean_columns, Val};
    use crate::plan::{Assemble, Child, OutCol};
    use std::sync::Arc;

    #[test]
    fn selected_boolean_groups_keep_their_declared_type() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let child = Assemble { columns: vec![OutCol { index: 2, name: "child_flag".into(), typ: "bool".into(), ..Default::default() }], ..Default::default() };
        let assemble = Assemble {
            columns: vec![
                OutCol { index: 0, name: "is_close".into(), typ: "bool".into(), ..Default::default() },
                OutCol { index: 1, name: "row_count".into(), typ: "i64".into(), ..Default::default() },
            ],
            children: vec![Child { assemble: Some(Arc::new(child)), ..Default::default() }],
            ..Default::default()
        };
        let mut rows = vec![vec![Val::I64(0), Val::I64(3), Val::I64(1)], vec![Val::I64(1), Val::I64(4), Val::Null]];
        decode_boolean_columns(&assemble, &mut rows).unwrap();
        assert_eq!(rows[0], vec![Val::Bool(false), Val::I64(3), Val::Bool(true)]);
        assert_eq!(rows[1], vec![Val::Bool(true), Val::I64(4), Val::Null]);
        let mut invalid = vec![vec![Val::I64(2), Val::I64(3), Val::I64(1)]];
        assert_eq!(decode_boolean_columns(&assemble, &mut invalid).unwrap_err().code(), "CODEC_DECODE");
    }
}

#[cfg(test)]
mod native_cell_bytes_tests {
    use super::{read_row, DriverRow};
    use crate::{db::Zone, Val};
    use sqlx::Connection as _;

    // Requirements: INT-142.
    #[tokio::test]
    async fn sqlite_driver_row_bytes_remain_exact() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let mut connection = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let row = sqlx::query("SELECT X'007F80FF41' AS payload").fetch_one(&mut connection).await.unwrap();
        let decoded = read_row(&DriverRow::Sqlite(row), 1, Zone).unwrap();
        assert_eq!(decoded, [Val::Bytes(vec![0x00, 0x7f, 0x80, 0xff, b'A'])]);
    }
}

#[cfg(test)]
#[path = "../tests/unit/numeric_text.rs"]
mod numeric_text_tests;
