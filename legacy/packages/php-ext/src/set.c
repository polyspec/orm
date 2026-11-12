/*
 * The set reader Dbspec::readSet of the extension (docs/spec/dbspec.md "Document sets"), the twin of the PHP client's
 * SetReader (packages/php/src/Dbspec/SetReader.php): the set file, its JSON, each path and the read with the
 * file identity, in that order, with the same rules, paths and messages. The file system is examined with the
 * platform's calls: lstat, opendir and open with fstat on POSIX; on Windows CreateFileW without following a
 * reparse point, a name surrogate tag (IsReparseTagNameSurrogate) as the symbolic link, FindFirstFileW for the
 * listing and the volume serial number with the 64-bit file index of the opened handle as the identity. A failed
 * call is named by the platform's text, strerror(errno) or FormatMessage, unchanged (DBS-18a, INT-187). The JSON is
 * parsed by PHP's own parser (ext/json), which the PHP client uses too.
 */
#include "dbspec.h"
#include "message_quote.h"
#include "ext/json/php_json.h"
#include "ext/spl/spl_exceptions.h"

#ifdef PHP_WIN32
#include <windows.h>
#else
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#define SET_NAME "dbspec-set.json"
/* The deepest nesting of the set file, the object counting as one. */
#define SET_DEPTH 64
/* The depth that PHP's parser is given: the reader's own scan checks the nesting, so the parser checks only the
 * syntax. */
#define SET_PARSER_DEPTH 2147483646
/* The size of each read of a file. */
#define SET_CHUNK 8192

typedef struct {
    str rule, path, message;
} set_error;
typedef VEC(set_error) set_errors;

typedef struct {
    str path, bytes;
} set_file;
typedef VEC(set_file) set_files;

typedef enum { KIND_NONE, KIND_LINK, KIND_DIR, KIND_FILE, KIND_OTHER } set_kind;

/* The listing of each directory during one read: a strs, or NULL when the directory cannot be listed, and then the
 * platform's error of the listing in failures. */
typedef struct {
    smap listings;
    smap failures;
} set_reader;

static set_error mkerror(const char *rule, str path, str message)
{
    set_error e = {str_c(rule), path, message};
    return e;
}

/* A NUL-terminated copy of s for a system call (s holds no NUL: the caller rejected one). */
static const char *cpath(str s)
{
    return str_of(s.s, s.n).s;
}

static bool is_separator(char c)
{
#ifdef PHP_WIN32
    return c == '/' || c == '\\';
#else
    return c == '/';
#endif
}

/* -------------------------------------------------------------- the platform */

/* The identity of a file: its device (volume) and its inode (64-bit file index). */
static str identity_of(unsigned long long device, unsigned long long index)
{
    char text[48];
    snprintf(text, sizeof text, "%llu:%llu", device, index);
    return str_c(text);
}

/* Opens path once and takes its identity and then, unless the identity is in seen, its bytes from that handle.
 * Returns false with *reason, the platform's error, on a failure; *duplicate is the earlier path of the same
 * identity. Each platform defines it below. */
static bool open_file(str path, const smap *seen, str *identity, str *bytes, str *duplicate, str *reason);

#ifdef PHP_WIN32

/* The UTF-16 form of a UTF-8 path, or NULL when the bytes are not UTF-8. */
static wchar_t *wide(str s)
{
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.s, (int)s.n, NULL, 0);
    if (n <= 0 && s.n > 0) {
        return NULL;
    }
    wchar_t *w = dbs_alloc(((size_t)n + 1) * sizeof(wchar_t));
    if (n > 0) {
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.s, (int)s.n, w, n);
    }
    w[n] = 0;
    return w;
}

/* The UTF-8 form of a UTF-16 name, or SNULL when it holds a lone surrogate. */
static str narrow(const wchar_t *w)
{
    int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, w, -1, NULL, 0, NULL, NULL);
    if (n <= 0) {
        return SNULL;
    }
    char *s = dbs_alloc((size_t)n);
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, w, -1, s, n, NULL, NULL);
    return (str){s, (size_t)n - 1};
}

/* The system's message for the error code. */
static str system_error(DWORD code)
{
    wchar_t *text = NULL;
    DWORD n = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, code, 0, (LPWSTR)&text, 0, NULL);
    if (n == 0 || text == NULL) {
        return fmt("error %u", (size_t)code);
    }
    while (n > 0 && (text[n - 1] == L'\r' || text[n - 1] == L'\n' || text[n - 1] == L'.')) {
        text[--n] = 0;
    }
    str s = narrow(text);
    LocalFree(text);
    return s.s == NULL ? fmt("error %u", (size_t)code) : s;
}

/* The error of a path that is no UTF-8 text, which no Windows call can name. */
static str not_utf8(void)
{
    return system_error(ERROR_NO_UNICODE_TRANSLATION);
}

