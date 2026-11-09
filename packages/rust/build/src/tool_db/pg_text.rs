//! The text cells of PostgreSQL types whose output no session setting changes (INT-185). The driver reads every value in the
//! binary format, so each such value is written here in the form of the type's output function: `uuid`, `json`, `jsonb`,
//! `xml`, `bit`, `bit varying`, an enum, `inet`, `cidr`, `macaddr`, `macaddr8`, `tsvector`, `tsquery`, `pg_lsn`, `oid`, and an
//! array, range or composite whose elements and fields all have such an output, an integer, a boolean, a numeric or a
//! character type included. Any other type of an element or a field, such as a float, a date or `bytea`, has no text cell.
use sqlx::postgres::{PgTypeInfo, PgTypeKind};

use super::value::{malformed, malformed_by};

const BOOL: u32 = 16;
const BYTEA: u32 = 17;
const CHAR: u32 = 18;
const NAME: u32 = 19;
const INT8: u32 = 20;
const INT2: u32 = 21;
const INT4: u32 = 23;
const TEXT: u32 = 25;
const OID: u32 = 26;
const JSON: u32 = 114;
const FLOAT4: u32 = 700;
const FLOAT8: u32 = 701;
const XML: u32 = 142;
const CIDR: u32 = 650;
const MACADDR8: u32 = 774;
const MACADDR: u32 = 829;
const INET: u32 = 869;
const BPCHAR: u32 = 1042;
const VARCHAR: u32 = 1043;
const BIT: u32 = 1560;
const VARBIT: u32 = 1562;
const NUMERIC: u32 = 1700;
const RECORD: u32 = 2249;
const UUID: u32 = 2950;
const PG_LSN: u32 = 3220;
const TSVECTOR: u32 = 3614;
const TSQUERY: u32 = 3615;
const JSONB: u32 = 3802;

/// The types of a text cell of their own (INT-185).
const TEXT_TYPES: [u32; 14] = [UUID, JSON, JSONB, XML, BIT, VARBIT, INET, CIDR, MACADDR, MACADDR8, TSVECTOR, TSQUERY, PG_LSN, OID];
/// The types of another cell kind whose text output no setting changes, so that an element or a field of them is written.
const ELEMENT_TYPES: [u32; 10] = [BOOL, CHAR, NAME, INT8, INT2, INT4, TEXT, BPCHAR, VARCHAR, NUMERIC];

/// The builtin arrays of those types, by the OID of the array, for a field of an anonymous record, which names only its OID.
const ARRAYS: [(u32, u32); 24] = [
    (1000, BOOL),
    (1002, CHAR),
    (1003, NAME),
    (1016, INT8),
    (1005, INT2),
    (1007, INT4),
    (1009, TEXT),
    (1028, OID),
    (1014, BPCHAR),
    (1015, VARCHAR),
    (1231, NUMERIC),
    (2951, UUID),
    (199, JSON),
    (3807, JSONB),
    (143, XML),
    (1561, BIT),
    (1563, VARBIT),
    (1041, INET),
    (651, CIDR),
    (1040, MACADDR),
    (775, MACADDR8),
    (3643, TSVECTOR),
    (3645, TSQUERY),
    (3221, PG_LSN),
];

/// How a value of a type is written as text.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Form {
    Scalar(u32),
    Enum,
    Array(Box<Form>),
    Range(Box<Form>),
    Composite(Vec<Form>),
    /// An anonymous record: the type of each field is the OID that its value names.
    Record,
}

fn element(info: &PgTypeInfo) -> Option<Form> {
    match info.kind() {
        PgTypeKind::Simple => {
            let oid = info.oid()?.0;
            (TEXT_TYPES.contains(&oid) || ELEMENT_TYPES.contains(&oid)).then_some(Form::Scalar(oid))
        }
        PgTypeKind::Enum(_) => Some(Form::Enum),
        PgTypeKind::Array(inner) => element(inner).map(|form| Form::Array(Box::new(form))),
        PgTypeKind::Range(inner) => element(inner).map(|form| Form::Range(Box::new(form))),
        PgTypeKind::Composite(fields) => fields.iter().map(|(_, field)| element(field)).collect::<Option<Vec<_>>>().map(Form::Composite),
        PgTypeKind::Domain(base) => element(base),
        PgTypeKind::Pseudo => (info.oid()?.0 == RECORD).then_some(Form::Record),
    }
}

