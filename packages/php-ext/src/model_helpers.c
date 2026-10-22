/*
 * The value helpers of Polyspec\Orm\Model (packages/php/src/Model.php) in C: prefixed, sixFractionDigits, arrayValue and
 * the datetime text they use. They keep the PHP client's rules. They are not registered in arginfo until the class is
 * (T182-6-5): the methods that call them are C bodies of the same class.
 */
#include "dbspec.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_exceptions.h"

/* Model::prefixed: the name is longer than the prefix, starts with it, and the next character is an upper-case ASCII letter. */
bool model_prefixed(str name, str prefix)
{
    if (name.n <= prefix.n || memcmp(name.s, prefix.s, prefix.n) != 0) {
        return false;
    }
    unsigned char c = (unsigned char)name.s[prefix.n];
    return c >= 'A' && c <= 'Z';
}

/* Model::sixFractionDigits: the text up to and including its first dot, then the first six digits of what follows, padded
 * with zeros (substr(substr($text, $dot + 1) . '000000', 0, 6)). A text without a dot gets `.000000`. */
str model_six_fraction_digits(str text)
{
    size_t dot = text.n;
    for (size_t i = 0; i < text.n; i++) {
        if (text.s[i] == '.') {
            dot = i;
            break;
        }
    }
    if (dot == text.n) {
        return fmt("%S.000000", text);
    }
    size_t head = dot + 1;
    size_t tail = text.n - head;
    char *out = dbs_alloc(head + 6);
    memcpy(out, text.s, head);
    for (size_t k = 0; k < 6; k++) {
        out[head + k] = k < tail ? text.s[head + k] : '0';
    }
    return (str){out, head + 6};
}

/* Model::arrayValue: a DateTimeInterface becomes its `Y-m-d H:i:s.u` text; any other value is returned unchanged. */
void model_array_value(zval *v, zval *ret)
{
    zend_string *name = zend_string_init("DateTimeInterface", sizeof("DateTimeInterface") - 1, 0);
    zend_class_entry *iface = zend_lookup_class(name);
    zend_string_release(name);
    if (Z_TYPE_P(v) == IS_OBJECT && iface != NULL && instanceof_function(Z_OBJCE_P(v), iface)) {
        zval arg, rv;
        ZVAL_STRING(&arg, "Y-m-d H:i:s.u");
        zend_call_method(Z_OBJ_P(v), Z_OBJCE_P(v), NULL, ZEND_STRL("format"), &rv, 1, &arg, NULL);
        zval_ptr_dtor(&arg);
        ZVAL_COPY_VALUE(ret, &rv);
        return;
    }
    ZVAL_COPY(ret, v);
}