static set_kind path_kind(str path, bool follow, str *failure)
{
    wchar_t *w = wide(path);
    if (w == NULL) {
        *failure = not_utf8();
        return KIND_NONE;
    }
    HANDLE h = CreateFileW(w, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | (follow ? 0 : FILE_FLAG_OPEN_REPARSE_POINT), NULL);
    if (h == INVALID_HANDLE_VALUE) {
        *failure = system_error(GetLastError());
        return KIND_NONE;
    }
    FILE_ATTRIBUTE_TAG_INFO info;
    BOOL ok = GetFileInformationByHandleEx(h, FileAttributeTagInfo, &info, sizeof info);
    DWORD failed = ok ? 0 : GetLastError();
    DWORD type = GetFileType(h);
    CloseHandle(h);
    if (!ok) {
        *failure = system_error(failed);
        return KIND_NONE;
    }
    if (!follow && (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && IsReparseTagNameSurrogate(info.ReparseTag)) {
        return KIND_LINK;
    }
    if (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
        return KIND_DIR;
    }
    return type == FILE_TYPE_DISK ? KIND_FILE : KIND_OTHER;
}

/* The names that dir lists, or false with *failure when it cannot be listed. A name that is no UTF-16 text (a lone
 * surrogate) equals no segment, since a segment is UTF-8 and so its UTF-16 code units hold no lone surrogate. */
static bool list_dir(str dir, strs *out, str *failure)
{
    bool bare = dir.n > 0 && (is_separator(dir.s[dir.n - 1]) || (dir.n == 2 && dir.s[1] == ':'));
    wchar_t *pattern = wide(fmt(bare ? "%S*" : "%S\\*", dir));
    if (pattern == NULL) {
        *failure = not_utf8();
        return false;
    }
    WIN32_FIND_DATAW found;
    HANDLE h = FindFirstFileW(pattern, &found);
    if (h == INVALID_HANDLE_VALUE) {
        *failure = system_error(GetLastError());
        return false;
    }
    do {
        str name = narrow(found.cFileName);
        if (name.s != NULL) {
            PUSH(*out, name);
        }
    } while (FindNextFileW(h, &found));
    DWORD last = GetLastError();
    FindClose(h);
    if (last != ERROR_NO_MORE_FILES) {
        *failure = system_error(last);
        return false;
    }
    return true;
}

static bool open_file(str path, const smap *seen, str *identity, str *bytes, str *duplicate, str *reason)
{
    wchar_t *w = wide(path);
    if (w == NULL) {
        *reason = not_utf8();
        return false;
    }
    HANDLE h = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        *reason = system_error(GetLastError());
        return false;
    }
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(h, &info)) {
        *reason = system_error(GetLastError());
        CloseHandle(h);
        return false;
    }
    *identity = identity_of((unsigned long long)info.dwVolumeSerialNumber, ((unsigned long long)info.nFileIndexHigh << 32) | info.nFileIndexLow);
    str *earlier = seen == NULL ? NULL : smap_get(seen, *identity);
    if (earlier != NULL) {
        *duplicate = *earlier;
        CloseHandle(h);
        return true;
    }
    sbuf b = {0};
    char chunk[SET_CHUNK];
    for (;;) {
        DWORD got = 0;
        if (!ReadFile(h, chunk, SET_CHUNK, &got, NULL)) {
            *reason = system_error(GetLastError());
            CloseHandle(h);
            return false;
        }
        if (got == 0) {
            break;
        }
        sb_add(&b, chunk, got);
    }
    CloseHandle(h);
    *bytes = b.n == 0 ? SL("") : sb_str(&b);
    return true;
}

#else

static set_kind path_kind(str path, bool follow, str *failure)
{
    struct stat st;
    if ((follow ? stat(cpath(path), &st) : lstat(cpath(path), &st)) != 0) {
        *failure = str_c(strerror(errno));
        return KIND_NONE;
    }
    if (S_ISLNK(st.st_mode)) {
        return KIND_LINK;
    }
    if (S_ISDIR(st.st_mode)) {
        return KIND_DIR;
    }
    return S_ISREG(st.st_mode) ? KIND_FILE : KIND_OTHER;
}

/* The names that dir lists, or false with *failure when it cannot be listed. */
static bool list_dir(str dir, strs *out, str *failure)
{
    DIR *d = opendir(cpath(dir));
    if (d == NULL) {
        *failure = str_c(strerror(errno));
        return false;
    }
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(d);
        if (entry == NULL) {
            break;
        }
        PUSH(*out, str_c(entry->d_name));
    }
    int failed = errno;
    closedir(d);
    if (failed != 0) {
        *failure = str_c(strerror(failed));
        return false;
    }
    return true;
}