/// The form of a text cell of a column type, or None for a type that has a cell of another kind or no cell at all.
pub(crate) fn form(info: &PgTypeInfo) -> Option<Form> {
    match element(info)? {
        Form::Scalar(oid) if ELEMENT_TYPES.contains(&oid) => None,
        form => Some(form),
    }
}

/// The builtin types of a cell kind of their own, exactly those that INT-185 names: `smallint`, `integer`, `bigint`, `real`,
/// `double precision`, `numeric`, `boolean`, `text`, `varchar`, `bpchar`, `"char"`, `name` and `bytea`. The temporal types
/// are read before this; any other builtin type, such as `jsonpath`, `xid` or `tid`, is refused by INT-170.
const OWN_KINDS: [u32; 13] = [BOOL, BYTEA, CHAR, NAME, INT8, INT2, INT4, TEXT, FLOAT4, FLOAT8, BPCHAR, VARCHAR, NUMERIC];

/// Whether a column type is a builtin type of a cell kind of its own, or a domain over one. Any other type that has no text
/// form here, such as the base type of an extension (`citext`) or of a user, is refused by INT-170 (INT-185).
pub(crate) fn own_kind(info: &PgTypeInfo) -> bool {
    match info.kind() {
        PgTypeKind::Simple => info.oid().is_some_and(|oid| OWN_KINDS.contains(&oid.0)),
        PgTypeKind::Domain(base) => own_kind(base),
        _ => false,
    }
}

/// The form of a field of an anonymous record by its OID, or None when the field has no text output of its own.
fn form_of_oid(oid: u32) -> Option<Form> {
    if TEXT_TYPES.contains(&oid) || ELEMENT_TYPES.contains(&oid) {
        return Some(Form::Scalar(oid));
    }
    if oid == RECORD {
        return Some(Form::Record);
    }
    ARRAYS.iter().find(|(array, _)| *array == oid).map(|(_, inner)| Form::Array(Box::new(Form::Scalar(*inner))))
}

/// The bytes of a binary value, read from the front.
struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], sqlx::Error> {
        if self.0.len() < n {
            return Err(malformed("the value is shorter than its format"));
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }
    fn u8(&mut self) -> Result<u8, sqlx::Error> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, sqlx::Error> {
        let bytes = self.take(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }
    fn i32(&mut self) -> Result<i32, sqlx::Error> {
        let bytes = self.take(4)?;
        Ok(i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
    fn u32(&mut self) -> Result<u32, sqlx::Error> {
        Ok(self.i32()?.cast_unsigned())
    }
    /// A length-prefixed part: None for the length -1 of a NULL.
    fn part(&mut self) -> Result<Option<&'a [u8]>, sqlx::Error> {
        let length = self.i32()?;
        if length < 0 {
            return Ok(None);
        }
        let length = usize::try_from(length).map_err(|error| malformed_by("a length", error))?;
        self.take(length).map(Some)
    }
    /// A NUL-terminated text.
    fn c_text(&mut self) -> Result<&'a str, sqlx::Error> {
        let end = self.0.iter().position(|byte| *byte == 0).ok_or_else(|| malformed("a text without its terminator"))?;
        let text = std::str::from_utf8(&self.0[..end]).map_err(|error| malformed_by("a text that is not UTF-8", error))?;
        self.0 = &self.0[end + 1..];
        Ok(text)
    }
    fn end(&self) -> Result<(), sqlx::Error> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(malformed("the value is longer than its format"))
        }
    }
}

fn utf8(bytes: &[u8]) -> Result<String, sqlx::Error> {
    String::from_utf8(bytes.to_vec()).map_err(|error| malformed_by("a text that is not UTF-8", error))
}

/// The text of a binary value in the form `form`.
pub(crate) fn render(form: &Form, bytes: &[u8]) -> Result<String, sqlx::Error> {
    match form {
        Form::Scalar(oid) => scalar(*oid, bytes),
        Form::Enum => utf8(bytes),
        Form::Array(inner) => array(inner, bytes),
        Form::Range(inner) => range(inner, bytes),
        Form::Composite(fields) => composite(Some(fields), bytes),
        Form::Record => composite(None, bytes),
    }
}

fn fixed<const N: usize>(bytes: &[u8]) -> Result<[u8; N], sqlx::Error> {
    bytes.try_into().map_err(|error| malformed_by("the length of a fixed-size value", error))
}

