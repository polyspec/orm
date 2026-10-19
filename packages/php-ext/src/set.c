/*
 * The set reader Dbspec::readSet of the extension (docs/spec/dbspec.md "Document sets"), the twin of the PHP client's
 * SetReader (packages/php/src/Dbspec/SetReader.php): the set file, its JSON, each path and the read with the
 * file identity, in that order, with the same rules, paths and messages. The file system is examined with the
 * platform's calls: lstat, opendir and open with fstat on POSIX; on Windows CreateFileW without following a
 * reparse point, a name surrogate tag (IsReparseTagNameSurrogate) as the symbolic link, FindFirstFileW for the
 * listing and the volume serial number with the 64-bit file index of the opened handle as the identity. The
 * JSON is parsed by PHP's own parser (ext/json), which the PHP client uses too.
 */
#include "dbspec.h"
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
/* The deepest nesting of the set file; PHP's parser counts one level more than the containers. */
#define SET_DEPTH 64
/* PHP reads a plain file in chunks of this size; a failed read names it like PHP's notice does. */
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

/* The listing of each directory during one read: a strs, or NULL when the directory cannot be listed. */
typedef struct {
    smap listings;
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

static set_kind path_kind(str path, bool follow)
{
    wchar_t *w = wide(path);
    if (w == NULL) {
        return KIND_NONE;
    }
    HANDLE h = CreateFileW(w, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | (follow ? 0 : FILE_FLAG_OPEN_REPARSE_POINT), NULL);
    if (h == INVALID_HANDLE_VALUE) {
        return KIND_NONE;
    }
    FILE_ATTRIBUTE_TAG_INFO info;
    BOOL ok = GetFileInformationByHandleEx(h, FileAttributeTagInfo, &info, sizeof info);
    DWORD type = GetFileType(h);
    CloseHandle(h);
    if (!ok) {
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

/* The names that dir lists, or false when it cannot be listed. A name that is no UTF-16 text (a lone surrogate)
 * equals no segment, since a segment is UTF-8 and so its UTF-16 code units hold no lone surrogate. */
static bool list_dir(str dir, strs *out)
{
    bool bare = dir.n > 0 && (is_separator(dir.s[dir.n - 1]) || (dir.n == 2 && dir.s[1] == ':'));
    wchar_t *pattern = wide(fmt(bare ? "%S*" : "%S\\*", dir));
    if (pattern == NULL) {
        return false;
    }
    WIN32_FIND_DATAW found;
    HANDLE h = FindFirstFileW(pattern, &found);
    if (h == INVALID_HANDLE_VALUE) {
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
    return last == ERROR_NO_MORE_FILES;
}

/* Opens path once and takes its identity and then, unless the identity is in seen, its bytes from that handle.
 * Returns false with *reason on a failure; *duplicate is the earlier path of the same identity. */
static bool open_file(str path, const smap *seen, str *identity, str *bytes, str *duplicate, str *reason)
{
    wchar_t *w = wide(path);
    if (w == NULL) {
        *reason = SL("the path is not valid UTF-8");
        return false;
    }
    HANDLE h = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        *reason = fmt("fopen(%S): Failed to open stream: %S", path, system_error(GetLastError()));
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
            *reason = fmt("Read of %u bytes failed: %S", (size_t)SET_CHUNK, system_error(GetLastError()));
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

static set_kind path_kind(str path, bool follow)
{
    struct stat st;
    if ((follow ? stat(cpath(path), &st) : lstat(cpath(path), &st)) != 0) {
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

/* The names that dir lists, or false when it cannot be listed. */
static bool list_dir(str dir, strs *out)
{
    DIR *d = opendir(cpath(dir));
    if (d == NULL) {
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
    return failed == 0;
}

/* Opens path once and takes its identity and then, unless the identity is in seen, its bytes from that handle.
 * Returns false with *reason on a failure (PHP's messages for fopen and a failed read); *duplicate is the earlier
 * path of the same identity. */
static bool open_file(str path, const smap *seen, str *identity, str *bytes, str *duplicate, str *reason)
{
    int fd = open(cpath(path), O_RDONLY);
    if (fd < 0) {
        *reason = fmt("fopen(%S): Failed to open stream: %s", path, strerror(errno));
        return false;
    }
    struct stat st;
    if (fstat(fd, &st) != 0) {
        *reason = fmt("fstat(): %s", strerror(errno));
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
            *reason = fmt("stream_get_contents(): Read of %u bytes failed with errno=%d %s", (size_t)SET_CHUNK, (zend_long)errno, strerror(errno));
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

/* Whether dir lists name: 1, 0, or -1 when dir cannot be listed. */
static int lists(set_reader *r, str dir, str name)
{
    strs *listing;
    if (smap_has(&r->listings, dir)) {
        listing = smap_get(&r->listings, dir);
    } else {
        listing = dbs_alloc(sizeof *listing);
        *listing = (strs){0};
        if (!list_dir(dir, listing)) {
            listing = NULL;
        }
        smap_set(&r->listings, dir, listing);
    }
    return listing == NULL ? -1 : strs_has(listing, name) ? 1 : 0;
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

/* The JSON quoting of s that the PHP client's messages use. */
static str quoted(str s)
{
    zend_string *z = php_json_encode_string(s.s, s.n, PHP_JSON_UNESCAPED_SLASHES | PHP_JSON_UNESCAPED_UNICODE);
    str q = str_of(ZSTR_VAL(z), ZSTR_LEN(z));
    zend_string_release(z);
    return q;
}

/* The kinds the scan gives a value. */
#define V_OBJECT "object"
#define V_ARRAY "array"

typedef struct {
    bool object, expecting_key;
    smap keys;
} scan_frame;

/*
 * Scans JSON text that PHP's parser accepted: the kind of the top-level value, the kind of each value of the
 * top-level object by its key (in members, in their order), and the first key repeated in an object at any depth.
 * A key is decoded by PHP's parser, so that escapes compare as the characters they write.
 */
static void scan(str text, str *top, smap *members, str *repeated)
{
    VEC(scan_frame) frames = {0};
    str key = SNULL;
    *top = SNULL;
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
                php_json_decode_ex(&decoded, token.s, token.n, 0, SET_DEPTH + 1);
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

/* Step 2: the set file's bytes as JSON. Returns false with *error, else the two lists. */
static bool parse_set(str bytes, str path, strs *documents, strs *external, set_error *error)
{
#define FAIL(rule, ...) do { *error = mkerror(rule, path, fmt("%S: %S", path, fmt(__VA_ARGS__))); return false; } while (0)
    if (str_starts(bytes, "\xEF\xBB\xBF")) {
        FAIL("set.json", "the set file begins with a byte order mark");
    }
    if (utf8_valid_prefix(bytes) < bytes.n) {
        FAIL("set.json", "the set file is not valid UTF-8");
    }
    zval value;
    ZVAL_UNDEF(&value);
    /* PHP's scanner ends its input at a NUL byte past the end, which a copy of the bytes has. */
    bytes = str_of(bytes.s, bytes.n);
    if (php_json_decode_ex(&value, bytes.s, bytes.n, PHP_JSON_OBJECT_AS_ARRAY, SET_DEPTH + 1) == FAILURE) {
        zval_ptr_dtor(&value);
        FAIL("set.json", "the set file is not JSON nested at most %d levels deep: %S", (zend_long)SET_DEPTH, json_error_message());
    }
    str top, repeated;
    smap members = {0};
    scan(bytes, &top, &members, &repeated);
    bool ok = false;
    if (!str_eqc(top, V_OBJECT)) {
        *error = mkerror("set.json", path, fmt("%S: the set file is not a JSON object", path));
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
    zval_ptr_dtor(&value);
    return ok;
#undef FAIL
}

/* Whether segment is a name that every platform can hold (docs/spec/dbspec.md "Document sets"). */
static bool segment_ok(str s)
{
    if (s.n == 0 || str_eqc(s, ".")) {
        return false;
    }
    for (size_t i = 0; i < s.n; i++) {
        unsigned char c = (unsigned char)s.s[i];
        if (c < 0x20 || strchr("\\/:<>\"|?*", c) != NULL) {
            return false;
        }
    }
    if (s.s[s.n - 1] == '.' || s.s[s.n - 1] == ' ') {
        return false;
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
    static const char *const names[] = {"CON", "PRN", "AUX", "NUL"};
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
        if (str_eqc(base, names[i])) {
            return false;
        }
    }
    if (str_starts(base, "COM") || str_starts(base, "LPT")) {
        str rest = str_sub(base, 3, base.n - 3);
        if ((rest.n == 1 && rest.s[0] >= '0' && rest.s[0] <= '9') || str_eqc(rest, "\xC2\xB9") || str_eqc(rest, "\xC2\xB2") || str_eqc(rest, "\xC2\xB3")) {
            return false;
        }
    }
    return true;
}

/* Why a written path has no normal form, or NULL when it has one. */
static const char *normal_form(str written, bool documents)
{
    strs segments = strs_split(written, '/');
    if (!str_ends(segments.v[segments.n - 1], ".dbs")) {
        return "has no normal form";
    }
    bool leading = true;
    for (size_t i = 0; i < segments.n; i++) {
        str s = segments.v[i];
        if (str_eqc(s, "..")) {
            if (documents) {
                return "has a .. segment";
            }
            if (!leading) {
                return "has a .. segment after another segment";
            }
            continue;
        }
        leading = false;
        if (!segment_ok(s)) {
            return "has no normal form";
        }
    }
    return NULL;
}

/* Step 3 for one path that has its normal form: each prefix of the joined path that ends after a written segment is
 * listed by its directory (a segment other than `..`) and examined with lstat. An intermediate component of an
 * external path that is a link is examined through it (stat). */
static bool examine(set_reader *r, str root, str prefix, str written, str joined, bool external, set_error *error)
{
    strs segments = strs_split(written, '/');
    str directory = root;
    str component = prefix;
    for (size_t i = 0; i < segments.n; i++) {
        str segment = segments.v[i];
        component = fmt(i == 0 ? "%S%S" : "%S/%S", component, segment);
        if (!str_eqc(segment, "..")) {
            int listed = lists(r, directory, segment);
            if (listed < 0) {
                *error = mkerror("set.file", joined, fmt("%S: the directory %S cannot be listed", joined, directory));
                return false;
            }
            if (listed == 0) {
                *error = mkerror("set.file", joined, fmt("%S: %S is not a name that %S lists", joined, segment, directory));
                return false;
            }
        }
        set_kind kind = path_kind(component, false);
        bool last = i == segments.n - 1;
        if (kind == KIND_LINK && external && !last) {
            kind = path_kind(component, true);
        }
        if (kind == KIND_NONE) {
            *error = mkerror("set.file", joined, fmt("%S: %S cannot be examined", joined, component));
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
    }
    return true;
}

/* Reads the set; on success the files, else the errors. */
static bool read_set(str path, set_files *documents, set_files *external, set_errors *errors)
{
    set_reader r = {{0}};
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
    set_kind kind = path_kind(trimmed(root), false);
    if (kind == KIND_NONE) {
        FAIL1("set.file", "%S: the root %S cannot be examined", path, root);
    }
    if (kind == KIND_LINK) {
        FAIL1("set.symlink", "%S: the root %S is a symbolic link", path, root);
    }
    if (kind != KIND_DIR) {
        FAIL1("set.file", "%S: the root %S is not a directory", path, root);
    }
    int listed = lists(&r, root, SL(SET_NAME));
    if (listed < 0) {
        FAIL1("set.file", "%S: the directory %S cannot be listed", path, root);
    }
    if (listed == 0) {
        FAIL1("set.file", "%S: " SET_NAME " is not a name that %S lists", path, root);
    }
    kind = path_kind(path, false);
    if (kind == KIND_NONE) {
        FAIL1("set.file", "%S: the set file cannot be examined", path);
    }
    if (kind == KIND_LINK) {
        FAIL1("set.symlink", "%S: the set file is a symbolic link", path);
    }
    if (kind != KIND_FILE) {
        FAIL1("set.file", "%S: the set file is not a regular file", path);
    }
    str identity, bytes, duplicate = SNULL, reason;
    if (!open_file(path, NULL, &identity, &bytes, &duplicate, &reason)) {
        FAIL1("set.file", "cannot read %S: %S", path, reason);
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
            const char *wrong = normal_form(written, list == 0);
            if (wrong != NULL) {
                PUSH(*errors, mkerror("set.path", path, fmt("%S: the %s path %S %s", path, list_names[list], quoted(written), wrong)));
                continue;
            }
            str joined = fmt("%S%S", prefix, written);
            if (!examine(&r, root, prefix, written, joined, list == 1, &error)) {
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
            PUSH(*errors, mkerror("set.file", joined, fmt("cannot read %S: %S", joined, reason)));
            continue;
        }
        if (duplicate.s != NULL) {
            PUSH(*errors, mkerror("set.duplicate", joined, fmt("%S names the same file as %S", joined, duplicate)));
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