static bool open_file(str path, const smap *seen, str *identity, str *bytes, str *duplicate, str *reason)
{
    int fd = open(cpath(path), O_RDONLY);
    if (fd < 0) {
        *reason = str_c(strerror(errno));
        return false;
    }
    struct stat st;
    if (fstat(fd, &st) != 0) {
        *reason = str_c(strerror(errno));
        close(fd);
        return false;
    }
    *identity = identity_of((unsigned long long)st.st_dev, (unsigned long long)st.st_ino);
    str *earlier = seen == NULL ? NULL : smap_get(seen, *identity);
    if (earlier != NULL) {
        *duplicate = *earlier;
        close(fd);
        return true;
    }
    sbuf b = {0};
    char chunk[SET_CHUNK];
    for (;;) {
        ssize_t got = read(fd, chunk, SET_CHUNK);
        if (got < 0) {
            if (errno == EINTR) {
                continue;
            }
            *reason = str_c(strerror(errno));
            close(fd);
            return false;
        }
        if (got == 0) {
            break;
        }
        sb_add(&b, chunk, (size_t)got);
    }
    close(fd);
    *bytes = b.n == 0 ? SL("") : sb_str(&b);
    return true;
}

#endif

/* ------------------------------------------------------------ the reader */

/* Whether dir lists name: 1, 0, or -1 with *failure, the platform's error, when dir cannot be listed. */
static int lists(set_reader *r, str dir, str name, str *failure)
{
    strs *listing;
    if (smap_has(&r->listings, dir)) {
        listing = smap_get(&r->listings, dir);
    } else {
        listing = dbs_alloc(sizeof *listing);
        *listing = (strs){0};
        str *why = dbs_alloc(sizeof *why);
        *why = SNULL;
        if (!list_dir(dir, listing, why)) {
            listing = NULL;
            smap_set(&r->failures, dir, why);
        }
        smap_set(&r->listings, dir, listing);
    }
    if (listing == NULL) {
        *failure = *(str *)smap_get(&r->failures, dir);
        return -1;
    }
    return strs_has(listing, name) ? 1 : 0;
}

/* The root without its trailing separators, so that lstat examines the root itself: POSIX lstat of `alias/`
 * follows the link alias. A root of only separators stays one, and on Windows `C:\` stays. */
static str trimmed(str root)
{
    size_t n = root.n;
    while (n > 0 && is_separator(root.s[n - 1])) {
        n--;
    }
    if (n == 0) {
        return str_sub(root, 0, 1);
    }
#ifdef PHP_WIN32
    if (n == 2 && root.s[1] == ':' && root.n > 2) {
        return str_sub(root, 0, 3);
    }
#endif
    return str_sub(root, 0, n);
}

/* s quoted as INT-187 states. */
static str quoted(str s)
{
    return dbs_quote(s);
}

/* The kinds the scan gives a value. */
#define V_OBJECT "object"
#define V_ARRAY "array"

typedef struct {
    bool object, expecting_key;
    smap keys;
} scan_frame;

/*
 * Scans JSON text (RFC 8259): the kind of the top-level value, the deepest nesting of its containers, the kind of
 * each value of the top-level object by its key (in members, in their order), and the first key repeated in an
 * object at any depth. A key is decoded by PHP's parser, so that escapes compare as the characters they write.
 */
static void scan(str text, str *top, size_t *depth, smap *members, str *repeated)
{
    VEC(scan_frame) frames = {0};
    str key = SNULL;
    *top = SNULL;
    *depth = 0;
    *repeated = SNULL;
#define VALUE(kind) do { \
        if (frames.n == 0) { \
            if (top->s == NULL) *top = SL(kind); \
        } else if (frames.n == 1 && frames.v[0].object) { \
            str *k_ = dbs_alloc(sizeof *k_); \
            *k_ = SL(kind); \
            smap_set(members, key, k_); \
        } \
    } while (0)
    for (size_t i = 0; i < text.n; i++) {
        char c = text.s[i];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ':') {
            continue;
        }
        if (c == '"') {
            size_t start = i;
            for (i++; text.s[i] != '"'; i++) {
                if (text.s[i] == '\\') {
                    i++;
                }
            }
            scan_frame *last = frames.n == 0 ? NULL : &frames.v[frames.n - 1];
            if (last != NULL && last->object && last->expecting_key) {
                /* PHP's scanner ends its input at a NUL byte past the end, which a copy of the token has. */
                str token = str_of(text.s + start, i - start + 1);
                zval decoded;
                php_json_decode_ex(&decoded, token.s, token.n, 0, SET_PARSER_DEPTH);
                str name = Z_TYPE(decoded) == IS_STRING ? str_z(Z_STR(decoded)) : SNULL;
                zval_ptr_dtor(&decoded);
                if (smap_has(&last->keys, name) && repeated->s == NULL) {
                    *repeated = name;
                }
                smap_set(&last->keys, name, TRUEP);
                last->expecting_key = false;
                if (frames.n == 1) {
                    key = name;
                }
            } else {
                VALUE("string");
            }
            continue;
        }
        if (c == '{' || c == '[') {
            if (c == '{') {
                VALUE(V_OBJECT);
            } else {
                VALUE(V_ARRAY);
            }
            scan_frame f = {c == '{', c == '{', {0}};
            PUSH(frames, f);
            if (frames.n > *depth) {
                *depth = frames.n;
            }
            continue;
        }
        if (c == '}' || c == ']') {
            frames.n--;
            continue;
        }
        if (c == ',') {
            scan_frame *last = &frames.v[frames.n - 1];
            last->expecting_key = last->object;
            continue;
        }
        /* A number or a literal runs to the next structural character or white space. */
        size_t end = i;
        while (end < text.n && strchr(" \t\n\r,:]}", text.s[end]) == NULL) {
            end++;
        }
        str word = str_sub(text, i, end - i);
        if (str_eqc(word, "true") || str_eqc(word, "false")) {
            VALUE("boolean");
        } else if (str_eqc(word, "null")) {
            VALUE("null");
        } else {
            VALUE("number");
        }
        i = end - 1;
    }