fn scalar(oid: u32, bytes: &[u8]) -> Result<String, sqlx::Error> {
    Ok(match oid {
        BOOL => match bytes {
            [0] => "f".into(),
            [1] => "t".into(),
            _ => return Err(malformed("a boolean")),
        },
        // charout: the NUL byte is the empty text, and a byte with its high bit set is written as an octal escape.
        CHAR => match fixed::<1>(bytes)?[0] {
            0 => String::new(),
            byte if byte >= 0x80 => format!("\\{byte:03o}"),
            byte => char::from(byte).to_string(),
        },
        INT2 => i16::from_be_bytes(fixed(bytes)?).to_string(),
        INT4 => i32::from_be_bytes(fixed(bytes)?).to_string(),
        INT8 => i64::from_be_bytes(fixed(bytes)?).to_string(),
        OID => u32::from_be_bytes(fixed(bytes)?).to_string(),
        NAME | TEXT | BPCHAR | VARCHAR | JSON | XML => utf8(bytes)?,
        JSONB => match bytes.split_first() {
            Some((1, text)) => utf8(text)?,
            _ => return Err(malformed("a jsonb version")),
        },
        NUMERIC => numeric(bytes)?,
        UUID => {
            let hex: String = fixed::<16>(bytes)?.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
        }
        BIT | VARBIT => {
            let mut reader = Reader(bytes);
            let length = usize::try_from(reader.i32()?).map_err(|error| malformed_by("a bit length", error))?;
            let data = reader.take(length.div_ceil(8))?;
            reader.end()?;
            (0..length).map(|at| if data[at / 8] & (0x80 >> (at % 8)) != 0 { '1' } else { '0' }).collect()
        }
        INET | CIDR => network(oid == CIDR, bytes)?,
        MACADDR => fixed::<6>(bytes)?.iter().map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(":"),
        MACADDR8 => fixed::<8>(bytes)?.iter().map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(":"),
        PG_LSN => {
            let lsn = u64::from_be_bytes(fixed(bytes)?);
            format!("{:X}/{:X}", lsn >> 32, lsn & 0xffff_ffff)
        }
        TSVECTOR => tsvector(bytes)?,
        TSQUERY => tsquery(bytes)?,
        _ => return Err(malformed("a type with no text form")),
    })
}

/// numeric_out: the plain digits of the display scale, or NaN and the infinities.
pub(crate) fn numeric(bytes: &[u8]) -> Result<String, sqlx::Error> {
    let mut reader = Reader(bytes);
    let count = usize::from(reader.u16()?);
    let weight = i32::from(reader.u16()?.cast_signed());
    let sign = reader.u16()?;
    let scale = usize::from(reader.u16()?);
    let digits = (0..count).map(|_| reader.u16()).collect::<Result<Vec<_>, _>>()?;
    reader.end()?;
    let mut text = match sign {
        0x0000 => String::new(),
        0x4000 => "-".to_owned(),
        0xC000 => return Ok("NaN".into()),
        0xD000 => return Ok("Infinity".into()),
        0xF000 => return Ok("-Infinity".into()),
        _ => return Err(malformed("a numeric sign")),
    };
    if digits.iter().any(|digit| *digit > 9999) {
        return Err(malformed("a numeric digit"));
    }
    // A position before the first digit group or past the last one is a zero group.
    let digit = |at: i32| match usize::try_from(at) {
        Ok(at) => digits.get(at).copied().unwrap_or(0),
        Err(_before_first) => 0,
    };
    if weight < 0 {
        text.push('0');
    } else {
        for at in 0..=weight {
            if at == 0 {
                text.push_str(&digit(at).to_string());
            } else {
                text.push_str(&format!("{:04}", digit(at)));
            }
        }
    }
    if scale > 0 {
        let mut fraction = String::new();
        let mut at = weight + 1;
        while fraction.len() < scale {
            fraction.push_str(&format!("{:04}", digit(at)));
            at += 1;
        }
        fraction.truncate(scale);
        text.push('.');
        text.push_str(&fraction);
    }
    Ok(text)
}

