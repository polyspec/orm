# dbspec 문서 파일 reader (docs/dbspec.md "Files"). 파일을 읽는 모든 도구가 이것으로
# 읽어, signature가 없는 파일을 parse 전에 거부한다.
from polyspec.orm.dbspec.model import DbspecDiagnostic

__all__ = ['DBSPEC_SIGNATURE', 'read_dbspec_bytes', 'read_dbspec_file']

# 모든 dbspec 문서 파일의 첫 byte다. header `dbspec 1 <document>`가 이것으로 시작한다.
DBSPEC_SIGNATURE = b'dbspec '


def read_dbspec_file(path: str):
    """parse할 `path`의 dbspec 문서 파일을 읽고 그 byte를 path를 이름으로
    read_dbspec_bytes로 확인한다. 읽을 수 없는 파일은 OSError를 던진다."""
    if not isinstance(path, str):
        raise TypeError('dbspec file path must be a string')
    with open(path, 'rb') as handle:
        return read_dbspec_bytes(path, handle.read())


def read_dbspec_bytes(name: str, data: bytes):
    """호출자가 자기 규칙으로 읽은 dbspec 문서 파일의 byte를 parse 전에 확인한다.
    `name`은 message가 파일을 가리키는 이름이다. DBSPEC_SIGNATURE로 시작하지 않는
    byte는 text 없이 line 1, column 1의 `signature` 진단 하나와 message `<name> is
    not a dbspec document`를, UTF-8이 아닌 byte는 첫 잘못된 byte의 줄과 칸에서
    `encoding` 진단 하나와 message `<name> is not valid UTF-8`을 돌려준다. 그 밖의
    byte는 진단 없이 그대로 text가 된다."""
    if not isinstance(name, str):
        raise TypeError('dbspec file name must be a string')
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError('dbspec file bytes must be bytes')
    # signature는 decode 전에 byte로 확인한다. 다른 형식의 파일과 빈 파일은 header가
    # 아니라 signature 진단이다.
    if len(data) < len(DBSPEC_SIGNATURE) or data[:len(DBSPEC_SIGNATURE)] != DBSPEC_SIGNATURE:
        return None, (DbspecDiagnostic('signature', 1, 1, f'{name} is not a dbspec document'),)
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        line, column = _invalid_utf8_position(data)
        return None, (DbspecDiagnostic('encoding', line, column, f'{name} is not valid UTF-8'),)
    return text, ()


def _invalid_utf8_position(data: bytes):
    """첫 잘못된 UTF-8 byte의 줄과 칸(code point 단위)이다. 줄은 LF로 나눈다."""
    line = 1
    column = 1
    i = 0
    while i < len(data):
        size = _utf8_size(data, i)
        if size == 0:
            break
        if data[i] == 0x0a:
            line += 1
            column = 1
        else:
            column += 1
        i += size
    return line, column


def _utf8_size(data: bytes, i: int) -> int:
    """`i`에서 시작하는 올바른 UTF-8 문자의 byte 수, 잘못된 byte이면 0이다."""
    b = data[i]
    if b < 0x80:
        return 1
    if 0xc2 <= b <= 0xdf:
        size, low, high = 2, 0x80, 0xbf
    elif b == 0xe0:
        size, low, high = 3, 0xa0, 0xbf
    elif b == 0xed:
        size, low, high = 3, 0x80, 0x9f
    elif 0xe1 <= b <= 0xef:
        size, low, high = 3, 0x80, 0xbf
    elif b == 0xf0:
        size, low, high = 4, 0x90, 0xbf
    elif 0xf1 <= b <= 0xf3:
        size, low, high = 4, 0x80, 0xbf
    elif b == 0xf4:
        size, low, high = 4, 0x80, 0x8f
    else:
        return 0
    if i + size > len(data):
        return 0
    if not low <= data[i + 1] <= high:
        return 0
    for k in range(2, size):
        if not 0x80 <= data[i + k] <= 0xbf:
            return 0
    return size