#undef VALUE
    if (top->s == NULL) {
        *top = SL("");
    }
}

/* Whether a top-level value of the kind kind, decoded as v, is an array of strings. */
static bool strings(str kind, zval *v)
{
    if (!str_eqc(kind, V_ARRAY) || Z_TYPE_P(v) != IS_ARRAY) {
        return false;
    }
    zval *item;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(v), item) {
        if (Z_TYPE_P(item) != IS_STRING) {
            return false;
        }
    } ZEND_HASH_FOREACH_END();
    return true;
}

static void put_strings(zval *v, strs *out)
{
    zval *item;
    ZEND_HASH_FOREACH_VAL(Z_ARRVAL_P(v), item) {
        PUSH(*out, str_z(Z_STR_P(item)));
    } ZEND_HASH_FOREACH_END();
}

/* The message of PHP's parser for its last error. */
static str json_error_message(void)
{
    zval fn, ret;
    ZVAL_STRING(&fn, "json_last_error_msg");
    str message = SL("Syntax error");
    if (call_user_function(NULL, NULL, &fn, &ret, 0, NULL) == SUCCESS && Z_TYPE(ret) == IS_STRING) {
        message = str_z(Z_STR(ret));
    }
    zval_ptr_dtor(&fn);
    zval_ptr_dtor(&ret);
    return message;
}

/* The UTF-16 code unit of the escape \uXXXX at text[i], or -1 when none is there. */
static long unit_at(str text, size_t i)
{
    if (i + 6 > text.n || text.s[i] != '\\' || text.s[i + 1] != 'u') {
        return -1;
    }
    long unit = 0;
    for (size_t k = 2; k < 6; k++) {
        int digit = orm_hex_digit(text.s[i + k]);
        if (digit < 0) {
            return -1;
        }
        unit = unit * 16 + digit;
    }
    return unit;
}

/* text with each escape of a lone surrogate written as \u0000; a pair of a high and a low surrogate escape stays, and
 * so does every other escape, so the text is JSON exactly when text is, but for the surrogates. */
static str without_lone_surrogates(str text)
{
    sbuf b = {0};
    size_t i = 0;
    while (i < text.n) {
        if (text.s[i] != '\\' || i + 1 >= text.n) {
            sb_add(&b, text.s + i, 1);
            i++;
            continue;
        }
        long unit = unit_at(text, i);
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            long low = unit_at(text, i + 6);
            if (low >= 0xDC00 && low <= 0xDFFF) {
                sb_add(&b, text.s + i, 12);
                i += 12;
                continue;
            }
        }
        if (unit >= 0xD800 && unit <= 0xDFFF) {
            sb_add(&b, "\\u0000", 6);
            i += 6;
            continue;
        }
        sb_add(&b, text.s + i, 2);
        i += 2;
    }
    return b.n == 0 ? SL("") : sb_str(&b);
}

static size_t json_space(str t, size_t i)
{
    while (i < t.n && (t.s[i] == ' ' || t.s[i] == '\t' || t.s[i] == '\n' || t.s[i] == '\r')) {
        i++;
    }
    return i;
}

/* The end of the JSON string at t.s[i], or 0 when none starts there. */
static size_t json_string(str t, size_t i)
{
    if (i >= t.n || t.s[i] != '"') {
        return 0;
    }
    for (i++; i < t.n; i++) {
        unsigned char c = (unsigned char)t.s[i];
        if (c == '"') {
            return i + 1;
        }
        if (c < 0x20) {
            return 0;
        }
        if (c == '\\') {
            if (i + 1 >= t.n) {
                return 0;
            }
            char e = t.s[i + 1];
            if (e == 'u') {
                if (unit_at(t, i) < 0) {
                    return 0;
                }
                i += 5;
            } else if (strchr("\"\\/bfnrt", e) != NULL && e != '\0') {
                i++;
            } else {
                return 0;
            }
        }
    }
    return 0;
}