/// network_out: the address, with its prefix length when it is not that of one host, and always for a cidr.
fn network(cidr: bool, bytes: &[u8]) -> Result<String, sqlx::Error> {
    let mut reader = Reader(bytes);
    let family = reader.u8()?;
    let bits = reader.u8()?;
    let _is_cidr = reader.u8()?;
    let length = usize::from(reader.u8()?);
    let address = reader.take(length)?;
    reader.end()?;
    let (text, max) = match (family, address.len()) {
        (2, 4) => (address.iter().map(u8::to_string).collect::<Vec<_>>().join("."), 32),
        (3, 16) => (ipv6(fixed(address)?), 128),
        _ => return Err(malformed("a network address")),
    };
    Ok(if cidr || bits != max { format!("{text}/{bits}") } else { text })
}

/// The IPv6 text of PostgreSQL's inet_net_ntop: the longest run of two or more zero words is `::`, and an address of six zero
/// words, of five then ffff, or of seven then a word other than 1 ends with its IPv4 text.
type Run = (usize, usize);

fn ipv6(address: [u8; 16]) -> String {
    let words: Vec<u16> = address.chunks(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect();
    // A run of zero words: its first word and its length.
    let (mut best, mut current): (Option<Run>, Option<Run>) = (None, None);
    for (at, word) in words.iter().enumerate() {
        if *word == 0 {
            current = Some(current.map_or((at, 1), |(base, length)| (base, length + 1)));
        } else if let Some(run) = current.take() {
            if best.is_none_or(|(_, length)| run.1 > length) {
                best = Some(run);
            }
        }
    }
    if let Some(run) = current {
        if best.is_none_or(|(_, length)| run.1 > length) {
            best = Some(run);
        }
    }
    let best = best.filter(|(_, length)| *length >= 2);
    let mut text = String::new();
    let mut at = 0;
    while at < 8 {
        if let Some((base, length)) = best {
            if (base..base + length).contains(&at) {
                if at == base {
                    text.push(':');
                }
                at += 1;
                continue;
            }
        }
        if at != 0 {
            text.push(':');
        }
        if at == 6 {
            if let Some((0, length)) = best {
                if length == 6 || (length == 7 && words[7] != 1) || (length == 5 && words[5] == 0xffff) {
                    text.push_str(&address[12..].iter().map(u8::to_string).collect::<Vec<_>>().join("."));
                    return text;
                }
            }
        }
        text.push_str(&format!("{:x}", words[at]));
        at += 1;
    }
    if best.is_some_and(|(base, length)| base + length == 8) {
        text.push(':');
    }
    text
}

/// A lexeme or an operand of a text search value in single quotes, its quotes and backslashes doubled.
fn quoted_lexeme(text: &str) -> String {
    let mut out = String::from("'");
    for ch in text.chars() {
        if ch == '\'' || ch == '\\' {
            out.push(ch);
        }
        out.push(ch);
    }
    out.push('\'');
    out
}

/// tsvectorout: each lexeme in quotes, with its positions and their weights A, B and C.
fn tsvector(bytes: &[u8]) -> Result<String, sqlx::Error> {
    let mut reader = Reader(bytes);
    let count = reader.u32()?;
    let mut lexemes = Vec::new();
    for _ in 0..count {
        let mut lexeme = quoted_lexeme(reader.c_text()?);
        let positions = reader.u16()?;
        for at in 0..positions {
            let position = reader.u16()?;
            lexeme.push(if at == 0 { ':' } else { ',' });
            lexeme.push_str(&(position & 0x3fff).to_string());
            match position >> 14 {
                3 => lexeme.push('A'),
                2 => lexeme.push('B'),
                1 => lexeme.push('C'),
                _ => {}
            }
        }
        lexemes.push(lexeme);
    }
    reader.end()?;
    Ok(lexemes.join(" "))
}

enum Query {
    Operand { text: String, weight: u8, prefix: bool },
    Not(Box<Query>),
    Binary { operator: u8, distance: i16, left: Box<Query>, right: Box<Query> },
}

const OP_NOT: u8 = 1;
const OP_AND: u8 = 2;
const OP_OR: u8 = 3;
const OP_PHRASE: u8 = 4;

fn priority(operator: u8) -> i32 {
    match operator {
        OP_NOT => 4,
        OP_AND => 2,
        OP_OR => 1,
        _ => 3,
    }
}

/// One item of a tsquery in its polish order, which holds an operator before its right operand and then its left one.
fn query_item(reader: &mut Reader<'_>, left: &mut u32) -> Result<Query, sqlx::Error> {
    if *left == 0 {
        return Err(malformed("a tsquery operator without its operands"));
    }
    *left -= 1;
    match reader.u8()? {
        1 => {
            let weight = reader.u8()?;
            let prefix = reader.u8()? != 0;
            Ok(Query::Operand { text: reader.c_text()?.to_owned(), weight, prefix })
        }
        2 => match reader.u8()? {
            OP_NOT => Ok(Query::Not(Box::new(query_item(reader, left)?))),
            operator @ (OP_AND | OP_OR | OP_PHRASE) => {
                let distance = if operator == OP_PHRASE { reader.u16()?.cast_signed() } else { 0 };
                let right = query_item(reader, left)?;
                let left_operand = query_item(reader, left)?;
                Ok(Query::Binary { operator, distance, left: Box::new(left_operand), right: Box::new(right) })
            }
            _ => Err(malformed("a tsquery operator")),
        },
        _ => Err(malformed("a tsquery item")),
    }
}

/// The infix text of tsqueryout, with the parentheses of its operator priorities.
fn infix(query: &Query, parent: i32, right_phrase: bool, out: &mut String) {
    match query {
        Query::Operand { text, weight, prefix } => {
            out.push_str(&quoted_lexeme(text));
            if *weight != 0 || *prefix {
                out.push(':');
                if *prefix {
                    out.push('*');
                }
                for (bit, letter) in [(8, 'A'), (4, 'B'), (2, 'C'), (1, 'D')] {
                    if weight & bit != 0 {
                        out.push(letter);
                    }
                }
            }
        }
        Query::Not(operand) => {
            let own = priority(OP_NOT);
            if own < parent {
                out.push_str("( ");
            }
            out.push('!');
            infix(operand, own, false, out);
            if own < parent {
                out.push_str(" )");
            }
        }
        Query::Binary { operator, distance, left, right } => {
            let own = priority(*operator);
            let parenthesis = own < parent || (*operator == OP_PHRASE && right_phrase);
            if parenthesis {
                out.push_str("( ");
            }
            let mut right_text = String::new();
            infix(right, own, *operator == OP_PHRASE, &mut right_text);
            infix(left, own, false, out);
            match *operator {
                OP_OR => out.push_str(" | "),
                OP_AND => out.push_str(" & "),
                _ if *distance != 1 => out.push_str(&format!(" <{distance}> ")),
                _ => out.push_str(" <-> "),
            }
            out.push_str(&right_text);
            if parenthesis {
                out.push_str(" )");
            }
        }
    }
}

fn tsquery(bytes: &[u8]) -> Result<String, sqlx::Error> {
    let mut reader = Reader(bytes);
    let mut left = reader.u32()?;
    if left == 0 {
        reader.end()?;
        return Ok(String::new());
    }
    let query = query_item(&mut reader, &mut left)?;
    if left != 0 {
        return Err(malformed("a tsquery with items past its root"));
    }
    reader.end()?;
    let mut out = String::new();
    infix(&query, -1, false, &mut out);
    Ok(out)
}

fn is_space(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c')
}

/// array_out: an element in double quotes when it is empty, is NULL in any case or holds a brace, a quote, a backslash, the
/// comma or a space, with its quotes and backslashes escaped by a backslash.
fn array_element(text: &str) -> String {
    let quote = text.is_empty() || text.eq_ignore_ascii_case("NULL") || text.chars().any(|ch| matches!(ch, '{' | '}' | '"' | '\\' | ',') || is_space(ch));
    if !quote {
        return text.to_owned();
    }
    in_quotes(text, Some('\\'))
}

/// `text` in double quotes with each of its quotes and backslashes after `escape`, or doubled when `escape` is `None`.
fn in_quotes(text: &str, escape: Option<char>) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        if ch == '"' || ch == '\\' {
            out.push(escape.unwrap_or(ch));
        }
        out.push(ch);
    }
    out.push('"');
    out
}

