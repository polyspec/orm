/* arena, 문자열, vector, map, 정렬처럼 모든 연산이 함께 쓰는 도구다. */
#include "dbspec.h"
#include "unicode_word.h"
#include "ext/hash/php_hash.h"
#include "ext/hash/php_hash_sha.h"
#include <stdarg.h>

DBS_TLS dbs_arena *dbs_current = NULL;

#define DBS_BLOCK (64 * 1024)

void *dbs_alloc(size_t size)
{
    dbs_arena *a = dbs_current;
    size = (size + 15) & ~(size_t)15;
    dbs_block *b = a->head;
    if (b == NULL || b->cap - b->used < size) {
        size_t cap = size > DBS_BLOCK ? size : DBS_BLOCK;
        dbs_block *nb = emalloc(sizeof(dbs_block) + cap);
        nb->used = 0;
        nb->cap = cap;
        /* 큰 할당은 따로 둔 block이 되고, 지금 block은 계속 쓴다. */
        if (b != NULL && size > DBS_BLOCK) {
            nb->next = b->next;
            b->next = nb;
        } else {
            nb->next = b;
            a->head = nb;
        }
        b = nb;
    }
    void *p = b->data + b->used;
    b->used += size;
    memset(p, 0, size);
    return p;
}

void dbs_arena_free(dbs_arena *a)
{
    dbs_block *b = a->head;
    while (b != NULL) {
        dbs_block *next = b->next;
        efree(b);
        b = next;
    }
    a->head = NULL;
}

void dbs_enter(dbs_arena *mine, dbs_arena **saved)
{
    mine->head = NULL;
    *saved = dbs_current;
    dbs_current = mine;
}

void dbs_leave(dbs_arena *mine, dbs_arena *saved)
{
    dbs_arena_free(mine);
    dbs_current = saved;
}

/* ---------------------------------------------------------------- strings */

str str_of(const char *s, size_t n)
{
    char *p = dbs_alloc(n + 1);
    if (n > 0) {
        memcpy(p, s, n);
    }
    p[n] = '\0';
    return (str){p, n};
}

str str_c(const char *s)
{
    return str_of(s, strlen(s));
}

str str_z(zend_string *z)
{
    return str_of(ZSTR_VAL(z), ZSTR_LEN(z));
}

str str_sub(str s, size_t from, size_t len)
{
    if (from > s.n) {
        from = s.n;
    }
    if (len > s.n - from) {
        len = s.n - from;
    }
    return (str){s.s + from, len};
}

bool str_eq(str a, str b)
{
    return a.n == b.n && (a.n == 0 || memcmp(a.s, b.s, a.n) == 0);
}

bool str_eqc(str a, const char *c)
{
    size_t n = strlen(c);
    return a.n == n && memcmp(a.s, c, n) == 0;
}

int str_cmp(str a, str b)
{
    size_t n = a.n < b.n ? a.n : b.n;
    int c = n == 0 ? 0 : memcmp(a.s, b.s, n);
    if (c != 0) {
        return c < 0 ? -1 : 1;
    }
    return a.n == b.n ? 0 : (a.n < b.n ? -1 : 1);
}

bool str_starts(str s, const char *prefix)
{
    size_t n = strlen(prefix);
    return s.n >= n && memcmp(s.s, prefix, n) == 0;
}

bool str_ends(str s, const char *suffix)
{
    size_t n = strlen(suffix);
    return s.n >= n && memcmp(s.s + s.n - n, suffix, n) == 0;
}

ssize_t str_find(str s, const char *needle, size_t from)
{
    size_t n = strlen(needle);
    if (n == 0) {
        return from <= s.n ? (ssize_t)from : -1;
    }
    for (size_t i = from; i + n <= s.n; i++) {
        if (s.s[i] == needle[0] && memcmp(s.s + i, needle, n) == 0) {
            return (ssize_t)i;
        }
    }
    return -1;
}

bool str_has(str s, const char *needle)
{
    return str_find(s, needle, 0) >= 0;
}