static size_t json_digits(str t, size_t i)
{
    while (i < t.n && t.s[i] >= '0' && t.s[i] <= '9') {
        i++;
    }
    return i;
}

/* The end of the JSON number or literal at t.s[i], or 0 when none starts there. */
static size_t json_scalar(str t, size_t i)
{
    static const char *const literals[] = {"true", "false", "null"};
    for (size_t k = 0; k < 3; k++) {
        size_t n = strlen(literals[k]);
        if (i + n <= t.n && memcmp(t.s + i, literals[k], n) == 0) {
            return i + n;
        }
    }
    size_t j = i;
    if (j < t.n && t.s[j] == '-') {
        j++;
    }
    if (j < t.n && t.s[j] == '0') {
        j++;
    } else if (j < t.n && t.s[j] >= '1' && t.s[j] <= '9') {
        j = json_digits(t, j);
    } else {
        return 0;
    }
    if (j < t.n && t.s[j] == '.') {
        size_t k = json_digits(t, j + 1);
        if (k == j + 1) {
            return 0;
        }
        j = k;
    }
    if (j < t.n && (t.s[j] == 'e' || t.s[j] == 'E')) {
        j++;
        if (j < t.n && (t.s[j] == '+' || t.s[j] == '-')) {
            j++;
        }
        size_t k = json_digits(t, j);
        if (k == j) {
            return 0;
        }
        j = k;
    }
    return j;
}

/* Whether text is one JSON value (RFC 8259), read without a stack limit. It decides only the texts that PHP's parser
 * refuses, so that a valid text nested deeper than the parser's stack is JSON. */
static bool json_valid(str t)
{
    enum { S_VALUE, S_VALUE_OR_CLOSE, S_KEY, S_KEY_OR_CLOSE, S_COLON, S_NEXT, S_END } state = S_VALUE;
    VEC(char) open = {0};
    size_t i = 0;
    for (;;) {
        i = json_space(t, i);
        if (i >= t.n) {
            return state == S_END;
        }
        char c = t.s[i];
        if (state == S_END) {
            return false;
        }
        if (state == S_COLON) {
            if (c != ':') {
                return false;
            }
            i++;
            state = S_VALUE;
            continue;
        }
        if (state == S_NEXT || (state == S_VALUE_OR_CLOSE && c == ']') || (state == S_KEY_OR_CLOSE && c == '}')) {
            char last = open.v[open.n - 1];
            if (state == S_NEXT && c == ',') {
                i++;
                state = last == '{' ? S_KEY : S_VALUE;
                continue;
            }
            if (c != (last == '{' ? '}' : ']')) {
                return false;
            }
            open.n--;
            i++;
            state = open.n == 0 ? S_END : S_NEXT;
            continue;
        }
        if (state == S_KEY || state == S_KEY_OR_CLOSE) {
            size_t end = json_string(t, i);
            if (end == 0) {
                return false;
            }
            i = end;
            state = S_COLON;
            continue;
        }
        if (c == '{' || c == '[') {
            PUSH(open, c);
            i++;
            state = c == '{' ? S_KEY_OR_CLOSE : S_VALUE_OR_CLOSE;
            continue;
        }
        size_t end = c == '"' ? json_string(t, i) : json_scalar(t, i);
        if (end == 0) {
            return false;
        }
        i = end;
        state = open.n == 0 ? S_END : S_NEXT;
    }
}

/* Step 2: the set file's bytes as JSON, checked in the order of DBS-13 and DBS-18a. PHP's parser checks the syntax,
 * with every lone surrogate escape written as another escape, since the parser stops at a lone surrogate before the
 * rest of the syntax; when it refuses a text whose syntax is valid only for its nesting, which its stack does not
 * hold, the text is JSON. The scan finds the kind of the top-level value, the nesting, a repeated key and the kind
 * of each top-level value. Returns false with *error, else the two lists. */