fn array(inner: &Form, bytes: &[u8]) -> Result<String, sqlx::Error> {
    let mut reader = Reader(bytes);
    let dimensions = usize::try_from(reader.i32()?).map_err(|error| malformed_by("an array dimension count", error))?;
    let _has_null = reader.i32()?;
    let _element = reader.u32()?;
    let mut sizes = Vec::new();
    let mut bounds = Vec::new();
    for _ in 0..dimensions {
        sizes.push(usize::try_from(reader.i32()?).map_err(|error| malformed_by("an array dimension", error))?);
        bounds.push(reader.i32()?);
    }
    if dimensions == 0 {
        reader.end()?;
        return Ok("{}".into());
    }
    let total = sizes.iter().try_fold(1usize, |total, size| total.checked_mul(*size)).ok_or_else(|| malformed("an array size"))?;
    let mut elements = Vec::with_capacity(total.min(bytes.len()));
    for _ in 0..total {
        elements.push(match reader.part()? {
            None => "NULL".to_owned(),
            Some(value) => array_element(&render(inner, value)?),
        });
    }
    reader.end()?;
    let mut out = String::new();
    if bounds.iter().any(|bound| *bound != 1) {
        for (size, bound) in sizes.iter().zip(&bounds) {
            let upper = i64::from(*bound) + i64::try_from(*size).map_err(|error| malformed_by("an array dimension", error))? - 1;
            out.push_str(&format!("[{bound}:{upper}]"));
        }
        out.push('=');
    }
    let mut next = elements.into_iter();
    nest(&sizes, &mut next, &mut out);
    Ok(out)
}