bool str_hasch(str s, char c)
{
    return s.n > 0 && memchr(s.s, c, s.n) != NULL;
}

str str_ltrim_spaces(str s)
{
    size_t i = 0;
    while (i < s.n && s.s[i] == ' ') {
        i++;
    }
    return str_sub(s, i, s.n - i);
}

str str_trim_set(str s, const char *set)
{
    size_t setn = strlen(set);
    size_t a = 0, b = s.n;
    while (a < b && memchr(set, s.s[a], setn) != NULL) {
        a++;
    }
    while (b > a && memchr(set, s.s[b - 1], setn) != NULL) {
        b--;
    }
    return str_sub(s, a, b - a);
}

str str_lower(str s)
{
    char *p = dbs_alloc(s.n + 1);
    for (size_t i = 0; i < s.n; i++) {
        char c = s.s[i];
        p[i] = c >= 'A' && c <= 'Z' ? (char)(c + 32) : c;
    }
    return (str){p, s.n};
}

str str_upper(str s)
{
    char *p = dbs_alloc(s.n + 1);
    for (size_t i = 0; i < s.n; i++) {
        char c = s.s[i];
        p[i] = c >= 'a' && c <= 'z' ? (char)(c - 32) : c;
    }
    return (str){p, s.n};
}

bool str_digits(str s)
{
    if (s.n == 0) {
        return false;
    }
    for (size_t i = 0; i < s.n; i++) {
        if (s.s[i] < '0' || s.s[i] > '9') {
            return false;
        }
    }
    return true;
}

bool str_word(str s)
{
    if (s.n == 0) {
        return false;
    }
    for (size_t i = 0; i < s.n; i++) {
        unsigned char c = (unsigned char)s.s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) {
            return false;
        }
    }
    return true;
}

/* 단어 token은 Go의 isWordRune처럼 `.`을 포함한다(`a.b`는 한 token이고 이름 형식 검사가 거부한다). */
bool str_dotted(str s)
{
    if (s.n == 0) {
        return false;
    }
    for (size_t i = 0; i < s.n;) {
        size_t width = word_rune_width(s, i);
        if (width == 0) {
            return false;
        }
        i += width;
    }
    return true;
}

/* 수의 모양 `[0-9]+\.[0-9]+`인지 본다(Go의 isNumberText 중 소수부가 있는 것). */
bool str_decimal(str s)
{
    size_t i = 0;
    size_t digits = 0;
    while (i < s.n && s.s[i] >= '0' && s.s[i] <= '9') {
        i++;
        digits++;
    }
    if (digits == 0 || i >= s.n || s.s[i] != '.') {
        return false;
    }
    i++;
    size_t fraction = 0;
    while (i < s.n && s.s[i] >= '0' && s.s[i] <= '9') {
        i++;
        fraction++;
    }
    return fraction > 0 && i == s.n;
}

str str_replace(str s, const char *from, const char *to)
{
    size_t fn = strlen(from);
    sbuf b = {0};
    size_t i = 0;
    while (i < s.n) {
        if (i + fn <= s.n && memcmp(s.s + i, from, fn) == 0) {
            sb_c(&b, to);
            i += fn;
        } else {
            sb_ch(&b, s.s[i]);
            i++;
        }
    }
    return sb_str(&b);
}

str str_repeat(const char *s, size_t times)
{
    sbuf b = {0};
    for (size_t i = 0; i < times; i++) {
        sb_c(&b, s);
    }
    return sb_str(&b);
}

size_t utf8_length(str s)
{
    size_t n = 0;
    for (size_t i = 0; i < s.n; i++) {
        if (((unsigned char)s.s[i] & 0xC0) != 0x80) {
            n++;
        }
    }
    return n;
}

static size_t utf8_width(unsigned char b)
{
    return b < 0x80 ? 1 : b < 0xE0 ? 2 : b < 0xF0 ? 3 : 4;
}