static bool parse_set(str bytes, str path, strs *documents, strs *external, set_error *error)
{
#define FAIL(rule, ...) do { *error = mkerror(rule, path, fmt("%S: %S", path, fmt(__VA_ARGS__))); return false; } while (0)
    if (str_starts(bytes, "\xEF\xBB\xBF")) {
        FAIL("set.json", "the set file starts with a byte order mark");
    }
    if (utf8_valid_prefix(bytes) < bytes.n) {
        FAIL("set.json", "the set file is not valid UTF-8");
    }
    /* PHP's scanner ends its input at a NUL byte past the end, which a copy of the bytes has. */
    str text = str_of(bytes.s, bytes.n);
    str checked = without_lone_surrogates(text);
    checked = str_of(checked.s, checked.n);
    zval value;
    ZVAL_UNDEF(&value);
    if (php_json_decode_ex(&value, checked.s, checked.n, PHP_JSON_OBJECT_AS_ARRAY, SET_PARSER_DEPTH) == FAILURE) {
        str parser = json_error_message();
        zval_ptr_dtor(&value);
        ZVAL_UNDEF(&value);
        if (!json_valid(checked)) {
            FAIL("set.json", "the set file is not JSON: %S", parser);
        }
    }
    str top, repeated;
    size_t depth;
    smap members = {0};
    scan(checked, &top, &depth, &members, &repeated);
    bool ok = false;
    if (!str_eqc(top, V_OBJECT)) {
        *error = mkerror("set.json", path, fmt("%S: the set file is not one JSON object", path));
        goto done;
    }
    if (depth > SET_DEPTH) {
        *error = mkerror("set.json", path, fmt("%S: the set file nests deeper than %d levels", path, (zend_long)SET_DEPTH));
        goto done;
    }
    if (!str_eq(checked, text)) {
        *error = mkerror("set.json", path, fmt("%S: the set file escapes a lone surrogate", path));
        goto done;
    }
    if (Z_TYPE(value) != IS_ARRAY) {
        /* PHP's parser holds every object nested at most SET_DEPTH levels deep. */
        *error = mkerror("set.json", path, fmt("%S: the set file is not JSON: %S", path, json_error_message()));
        goto done;
    }
    if (repeated.s != NULL) {
        *error = mkerror("set.key", path, fmt("%S: the key %S appears twice", path, quoted(repeated)));
        goto done;
    }
    strs unknown = {0};
    SMAP_EACH(&members, i) {
        str k = members.e[i].key;
        if (!str_eqc(k, "schema") && !str_eqc(k, "documents") && !str_eqc(k, "external")) {
            PUSH(unknown, k);
        }
    }
    if (unknown.n > 0) {
        strs_sort(&unknown);
        strs q = {0};
        for (size_t i = 0; i < unknown.n; i++) {
            PUSH(q, quoted(unknown.v[i]));
        }
        *error = mkerror("set.key", path, fmt("%S: %s%S", path, unknown.n == 1 ? "unknown key " : "unknown keys ", strs_join(&q, ", ")));
        goto done;
    }
    HashTable *object = Z_ARRVAL(value);
    if (!smap_has(&members, SL("schema"))) {
        *error = mkerror("set.schema", path, fmt("%S: schema is missing", path));
        goto done;
    }
    zval *schema = zend_hash_str_find(object, "schema", sizeof("schema") - 1);
    if (!(schema != NULL && ((Z_TYPE_P(schema) == IS_LONG && Z_LVAL_P(schema) == 1) || (Z_TYPE_P(schema) == IS_DOUBLE && Z_DVAL_P(schema) == 1.0)))) {
        *error = mkerror("set.schema", path, fmt("%S: schema is not the number 1", path));
        goto done;
    }
    if (!smap_has(&members, SL("documents"))) {
        *error = mkerror("set.key", path, fmt("%S: documents is missing", path));
        goto done;
    }
    zval *docs = zend_hash_str_find(object, "documents", sizeof("documents") - 1);
    if (!strings(*(str *)smap_get(&members, SL("documents")), docs)) {
        *error = mkerror("set.key", path, fmt("%S: documents is not an array of strings", path));
        goto done;
    }
    if (zend_hash_num_elements(Z_ARRVAL_P(docs)) == 0) {
        *error = mkerror("set.empty", path, fmt("%S: documents is empty", path));
        goto done;
    }
    zval *ext = NULL;
    if (smap_has(&members, SL("external"))) {
        ext = zend_hash_str_find(object, "external", sizeof("external") - 1);
        if (!strings(*(str *)smap_get(&members, SL("external")), ext)) {
            *error = mkerror("set.key", path, fmt("%S: external is not an array of strings", path));
            goto done;
        }
    }
    put_strings(docs, documents);
    if (ext != NULL) {
        put_strings(ext, external);
    }
    ok = true;
done:
    if (Z_TYPE(value) != IS_UNDEF) {
        zval_ptr_dtor(&value);
    }
    return ok;
#undef FAIL
}

/* The problem of a segment other than `..` that every platform cannot hold (DBS-8), as DBS-18a words it, or SNULL. */
static str segment_problem(str s)
{
    if (str_eqc(s, ".")) {
        return SL("has a . segment");
    }
    for (size_t i = 0; i < s.n; i++) {
        unsigned char c = (unsigned char)s.s[i];
        if (c < 0x20 || strchr("\\:<>\"|?*", c) != NULL) {
            return fmt("has the character %S that a segment cannot hold", quoted(str_sub(s, i, 1)));
        }
    }
    if (s.s[s.n - 1] == '.' || s.s[s.n - 1] == ' ') {
        return SL("has a segment that ends in . or a space");
    }
    size_t dot = 0;
    while (dot < s.n && s.s[dot] != '.') {
        dot++;
    }
    size_t end = dot;
    while (end > 0 && s.s[end - 1] == ' ') {
        end--;
    }
    str base = str_upper(str_sub(s, 0, end));
    bool device = false;
    static const char *const names[] = {"CON", "PRN", "AUX", "NUL"};
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
        if (str_eqc(base, names[i])) {
            device = true;
        }
    }
    if (str_starts(base, "COM") || str_starts(base, "LPT")) {
        str rest = str_sub(base, 3, base.n - 3);
        if ((rest.n == 1 && rest.s[0] >= '0' && rest.s[0] <= '9') || str_eqc(rest, "\xC2\xB9") || str_eqc(rest, "\xC2\xB2") || str_eqc(rest, "\xC2\xB3")) {
            device = true;
        }
    }
    return device ? fmt("has the segment %S that names a Windows device", quoted(s)) : SNULL;
}

