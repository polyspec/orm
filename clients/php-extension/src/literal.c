/* dbspec default, check literal, coordinate의 canonical literal 형식이다(PHP client Literal). */
#include "dbspec.h"
#include "Zend/zend_strtod.h"
#include "ext/spl/spl_exceptions.h"
#include <math.h>

static bool digit(char c)
{
    return c >= '0' && c <= '9';
}

/* `-?digits(.digits)?`를 부호, 정수 숫자, 소수 숫자로 나눈다. */
bool literal_number(str text, number *out)
{
    size_t i = 0;
    number n = {0};
    if (i < text.n && text.s[i] == '-') {
        n.negative = true;
        i++;
    }
    size_t start = i;
    while (i < text.n && digit(text.s[i])) {
        i++;
    }
    if (i == start) {
        return false;
    }
    n.digits = str_sub(text, start, i - start);
    if (i < text.n) {
        if (text.s[i] != '.') {
            return false;
        }
        i++;
        size_t f = i;
        while (i < text.n && digit(text.s[i])) {
            i++;
        }
        if (i == f || i != text.n) {
            return false;
        }
        n.has_fraction = true;
        n.fraction = str_sub(text, f, i - f);
    }
    if (out != NULL) {
        *out = n;
    }
    return true;
}

static str ltrim_zero(str s);

/* 0이나 앞자리 0에 부호가 없는 정수. */
bool literal_integer(str text, str *out)
{
    number n;
    if (!literal_number(text, &n) || n.has_fraction) {
        return false;
    }
    str digits = ltrim_zero(n.digits);
    if (digits.n == 0) {
        *out = SL("0");
    } else {
        *out = n.negative ? fmt("-%S", digits) : digits;
    }
    return true;
}

bool literal_string_value(str token, str *out)
{
    if (token.n < 2 || token.s[0] != '\'' || token.s[token.n - 1] != '\'') {
        return false;
    }
    *out = str_replace(str_sub(token, 1, token.n - 2), "''", "'");
    return true;
}

str literal_quote(str value)
{
    return fmt("'%S'", str_replace(value, "'", "''"));
}

static str ltrim_zero(str s)
{
    size_t i = 0;
    while (i < s.n && s.s[i] == '0') {
        i++;
    }
    return str_sub(s, i, s.n - i);
}

static str pad_zero(str s, size_t width)
{
    if (s.n >= width) {
        return s;
    }
    return fmt("%S%S", s, str_repeat("0", width - s.n));
}

static zend_long two(str s, size_t at)
{
    return (s.s[at] - '0') * 10 + (s.s[at + 1] - '0');
}

static bool all_digits(str s, size_t from, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        if (!digit(s.s[from + i])) {
            return false;
        }
    }
    return true;
}

/* `^([0-9]{4})-([0-9]{2})-([0-9]{2})$`이고 1년 이상의 checkdate다. */
static bool date_ok(str v)
{
    if (v.n != 10 || !all_digits(v, 0, 4) || v.s[4] != '-' || !all_digits(v, 5, 2) || v.s[7] != '-' || !all_digits(v, 8, 2)) {
        return false;
    }
    zend_long y = two(v, 0) * 100 + two(v, 2), m = two(v, 5), d = two(v, 8);
    if (y < 1 || m < 1 || m > 12 || d < 1) {
        return false;
    }
    static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    int max = days[m - 1];
    if (m == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0)) {
        max = 29;
    }
    return d <= max;
}

/* `HH:MM:SS[.f]`, 24:00:00 미만, 소수는 precision 이하 자리이며 precision 자리로 채운다. */
static bool time_text(str v, zend_long precision, str *out)
{
    if (v.n < 8 || !all_digits(v, 0, 2) || v.s[2] != ':' || !all_digits(v, 3, 2) || v.s[5] != ':' || !all_digits(v, 6, 2)) {
        return false;
    }
    str fraction = SL("");
    if (v.n > 8) {
        if (v.s[8] != '.' || v.n == 9 || !all_digits(v, 9, v.n - 9)) {
            return false;
        }
        fraction = str_sub(v, 9, v.n - 9);
    }
    if (two(v, 0) > 23 || two(v, 3) > 59 || two(v, 6) > 59 || (zend_long)fraction.n > precision) {
        return false;
    }
    str clock = str_sub(v, 0, 8);
    *out = precision > 0 ? fmt("%S.%S", clock, pad_zero(fraction, (size_t)precision)) : clock;
    return true;
}

static bool uuid_ok(str v)
{
    if (v.n != 36) {
        return false;
    }
    for (size_t i = 0; i < 36; i++) {
        char c = v.s[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != '-') {
                return false;
            }
        } else if (!(digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
            return false;
        }
    }
    return true;
}

static const char *const integer_limits[][3] = {
    {"i16", "32767", "32768"},
    {"i32", "2147483647", "2147483648"},
    {"i64", "9223372036854775807", "9223372036854775808"},
};

#define FAIL(m) do { *problem = (m); return false; } while (0)