/* 위치 i의 올바른 UTF-8 code point 값을 돌려주고 그 byte 수를 width에 쓴다(입력은 utf8_valid_prefix가 확인했다). */
uint32_t utf8_decode_at(str s, size_t i, size_t *width)
{
    unsigned char b = (unsigned char)s.s[i];
    size_t n = utf8_width(b);
    uint32_t cp = n == 1 ? b : n == 2 ? (b & 0x1Fu) : n == 3 ? (b & 0x0Fu) : (b & 0x07u);
    for (size_t k = 1; k < n; k++) {
        cp = (cp << 6) | ((unsigned char)s.s[i + k] & 0x3Fu);
    }
    *width = n;
    return cp;
}

/* 위치 i에서 시작하는 글자가 Go의 isWordRune이면 그 byte 수를, 아니면 0을 돌려준다. ASCII는 [A-Za-z0-9_.]다. */
size_t word_rune_width(str s, size_t i)
{
    unsigned char c = (unsigned char)s.s[i];
    if (c < 0x80) {
        bool ascii = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '.';
        return ascii ? 1 : 0;
    }
    size_t width;
    return unicode_word_rune(utf8_decode_at(s, i, &width)) ? width : 0;
}

/* 위치 i에서 시작하는 word token이 끝나는 위치다: 글자가 Go의 isWordRune인 동안 이어진다. */
size_t word_run_end(str s, size_t i)
{
    for (size_t w = i < s.n ? word_rune_width(s, i) : 0; w > 0; w = i < s.n ? word_rune_width(s, i) : 0) {
        i += w;
    }
    return i;
}

zend_string *str_zend(str s)
{
    return zend_string_init(s.s == NULL ? "" : s.s, s.n, 0);
}

/* ---------------------------------------------------------------- builder */

void sb_add(sbuf *b, const char *s, size_t n)
{
    if (b->n + n + 1 > b->cap) {
        size_t cap = b->cap == 0 ? 64 : b->cap;
        while (cap < b->n + n + 1) {
            cap *= 2;
        }
        char *p = dbs_alloc(cap);
        if (b->n > 0) {
            memcpy(p, b->s, b->n);
        }
        b->s = p;
        b->cap = cap;
    }
    if (n > 0) {
        memcpy(b->s + b->n, s, n);
    }
    b->n += n;
    b->s[b->n] = '\0';
}

void sb_s(sbuf *b, str s)
{
    sb_add(b, s.s, s.n);
}

void sb_c(sbuf *b, const char *c)
{
    sb_add(b, c, strlen(c));
}

void sb_ch(sbuf *b, char c)
{
    sb_add(b, &c, 1);
}

void sb_long(sbuf *b, zend_long v)
{
    char buf[32];
    int n = snprintf(buf, sizeof buf, ZEND_LONG_FMT, v);
    sb_add(b, buf, (size_t)n);
}

static void sb_vfmt(sbuf *b, const char *f, va_list ap)
{
    for (const char *p = f; *p; p++) {
        if (*p != '%') {
            const char *q = p;
            while (*q && *q != '%') {
                q++;
            }
            sb_add(b, p, (size_t)(q - p));
            p = q - 1;
            continue;
        }
        p++;
        switch (*p) {
            case 'S':
                sb_s(b, va_arg(ap, str));
                break;
            case 's':
                sb_c(b, va_arg(ap, const char *));
                break;
            case 'd':
                sb_long(b, va_arg(ap, zend_long));
                break;
            case 'u': {
                char buf[32];
                int n = snprintf(buf, sizeof buf, "%zu", va_arg(ap, size_t));
                sb_add(b, buf, (size_t)n);
                break;
            }
            case '%':
                sb_ch(b, '%');
                break;
            default:
                ZEND_UNREACHABLE();
        }
    }
}

void sb_fmt(sbuf *b, const char *format, ...)
{
    va_list ap;
    va_start(ap, format);
    sb_vfmt(b, format, ap);
    va_end(ap);
}

str sb_str(sbuf *b)
{
    if (b->s == NULL) {
        return str_of("", 0);
    }
    return (str){b->s, b->n};
}