fn nest(sizes: &[usize], elements: &mut impl Iterator<Item = String>, out: &mut String) {
    out.push('{');
    for at in 0..sizes[0] {
        if at > 0 {
            out.push(',');
        }
        if sizes.len() > 1 {
            nest(&sizes[1..], elements, out);
        } else if let Some(element) = elements.next() {
            out.push_str(&element);
        }
    }
    out.push('}');
}

/// range_bound_escape and record_out: a bound or a field in double quotes when it is empty or holds a quote, a backslash, a
/// parenthesis, a comma or a space (and for a range a bracket), with its quotes and backslashes doubled.
fn doubled_quotes(text: &str, brackets: bool) -> String {
    let quote = text.is_empty() || text.chars().any(|ch| matches!(ch, '"' | '\\' | '(' | ')' | ',') || (brackets && matches!(ch, '[' | ']')) || is_space(ch));
    if !quote {
        return text.to_owned();
    }
    in_quotes(text, None)
}

fn range(inner: &Form, bytes: &[u8]) -> Result<String, sqlx::Error> {
    const EMPTY: u8 = 0x01;
    const LOWER_INCLUSIVE: u8 = 0x02;
    const UPPER_INCLUSIVE: u8 = 0x04;
    const LOWER_INFINITE: u8 = 0x08;
    const UPPER_INFINITE: u8 = 0x10;
    let mut reader = Reader(bytes);
    let flags = reader.u8()?;
    if flags & EMPTY != 0 {
        reader.end()?;
        return Ok("empty".into());
    }
    let mut bound = |infinite: bool| -> Result<String, sqlx::Error> {
        if infinite {
            return Ok(String::new());
        }
        let value = reader.part()?.ok_or_else(|| malformed("a range bound"))?;
        Ok(doubled_quotes(&render(inner, value)?, true))
    };
    let lower = bound(flags & LOWER_INFINITE != 0)?;
    let upper = bound(flags & UPPER_INFINITE != 0)?;
    reader.end()?;
    Ok(format!("{}{lower},{upper}{}", if flags & LOWER_INCLUSIVE != 0 { '[' } else { '(' }, if flags & UPPER_INCLUSIVE != 0 { ']' } else { ')' }))
}

fn composite(fields: Option<&[Form]>, bytes: &[u8]) -> Result<String, sqlx::Error> {
    let mut reader = Reader(bytes);
    let count = usize::try_from(reader.i32()?).map_err(|error| malformed_by("a field count", error))?;
    if fields.is_some_and(|fields| fields.len() != count) {
        return Err(malformed("a field count"));
    }
    let mut parts = Vec::new();
    for at in 0..count {
        let oid = reader.u32()?;
        let value = reader.part()?;
        let form = match fields {
            Some(fields) => fields[at].clone(),
            // A field of an anonymous record whose type has no text output has no text cell (INT-170).
            None => form_of_oid(oid).ok_or_else(|| super::value::refuse(super::value::UNSUPPORTED_NATIVE_TYPE))?,
        };
        parts.push(match value {
            None => String::new(),
            Some(value) => doubled_quotes(&render(&form, value)?, false),
        });
    }
    reader.end()?;
    Ok(format!("({})", parts.join(",")))
}