bool literal_column_default(const ctype *type, str text, str *canonical, str *problem)
{
    str name = type->name;
    if (str_eqc(text, "now")) {
        if (str_eqc(name, "datetime")) {
            *canonical = SL("now");
            return true;
        }
        FAIL(SL("`now` is a default of a datetime column only"));
    }
    if (ctype_integer(type)) {
        str c;
        if (!literal_integer(text, &c)) {
            FAIL(fmt("%S default is not an integer", name));
        }
        const char *max = NULL, *min = NULL;
        for (int i = 0; i < 3; i++) {
            if (str_eqc(name, integer_limits[i][0])) {
                max = integer_limits[i][1];
                min = integer_limits[i][2];
            }
        }
        bool negative = c.s[0] == '-';
        str digits = negative ? str_sub(c, 1, c.n - 1) : c;
        str limit = negative ? str_c(min) : str_c(max);
        if (digits.n > limit.n || (digits.n == limit.n && str_cmp(digits, limit) > 0)) {
            FAIL(fmt("%S default is out of range", name));
        }
        *canonical = c;
        return true;
    }
    if (str_eqc(name, "bool")) {
        if (str_eqc(text, "true") || str_eqc(text, "false")) {
            *canonical = text;
            return true;
        }
        FAIL(SL("bool default is not true or false"));
    }
    if (str_eqc(name, "decimal")) {
        zend_long precision = type->p[0], scale = type->p[1];
        number n;
        if (!literal_number(text, &n)) {
            FAIL(SL("decimal default is not a number"));
        }
        str digits = ltrim_zero(n.digits);
        str fraction = n.has_fraction ? n.fraction : SL("");
        if ((zend_long)digits.n > precision - scale) {
            FAIL(fmt("decimal default has more than %d integer digits", precision - scale));
        }
        if ((zend_long)fraction.n > scale) {
            FAIL(fmt("decimal default has more than %d fraction digits", scale));
        }
        bool zero = digits.n == 0 && str_trim_set(fraction, "0").n == 0;
        *canonical = fmt("%s%S%S", n.negative && !zero ? "-" : "", digits.n == 0 ? SL("0") : digits,
            scale > 0 ? fmt(".%S", pad_zero(fraction, (size_t)scale)) : SL(""));
        return true;
    }
    if (str_eqc(name, "f64")) {
        if (!literal_number(text, NULL)) {
            FAIL(SL("f64 default is not a number"));
        }
        double value = zend_strtod(str_of(text.s, text.n).s, NULL);
        if (!isfinite(value)) {
            FAIL(SL("f64 default is not a finite double"));
        }
        *canonical = literal_shortest_decimal(value);
        return true;
    }
    if (str_eqc(name, "text") || str_eqc(name, "bytes")) {
        FAIL(fmt("a %S column has no default", name));
    }
    str value;
    if (!literal_string_value(text, &value)) {
        FAIL(fmt("%S default is not a quoted string", name));
    }
    if (str_eqc(name, "varchar")) {
        if (str_hasch(value, '\0')) {
            FAIL(SL("varchar default contains U+0000"));
        }
        if ((zend_long)utf8_length(value) > type->p[0]) {
            FAIL(fmt("varchar default is longer than %d characters", type->p[0]));
        }
        *canonical = literal_quote(value);
        return true;
    }
    if (str_eqc(name, "uuid")) {
        if (!uuid_ok(value)) {
            FAIL(SL("uuid default is not canonical uuid text"));
        }
        *canonical = literal_quote(str_lower(value));
        return true;
    }
    if (str_eqc(name, "date")) {
        if (!date_ok(value)) {
            FAIL(SL("date default is not a date from 0001-01-01 to 9999-12-31"));
        }
        *canonical = literal_quote(value);
        return true;
    }
    if (str_eqc(name, "time")) {
        str t;
        if (!time_text(value, type->p[0], &t)) {
            FAIL(fmt("time default is not a time of day with at most %d fraction digits", type->p[0]));
        }
        *canonical = literal_quote(t);
        return true;
    }
    if (str_eqc(name, "datetime")) {
        str t;
        if (!(value.n > 11 && value.s[10] == ' ' && date_ok(str_sub(value, 0, 10)) && time_text(str_sub(value, 11, value.n - 11), type->p[0], &t))) {
            FAIL(fmt("datetime default is not a date-time with at most %d fraction digits", type->p[0]));
        }
        *canonical = literal_quote(fmt("%S%S", str_sub(value, 0, 11), t));
        return true;
    }
    zend_throw_exception_ex(spl_ce_LogicException, 0, "Unknown column type %s", str_of(name.s, name.n).s);
    *problem = SL("");
    return false;
}

/* 같은 double로 다시 읽히는 가장 짧은 지수 없는 10진수다. 정수 값에는 점이 없고 음의 0은 `0`이다. */
str literal_shortest_decimal(double value)
{
    if (value == 0.0) {
        return SL("0");
    }
    char buf[64];
    for (int precision = 0; precision < 17; precision++) {
        snprintf(buf, sizeof buf, "%.*e", precision, value);
        if (zend_strtod(buf, NULL) == value) {
            break;
        }
    }
    /* buf는 -?d(.ddd)?e[+-]dd 이다. */
    str s = str_c(buf);
    size_t i = 0;
    bool negative = s.s[0] == '-';
    if (negative) {
        i++;
    }
    sbuf digits = {0};
    while (i < s.n && s.s[i] != 'e') {
        if (s.s[i] != '.') {
            sb_ch(&digits, s.s[i]);
        }
        i++;
    }
    zend_long exponent = ZEND_STRTOL(s.s + i + 1, NULL, 10);
    str d = sb_str(&digits);
    while (d.n > 0 && d.s[d.n - 1] == '0') {
        d.n--;
    }
    zend_long point = 1 + exponent;
    str plain;
    if (point <= 0) {
        plain = fmt("0.%S%S", str_repeat("0", (size_t)-point), d);
    } else if (point >= (zend_long)d.n) {
        plain = fmt("%S%S", d, str_repeat("0", (size_t)point - d.n));
    } else {
        plain = fmt("%S.%S", str_sub(d, 0, (size_t)point), str_sub(d, (size_t)point, d.n - (size_t)point));
    }
    return negative ? fmt("-%S", plain) : plain;
}