str fmt(const char *format, ...)
{
    sbuf b = {0};
    va_list ap;
    va_start(ap, format);
    sb_vfmt(&b, format, ap);
    va_end(ap);
    return sb_str(&b);
}

/* ---------------------------------------------------------------- vectors */

void vec_grow(void **v, size_t *cap, size_t need, size_t size)
{
    size_t c = *cap == 0 ? 4 : *cap;
    while (c < need) {
        c *= 2;
    }
    void *p = dbs_alloc(c * size);
    if (*cap > 0) {
        memcpy(p, *v, *cap * size);
    }
    *v = p;
    *cap = c;
}

bool strs_has(const strs *l, str s)
{
    for (size_t i = 0; i < l->n; i++) {
        if (str_eq(l->v[i], s)) {
            return true;
        }
    }
    return false;
}

bool strs_eq(const strs *a, const strs *b)
{
    if (a->n != b->n) {
        return false;
    }
    for (size_t i = 0; i < a->n; i++) {
        if (!str_eq(a->v[i], b->v[i])) {
            return false;
        }
    }
    return true;
}

str strs_join(const strs *l, const char *sep)
{
    sbuf b = {0};
    for (size_t i = 0; i < l->n; i++) {
        if (i > 0) {
            sb_c(&b, sep);
        }
        sb_s(&b, l->v[i]);
    }
    return sb_str(&b);
}

strs strs_copy(const strs *l)
{
    strs out = {0};
    for (size_t i = 0; i < l->n; i++) {
        PUSH(out, l->v[i]);
    }
    return out;
}

strs strs_split(str s, char sep)
{
    strs out = {0};
    size_t start = 0;
    for (size_t i = 0; i < s.n; i++) {
        if (s.s[i] == sep) {
            PUSH(out, str_sub(s, start, i - start));
            start = i + 1;
        }
    }
    PUSH(out, str_sub(s, start, s.n - start));
    return out;
}

static int cmp_str(const void *a, const void *b, void *ctx)
{
    (void)ctx;
    return str_cmp(*(const str *)a, *(const str *)b);
}

void strs_sort(strs *l)
{
    dbs_sort(l->v, l->n, sizeof(str), cmp_str, NULL);
}

static void merge_sort(char *a, char *tmp, size_t n, size_t size, int (*cmp)(const void *, const void *, void *), void *ctx)
{
    if (n < 2) {
        return;
    }
    size_t half = n / 2;
    merge_sort(a, tmp, half, size, cmp, ctx);
    merge_sort(a + half * size, tmp, n - half, size, cmp, ctx);
    if (cmp(a + (half - 1) * size, a + half * size, ctx) <= 0) {
        return;
    }
    memcpy(tmp, a, n * size);
    size_t i = 0, j = half, k = 0;
    while (i < half && j < n) {
        if (cmp(tmp + j * size, tmp + i * size, ctx) < 0) {
            memcpy(a + k * size, tmp + j * size, size);
            j++;
        } else {
            memcpy(a + k * size, tmp + i * size, size);
            i++;
        }
        k++;
    }
    while (i < half) {
        memcpy(a + k++ * size, tmp + i++ * size, size);
    }
    while (j < n) {
        memcpy(a + k++ * size, tmp + j++ * size, size);
    }
}

void dbs_sort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *, void *), void *ctx)
{
    if (n < 2) {
        return;
    }
    char *tmp = dbs_alloc(n * size);
    merge_sort(base, tmp, n, size, cmp, ctx);
}

/* -------------------------------------------------------------------- map */

static uint64_t hash_str(str s)
{
    uint64_t h = 1469598103934665603ULL;
    for (size_t i = 0; i < s.n; i++) {
        h ^= (unsigned char)s.s[i];
        h *= 1099511628211ULL;
    }
    return h;
}