/* The problem of a written path that has no normal form (DBS-7 to DBS-9), as DBS-18a words it, or SNULL when it has
 * one: the segments are checked from the first, each against the problems in order, and then the path. */
static str normal_form(str written, bool documents)
{
    strs segments = strs_split(written, '/');
    bool leading = true;
    for (size_t i = 0; i < segments.n; i++) {
        str s = segments.v[i];
        if (s.n == 0) {
            return SL("has an empty segment");
        }
        if (str_eqc(s, "..")) {
            if (documents) {
                return SL("has a .. segment");
            }
            if (!leading) {
                return SL("has a .. segment after another segment");
            }
            continue;
        }
        leading = false;
        str wrong = segment_problem(s);
        if (wrong.s != NULL) {
            return wrong;
        }
    }
    return str_ends(written, ".dbs") ? SNULL : SL("does not end in .dbs");
}

/* Step 3 for one path that has its normal form: each prefix of the joined path that ends after a written segment is
 * listed by its directory (a segment other than `..`) and examined with lstat. An intermediate component of an
 * external path that is a link is examined through it (stat). named is the root as the messages name it, the
 * directory that lists the first segment. */
static bool examine(set_reader *r, str root, str named, str prefix, str written, str joined, bool external, set_error *error)
{
    strs segments = strs_split(written, '/');
    str directory = root;
    str shown = named;
    str component = prefix;
    str failure = SNULL;
    for (size_t i = 0; i < segments.n; i++) {
        str segment = segments.v[i];
        component = fmt(i == 0 ? "%S%S" : "%S/%S", component, segment);
        if (!str_eqc(segment, "..")) {
            int listed = lists(r, directory, segment, &failure);
            if (listed < 0) {
                *error = mkerror("set.file", joined, fmt("%S: %S cannot be listed: %S", joined, shown, failure));
                return false;
            }
            if (listed == 0) {
                *error = mkerror("set.file", joined, fmt("%S: %S lists no name %S", joined, shown, quoted(segment)));
                return false;
            }
        }
        set_kind kind = path_kind(component, false, &failure);
        bool last = i == segments.n - 1;
        if (kind == KIND_LINK && external && !last) {
            kind = path_kind(component, true, &failure);
        }
        if (kind == KIND_NONE) {
            *error = mkerror("set.file", joined, fmt("%S: %S cannot be examined: %S", joined, component, failure));
            return false;
        }
        if (kind == KIND_LINK) {
            *error = mkerror("set.symlink", joined, fmt("%S: %S is a symbolic link", joined, component));
            return false;
        }
        if (!last && kind != KIND_DIR) {
            *error = mkerror("set.file", joined, fmt("%S: %S is not a directory", joined, component));
            return false;
        }
        if (last && kind != KIND_FILE) {
            *error = mkerror("set.file", joined, fmt("%S: %S is not a regular file", joined, component));
            return false;
        }
        directory = component;
        shown = component;
    }
    return true;
}