static ssize_t smap_find(const smap *m, str key)
{
    if (m->icap == 0) {
        return -1;
    }
    size_t mask = m->icap - 1;
    for (size_t i = (size_t)hash_str(key) & mask;; i = (i + 1) & mask) {
        int32_t e = m->idx[i];
        if (e < 0) {
            return -1;
        }
        if (str_eq(m->e[e].key, key)) {
            return m->e[e].live ? e : -1;
        }
    }
}

static void smap_rehash(smap *m, size_t icap)
{
    m->idx = dbs_alloc(icap * sizeof(int32_t));
    memset(m->idx, 0xff, icap * sizeof(int32_t));
    m->icap = icap;
    size_t mask = icap - 1;
    for (size_t e = 0; e < m->n; e++) {
        if (!m->e[e].live) {
            continue;
        }
        size_t i = (size_t)hash_str(m->e[e].key) & mask;
        while (m->idx[i] >= 0) {
            i = (i + 1) & mask;
        }
        m->idx[i] = (int32_t)e;
    }
}

void *smap_get(const smap *m, str key)
{
    ssize_t e = smap_find(m, key);
    return e < 0 ? NULL : m->e[e].val;
}

bool smap_has(const smap *m, str key)
{
    return smap_find(m, key) >= 0;
}

void smap_set(smap *m, str key, void *val)
{
    ssize_t e = smap_find(m, key);
    if (e >= 0) {
        m->e[e].val = val;
        return;
    }
    if (m->n == m->cap) {
        vec_grow((void **)&m->e, &m->cap, m->n + 1, sizeof(sment));
    }
    m->e[m->n].key = key;
    m->e[m->n].val = val;
    m->e[m->n].live = true;
    m->n++;
    m->live++;
    if (m->n * 2 > m->icap) {
        smap_rehash(m, m->icap == 0 ? 16 : m->icap * 2);
    } else {
        size_t mask = m->icap - 1;
        size_t i = (size_t)hash_str(key) & mask;
        while (m->idx[i] >= 0) {
            i = (i + 1) & mask;
        }
        m->idx[i] = (int32_t)(m->n - 1);
    }
}

void smap_del(smap *m, str key)
{
    ssize_t e = smap_find(m, key);
    if (e < 0) {
        return;
    }
    m->e[e].live = false;
    m->live--;
    /* 지운 자리를 index에서 빼고 다시 만든다. 지우기는 드물다. */
    smap_rehash(m, m->icap);
}

void smap_keys_sorted(const smap *m, strs *out)
{
    SMAP_EACH(m, i) {
        PUSH(*out, m->e[i].key);
    }
    strs_sort(out);
}

/* ------------------------------------------------------------------- hash */

str dbs_sha256(str text)
{
    PHP_SHA256_CTX ctx;
    unsigned char digest[32];
    PHP_SHA256Init(&ctx);
    PHP_SHA256Update(&ctx, (const unsigned char *)text.s, text.n);
    PHP_SHA256Final(digest, &ctx);
    static const char hex[] = "0123456789abcdef";
    char out[7 + 64];
    memcpy(out, "sha256:", 7);
    for (int i = 0; i < 32; i++) {
        out[7 + 2 * i] = hex[digest[i] >> 4];
        out[8 + 2 * i] = hex[digest[i] & 15];
    }
    return str_of(out, sizeof out);
}

/* -------------------------------------------------------------- exceptions */

bool dbs_throw(zend_class_entry *ce, str message)
{
    /* 첫 예외만 던진다: 연산은 예외 뒤에도 끝까지 계산하고 결과를 버리므로 뒤의 실패가 첫 예외를 가리지 않는다. */
    if (EG(exception) != NULL) {
        return false;
    }
    /* message는 NUL을 담을 수 있으므로 C 문자열로 넘기지 않고 property로 쓴다. */
    zend_object *e = zend_throw_exception(ce, "", 0);
    zval m;
    ZVAL_STR(&m, str_zend(message));
    zend_update_property_ex(instanceof_function(ce, zend_ce_error) ? zend_ce_error : zend_ce_exception, e, ZSTR_KNOWN(ZEND_STR_MESSAGE), &m);
    zval_ptr_dtor(&m);
    return false;
}