/* Reads the set; on success the files, else the errors. */
static bool read_set(str path, set_files *documents, set_files *external, set_errors *errors)
{
    set_reader r = {{0}, {0}};
    size_t cut = path.n;
    for (size_t i = path.n; i > 0; i--) {
        if (is_separator(path.s[i - 1])) {
            cut = i - 1;
            break;
        }
    }
    str prefix = cut == path.n ? SL("") : str_sub(path, 0, cut + 1);
    str name = cut == path.n ? path : str_sub(path, cut + 1, path.n - cut - 1);
    str root = prefix.n == 0 ? SL(".") : prefix;
#define FAIL1(rule, ...) do { PUSH(*errors, mkerror(rule, path, fmt(__VA_ARGS__))); return false; } while (0)
    if (!str_eqc(name, SET_NAME)) {
        FAIL1("set.file", "%S: the set file is not named " SET_NAME, path);
    }
    if (memchr(path.s, 0, path.n) != NULL) {
        FAIL1("set.file", "%S: the path contains a NUL byte", path);
    }
    str named = trimmed(root), failure = SNULL;
    set_kind kind = path_kind(named, false, &failure);
    if (kind == KIND_NONE) {
        FAIL1("set.file", "%S: the root %S cannot be examined: %S", path, named, failure);
    }
    if (kind == KIND_LINK) {
        FAIL1("set.symlink", "%S: the root %S is a symbolic link", path, named);
    }
    if (kind != KIND_DIR) {
        FAIL1("set.file", "%S: the root %S is not a directory", path, named);
    }
    int listed = lists(&r, root, SL(SET_NAME), &failure);
    if (listed < 0) {
        FAIL1("set.file", "%S: the root %S cannot be listed: %S", path, named, failure);
    }
    if (listed == 0) {
        FAIL1("set.file", "%S: the root %S lists no " SET_NAME, path, named);
    }
    kind = path_kind(path, false, &failure);
    if (kind == KIND_NONE) {
        FAIL1("set.file", "%S: the set file cannot be examined: %S", path, failure);
    }
    if (kind == KIND_LINK) {
        FAIL1("set.symlink", "%S: the set file is a symbolic link", path);
    }
    if (kind != KIND_FILE) {
        FAIL1("set.file", "%S: the set file is not a regular file", path);
    }
    str identity, bytes, duplicate = SNULL, reason;
    if (!open_file(path, NULL, &identity, &bytes, &duplicate, &reason)) {
        FAIL1("set.file", "%S: the set file cannot be read: %S", path, reason);
    }
#undef FAIL1

    strs lists_[2] = {{0}, {0}};
    set_error error;
    if (!parse_set(bytes, path, &lists_[0], &lists_[1], &error)) {
        PUSH(*errors, error);
        return false;
    }

    typedef struct {
        int list;
        str joined;
    } passed_path;
    VEC(passed_path) passed = {0};
    static const char *const list_names[] = {"documents", "external"};
    for (int list = 0; list < 2; list++) {
        for (size_t i = 0; i < lists_[list].n; i++) {
            str written = lists_[list].v[i];
            str wrong = normal_form(written, list == 0);
            if (wrong.s != NULL) {
                PUSH(*errors, mkerror("set.path", path, fmt("%S: the %s path %S %S", path, list_names[list], quoted(written), wrong)));
                continue;
            }
            str joined = fmt("%S%S", prefix, written);
            if (!examine(&r, root, named, prefix, written, joined, list == 1, &error)) {
                PUSH(*errors, error);
                continue;
            }
            passed_path p = {list, joined};
            PUSH(passed, p);
        }
    }

    smap seen = {0};
    for (size_t i = 0; i < passed.n; i++) {
        str joined = passed.v[i].joined;
        duplicate = SNULL;
        if (!open_file(joined, &seen, &identity, &bytes, &duplicate, &reason)) {
            PUSH(*errors, mkerror("set.file", joined, fmt("%S: the file cannot be read: %S", joined, reason)));
            continue;
        }
        if (duplicate.s != NULL) {
            PUSH(*errors, mkerror("set.duplicate", joined, fmt("%S: names the file that %S names", joined, duplicate)));
            continue;
        }
        str *at = dbs_alloc(sizeof *at);
        *at = joined;
        smap_set(&seen, identity, at);
        set_file f = {joined, bytes};
        PUSH(*(passed.v[i].list == 0 ? documents : external), f);
    }
    return errors->n == 0;
}

/* ------------------------------------------------------------ PHP objects */

static void set_error_object(zval *out, const set_error *e)
{
    obj_new(out, dbs_ce_SetError);
    obj_put_str(out, "rule", e->rule);
    obj_put_str(out, "path", e->path);
    obj_put_str(out, "message", e->message);
}

static void set_files_array(zval *out, const set_files *files)
{
    array_init_size(out, (uint32_t)files->n);
    for (size_t i = 0; i < files->n; i++) {
        zval f;
        obj_new(&f, dbs_ce_SetFile);
        obj_put_str(&f, "path", files->v[i].path);
        obj_put_str(&f, "bytes", files->v[i].bytes);
        add_next_index_zval(out, &f);
    }
}

void dbs_read_set(zend_string *path, zval *return_value)
{
    set_files documents = {0}, external = {0};
    set_errors errors = {0};
    obj_new(return_value, dbs_ce_SetResult);
    if (read_set(str_z(path), &documents, &external, &errors)) {
        zval d, e, none;
        set_files_array(&d, &documents);
        set_files_array(&e, &external);
        ZVAL_EMPTY_ARRAY(&none);
        obj_put(return_value, "documents", &d);
        obj_put(return_value, "external", &e);
        obj_put(return_value, "errors", &none);
        return;
    }
    zval list;
    array_init_size(&list, (uint32_t)errors.n);
    for (size_t i = 0; i < errors.n; i++) {
        zval e;
        set_error_object(&e, &errors.v[i]);
        add_next_index_zval(&list, &e);
    }
    obj_put_null(return_value, "documents");
    obj_put_null(return_value, "external");
    obj_put(return_value, "errors", &list);
}
