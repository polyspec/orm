<?php
declare(strict_types=1);

namespace Orm;

/**
 * PHP compatibility layer (docs/dsl.md §6 "PHP 호환층").
 *
 * The generated query and Where classes `use` the two traits below; their `__call`
 * translates the dynamic PHP grammar into calls on the same Q/W
 * primitives the canonical typed methods use, so an old-style chain and its canonical
 * spelling produce byte-identical IR (Req::shape()). Method names are decoded once per
 * (class, name) and memoized in a static array (opcache-friendly: the table is rebuilt
 * per process, never per request); the decoded instruction is then run with the call's
 * arguments. Nothing here reaches the engine or changes canonical behaviour.
 */
final class Compat
{
    /** @var array<string, array<string, array>> decoded instructions: class → method name → instruction */
    private static array $memo = [];

    /** op-first words of a predicate name and the IR op (or the value-driven pseudo ops) they select */
    private const OPS = ['Gt' => 'gt', 'Lt' => 'lt', 'Ge' => 'gte', 'Le' => 'lte', 'Eq' => 'eq', 'Ne' => 'ne', 'Lk' => 'lk', 'Lb' => 'lb', 'In' => 'in', 'Nin' => 'not_in', 'Between' => 'between'];
    private const OPS2 = ['Not In' => 'not_in', 'Is Null' => 'is_null', 'Not Null' => 'is_not_null', 'Is Not Null' => 'is_not_null'];

    /** names handled by the traits' exact-name switch */
    private const EXACT = ['condition' => 1, 'get' => 1, 'gets' => 1, 'getAll' => 1, 'getsAll' => 1, 'getCount' => 1, 'getsCount' => 1, 'create' => 1,
        'relation' => 1, 'relations' => 1, 'oneToOne' => 1, 'oneToMany' => 1, 'match' => 1, 'alias' => 1, 'keyName' => 1, 'fetchKey' => 1,
        'parentNode' => 1, 'groupLimit' => 1, 'deleteLock' => 1, 'addColumn' => 1, 'addColumns' => 1, 'removeColumn' => 1, 'removeColumns' => 1,
        'addAllColumns' => 1, 'removeAllColumns' => 1, 'onlyColumns' => 1, 'duplication' => 1, 'forceIndex' => 1, 'orderBy' => 1];

    /** Decodes a compat method name for the entity's column table; memoized per (class, name). Errors are not memoized. */
    public static function decode(string $class, string $entity, string $name): array
    {
        return self::$memo[$class][$name] ??= self::decodeName($entity, $name);
    }

    private static function decodeName(string $entity, string $name): array
    {
        if (isset(self::EXACT[$name])) {
            return ['k' => 'exact'];
        }
        $cols = Registry::row($entity)::columns();
        $has = fn(string $p) => str_starts_with($name, $p);
        return match (true) {
            $has('groupBy') => ['k' => 'group', 'cols' => array_map(fn(array $it) => $it[0], self::orderList($entity, $cols, substr($name, 7), false))],
            $has('orderBy') => ['k' => 'order', 'items' => self::orderList($entity, $cols, substr($name, 7), true)],
            $has('where') => self::cond($entity, $cols, substr($name, 5), false, false, null, false),
            $has('condition') => self::cond($entity, $cols, substr($name, 9), false, false, null, false),
            $has('and') => self::cond($entity, $cols, substr($name, 3), false, false, null, false),
            $has('onDuplicate'), $has('one') => self::unknown($entity, $name),
            $has('on') => self::cond($entity, $cols, substr($name, 2), false, true, null, false),
            $has('or') => self::cond($entity, $cols, substr($name, 2), true, false, null, false),
            $has('keyName') => ['k' => 'keyName', 'col' => self::wholeColumn($entity, $cols, substr($name, 7))],
            $has('alias') => ['k' => 'alias', 'name' => Names::snake(substr($name, 5))],
            $has('matchAll') => ['k' => 'match', 'all' => true] + self::pair(substr($name, 8), $name),
            $has('match') => ['k' => 'match', 'all' => false] + self::pair(substr($name, 5), $name),
            $has('possible') => ['k' => 'possible', 'col' => Names::snake(substr($name, 8))],
            $has('relations') => ['k' => 'rel', 'many' => true] + self::pair(substr($name, 9), $name),
            $has('relation') => ['k' => 'rel', 'many' => false] + self::pair(substr($name, 8), $name),
            $has('leftJoin') => ['k' => 'join', 'left' => true] + self::pair(substr($name, 8), $name),
            $has('join') => ['k' => 'join', 'left' => false] + self::pair(substr($name, 4), $name),
            $has('getsAllBy') => self::cond($entity, $cols, substr($name, 9), false, false, 'all', true),
            $has('getAllBy') => self::cond($entity, $cols, substr($name, 8), false, false, 'one', true),
            $has('getsBy') => self::cond($entity, $cols, substr($name, 6), false, false, 'all', false),
            $has('getBy') => self::cond($entity, $cols, substr($name, 5), false, false, 'one', false),
            $has('getCountBy') => self::cond($entity, $cols, substr($name, 10), false, false, 'count', false),
            $has('getSum') => ['k' => 'agg', 'fn' => 'sum', 'col' => self::wholeColumn($entity, $cols, substr($name, 6))],
            $has('getAvg') => ['k' => 'agg', 'fn' => 'avg', 'col' => self::wholeColumn($entity, $cols, substr($name, 6))],
            $has('addRawColumn') => ['k' => 'addRawColumn', 'col' => Names::snake(substr($name, 12))],
            $has('addColumn') => self::addColumn($entity, $cols, substr($name, 9)),
            $has('removeColumn') => ['k' => 'removeColumn', 'col' => self::wholeColumn($entity, $cols, substr($name, 12))],
            $has('setRaw') => ['k' => 'setRaw', 'col' => self::wholeColumn($entity, $cols, substr($name, 6))],
            default => self::unknown($entity, $name),
        };
    }

    private static function unknown(string $entity, string $name): never
    {
        throw new \BadMethodCallException("$entity: $name is neither a generated method nor a token the compatibility layer translates (docs/dsl.md §6)");
    }

    // ---- names ----

    /** Camel words and parens: "ServiceSeqAnd((IsSaleAndLtSaleStartDt)Or(IsSale))" → [Service, Seq, And, (, (, Is, Sale, …]. '_' separates words (and('is_sale', 1)). */
    public static function tokens(string $s): array
    {
        preg_match_all('/\(|\)|[A-Z][a-z0-9]*|[a-z0-9]+/', $s, $m);
        return $m[0];
    }

    private static function snake(array $words): string
    {
        return strtolower(implode('_', $words));
    }

    /** Longest run of $words from $from whose snake form is a column: [column, words consumed], or null. */
    private static function longest(array $cols, array $words, int $from): ?array
    {
        for ($k = count($words) - $from; $k >= 1; $k--) {
            $c = self::snake(array_slice($words, $from, $k));
            if (isset($cols[$c])) {
                return [$c, $k];
            }
        }
        return null;
    }

    private static function columnUnknown(string $entity, array $cols, array $words, string $what): OrmException
    {
        $first = strtolower($words[0] ?? '');
        $cands = array_values(array_filter(array_keys($cols), fn(string $c) => $first !== '' && str_starts_with($c, $first)));
        if ($cands === []) {
            $cands = array_keys($cols);
        }
        return new OrmException(Code::COLUMN_UNKNOWN, "$entity has no column " . self::snake($words) . " ($what); candidates: " . implode(', ', $cands));
    }

    /** The whole camel string must be one column (keyNameX, removeColumnX, setRawX, getSumX). */
    private static function wholeColumn(string $entity, array $cols, string $s): string
    {
        $words = self::tokens($s);
        $m = self::longest($cols, $words, 0);
        if ($m === null || $m[1] !== count($words)) {
            throw self::columnUnknown($entity, $cols, $words, $s);
        }
        return $m[0];
    }

    /** "AWithB" → ['l' => a, 'r' => b] (matchAWithB, relationAWithB, joinAWithB); '' → nulls (relation(new Y), match('a', 'b')). */
    private static function pair(string $s, string $name): array
    {
        if ($s === '') {
            return ['l' => null, 'r' => null];
        }
        $words = self::tokens($s);
        $at = array_search('With', $words, true);
        if ($at === false || $at === 0 || $at === count($words) - 1) {
            throw new OrmException(Code::IR_INVALID, "$name: expected <Left>With<Right>");
        }
        return ['l' => self::snake(array_slice($words, 0, $at)), 'r' => self::snake(array_slice($words, $at + 1))];
    }

    /** orderByXAndYDesc / groupByXAndY: split on the literal And; each part is a column with an optional Asc/Desc tail. @return list<array{0: string, 1: bool}> */
    private static function orderList(string $entity, array $cols, string $s, bool $dir): array
    {
        $out = [];
        foreach (self::splitAnd(self::tokens($s)) as $words) {
            $m = self::longest($cols, $words, 0);
            if ($m === null) {
                throw self::columnUnknown($entity, $cols, $words, $s);
            }
            $tail = array_slice($words, $m[1]);
            if ($tail === []) {
                $out[] = [$m[0], false];
            } elseif ($dir && ($tail === ['Asc'] || $tail === ['Desc'])) {
                $out[] = [$m[0], $tail === ['Desc']];
            } else {
                throw self::columnUnknown($entity, $cols, $words, $s);
            }
        }
        return $out;
    }

    /** @return list<list<string>> */
    private static function splitAnd(array $words): array
    {
        $parts = [[]];
        foreach ($words as $w) {
            if ($w === 'And') {
                $parts[] = [];
            } else {
                $parts[count($parts) - 1][] = $w;
            }
        }
        return $parts;
    }

    /** addColumnX → select X; addColumnXAliasY → select X as y (a format argument makes it selectExpr). */
    private static function addColumn(string $entity, array $cols, string $s): array
    {
        $words = self::tokens($s);
        $m = self::longest($cols, $words, 0);
        if ($m === null) {
            throw self::columnUnknown($entity, $cols, $words, $s);
        }
        $tail = array_slice($words, $m[1]);
        if ($tail === []) {
            return ['k' => 'addColumn', 'col' => $m[0], 'as' => null];
        }
        if ($tail[0] === 'Alias' && count($tail) > 1) {
            return ['k' => 'addColumn', 'col' => $m[0], 'as' => self::snake(array_slice($tail, 1))];
        }
        throw self::columnUnknown($entity, $cols, $words, $s);
    }

    // ---- conditions ----

    /**
     * A condition name after its prefix. '(' / ')' are the paren tokens; anything else is
     * pred (And|Or pred)* with nested parens, compiled to a flat program:
     *   ['(', or] · [')'] · ['p', or, column, op, argIndex|null] · ['m', or, columns, boolean, argIndex]
     */
    private static function cond(string $entity, array $cols, string $rest, bool $or, bool $on, ?string $term, bool $all): array
    {
        if ($rest === '(' || $rest === ')') {
            return ['k' => 'paren', 'or' => $or, 'open' => $rest === '('];
        }
        $tok = self::tokens($rest);
        if ($tok === []) {
            throw new OrmException(Code::IR_INVALID, "$entity: empty condition name");
        }
        $i = 0;
        $prog = [];
        $n = 0;
        self::expr($entity, $cols, $tok, $i, $or, $prog, $n);
        if ($i !== count($tok)) {
            throw new OrmException(Code::IR_INVALID, "$entity: unexpected ')' in $rest");
        }
        return ['k' => 'cond', 'on' => $on, 'prog' => $prog, 'n' => $n, 'term' => $term, 'all' => $all];
    }

    private static function expr(string $entity, array $cols, array $tok, int &$i, bool $or, array &$prog, int &$n): void
    {
        while (true) {
            self::term($entity, $cols, $tok, $i, $or, $prog, $n);
            if ($i >= count($tok) || $tok[$i] === ')') {
                return;
            }
            $or = match ($tok[$i]) {
                'And' => false,
                'Or' => true,
                default => throw new OrmException(Code::IR_INVALID, "$entity: expected And/Or before " . $tok[$i]),
            };
            $i++;
        }
    }

    private static function term(string $entity, array $cols, array $tok, int &$i, bool $or, array &$prog, int &$n): void
    {
        if (($tok[$i] ?? null) === '(') {
            $i++;
            $prog[] = ['(', $or];
            self::expr($entity, $cols, $tok, $i, false, $prog, $n);
            if (($tok[$i] ?? null) !== ')') {
                throw new OrmException(Code::IR_INVALID, "$entity: '(' without ')' in a condition name");
            }
            $i++;
            $prog[] = [')'];
            return;
        }
        $words = [];
        while ($i < count($tok) && !in_array($tok[$i], ['And', 'Or', '(', ')'], true)) {
            $words[] = $tok[$i++];
        }
        if ($words === []) {
            throw new OrmException(Code::IR_INVALID, "$entity: empty predicate in a condition name");
        }
        $prog[] = self::pred($entity, $cols, $words, $or, $n);
    }

    /** One predicate: [op-first word(s)] column, or Fulltext[Boolean]<A>With<B>. Longest match against the column table; both readings valid = ambiguous. */
    private static function pred(string $entity, array $cols, array $words, bool $or, int &$n): array
    {
        if ($words[0] === 'Fulltext') {
            $boolean = ($words[1] ?? '') === 'Boolean';
            $list = [];
            foreach (self::splitOn(array_slice($words, $boolean ? 2 : 1), 'With') as $part) {
                $m = $part === [] ? null : self::longest($cols, $part, 0);
                if ($m === null || $m[1] !== count($part)) {
                    throw self::columnUnknown($entity, $cols, $part === [] ? $words : $part, implode('', $words));
                }
                $list[] = $m[0];
            }
            return ['m', $or, $list, $boolean, $n++];
        }
        if (in_array('With', $words, true)) {
            throw new OrmException(Code::IR_INVALID, "$entity: " . implode('', $words) . " compares two columns; the compat layer does not translate it — use <col>EqCol(XCols::y()) (docs/dsl.md §2.1)");
        }
        $op = null;
        $len = 0;
        foreach ([3, 2] as $k) {
            $key = implode(' ', array_slice($words, 0, $k));
            if (isset(self::OPS2[$key])) {
                $op = self::OPS2[$key];
                $len = $k;
                break;
            }
        }
        if ($op === null && isset(self::OPS[$words[0]])) {
            $op = self::OPS[$words[0]];
            $len = 1;
        }
        $plain = self::longest($cols, $words, 0);
        $plain = $plain !== null && $plain[1] === count($words) ? $plain[0] : null;
        $withOp = null;
        if ($op !== null && $len < count($words)) {
            $withOp = self::longest($cols, $words, $len);
            $withOp = $withOp !== null && $withOp[1] === count($words) - $len ? $withOp[0] : null;
        }
        if ($plain !== null && $withOp !== null) {
            throw new OrmException(Code::COLUMN_UNKNOWN, "$entity: " . implode('', $words) . " is ambiguous: column $plain (=) or $op on column $withOp");
        }
        if ($plain !== null) {
            return ['p', $or, $plain, 'auto', $n++];
        }
        if ($withOp !== null) {
            $needsArg = $op !== 'is_null' && $op !== 'is_not_null';
            return ['p', $or, $withOp, $op, $needsArg ? $n++ : null];
        }
        throw self::columnUnknown($entity, $cols, $op !== null ? array_slice($words, $len) : $words, implode('', $words));
    }

    /** @return list<list<string>> */
    private static function splitOn(array $words, string $sep): array
    {
        $parts = [[]];
        foreach ($words as $w) {
            if ($w === $sep) {
                $parts[] = [];
            } else {
                $parts[count($parts) - 1][] = $w;
            }
        }
        return $parts;
    }

    // ---- running ----

    /**
     * Runs a compiled condition program with the call's arguments against the current group.
     * $cur returns the W to add to; $open(bool $or) / $close() nest groups the way and(fn) does.
     */
    public static function run(array $ins, array $args, string $name, string $entity, \Closure $cur, \Closure $open, \Closure $close): void
    {
        if (count($args) !== $ins['n']) {
            throw new OrmException(Code::IR_INVALID, "$entity: $name expects {$ins['n']} argument(s), " . count($args) . ' given');
        }
        $args = array_values($args);
        foreach ($ins['prog'] as $step) {
            switch ($step[0]) {
                case '(':
                    $open($step[1]);
                    break;
                case ')':
                    $close();
                    break;
                case 'm':
                    $w = $cur();
                    if ($step[1]) {
                        $w->orConn();
                    }
                    $w->match($step[2], $step[3], (string) $args[$step[4]]);
                    break;
                default:
                    $w = $cur();
                    if ($step[1]) {
                        $w->orConn();
                    }
                    self::pred1($w, $entity, $step[2], $step[3], $step[4] === null ? null : $args[$step[4]]);
            }
        }
    }

    /** One predicate with implicit operators: no op → = / IN (array) / IS NULL (null); Ne → != / NOT IN / IS NOT NULL; Lk/Lb → LIKE %v% (no escaping). */
    private static function pred1(W $w, string $entity, string $col, string $op, mixed $v): void
    {
        if (is_object($v) && !$v instanceof \Stringable) {
            throw new OrmException(Code::IR_INVALID, "$entity.$col: an object value is not translated; use expr(fragment, binds)");
        }
        switch ($op) {
            case 'auto':
            case 'eq':
                if ($v === null) {
                    $w->predNull($col, 'is_null');
                } elseif (is_array($v)) {
                    $w->predList($col, 'in', array_values($v));
                } else {
                    $w->pred($col, 'eq', $v);
                }
                return;
            case 'ne':
                if ($v === null) {
                    $w->predNull($col, 'is_not_null');
                } elseif (is_array($v)) {
                    $w->predList($col, 'not_in', array_values($v));
                } else {
                    $w->pred($col, 'not_eq', $v);
                }
                return;
            case 'lk':
                $w->pred($col, 'like', '%' . $v . '%');
                return;
            case 'lb':
                $w->pred($col, 'like_binary', '%' . $v . '%');
                return;
            case 'between':
                if (!is_array($v) || count($v) !== 2) {
                    throw new OrmException(Code::IR_INVALID, "$entity.$col: between takes [low, high]");
                }
                $w->predList($col, 'between', array_values($v));
                return;
            case 'in':
            case 'not_in':
                if (!is_array($v)) {
                    throw new OrmException(Code::IR_INVALID, "$entity.$col: $op takes an array");
                }
                $w->predList($col, $op, array_values($v));
                return;
            case 'is_null':
            case 'is_not_null':
                $w->predNull($col, $op);
                return;
            default:
                $w->pred($col, $op, $v);
        }
    }

    /**
     * Dynamic fragments bind by name (':x'); the engine binds by position. Every ':name' becomes '?'
     * in order and its value is taken from $binds[':name'] or $binds['name']. A fragment without
     * names keeps its '?' and the binds as given.
     */
    public static function positional(string $frag, array $binds): array
    {
        $out = [];
        $frag2 = preg_replace_callback('/(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)/', function (array $m) use (&$out, $binds): string {
            $k = $m[1];
            if (array_key_exists(":$k", $binds)) {
                $out[] = $binds[":$k"];
            } elseif (array_key_exists($k, $binds)) {
                $out[] = $binds[$k];
            } else {
                throw new OrmException(Code::IR_INVALID, "bind :$k missing for fragment $m[0]");
            }
            return '?';
        }, $frag);
        return $out === [] ? [$frag, array_values($binds)] : [$frag2, $out];
    }

    /**
     * The relation of $parent that a child selects: target = the child's entity, the
     * matchAWithB pair = (left, right) of the manifest relation, alias<Name> = the relation name
     * when the pair fits several. No match given → the unique target relation, or the default pair when ambiguous.
     */
    public static function resolveRelation(string $parent, string $child, ?array $match, ?string $alias, ?string $kind): string
    {
        $rels = Registry::row($parent)::relations();
        if ($match === null) {
            $target = array_filter($rels, fn(array $r): bool => $r['target'] === $child);
            if (count($target) === 1) {
                $name = array_key_first($target);
                if ($kind !== null && $target[$name]['kind'] !== $kind) {
                    $want = $kind === 'one' ? 'relation' : 'relations';
                    $is = $target[$name]['kind'] === 'one' ? 'relation (1:1)' : 'relations (1:N)';
                    $declared = implode(', ', array_map(fn(string $n, array $r) => "$n ({$r['kind']} {$r['target']} on {$r['left']} = {$r['right']})", array_keys($rels), $rels));
                    throw new OrmException(Code::RELATION_UNKNOWN, "$parent.$name is $is, not $want; declared: $declared");
                }
                return $name;
            }
            $pk = Registry::row($child)::pk();
            $match = [$pk, $child . '_' . $pk];
        }
        $fit = [];
        foreach ($rels as $name => $r) {
            if ($r['target'] === $child && $r['left'] === $match[0] && $r['right'] === $match[1]) {
                $fit[$name] = $r;
            }
        }
        $declared = implode(', ', array_map(fn(string $n, array $r) => "$n ({$r['kind']} {$r['target']} on {$r['left']} = {$r['right']})", array_keys($rels), $rels));
        if ($alias !== null && isset($fit[$alias])) {
            $name = $alias;
        } elseif (count($fit) === 1) {
            $name = array_key_first($fit);
        } elseif ($fit === []) {
            throw new OrmException(Code::RELATION_UNKNOWN, "$parent has no relation to $child on $parent.{$match[0]} = $child.{$match[1]}" . ($alias !== null ? " (alias $alias)" : '') . "; declared: " . ($declared === '' ? 'none' : $declared));
        } else {
            throw new OrmException(Code::RELATION_UNKNOWN, "$parent has several relations to $child on {$match[0]} = {$match[1]}: " . implode(', ', array_keys($fit)) . '; pick one with alias<Name>()');
        }
        if ($kind !== null && $rels[$name]['kind'] !== $kind) {
            $want = $kind === 'one' ? 'relation' : 'relations';
            $is = $rels[$name]['kind'] === 'one' ? 'relation (1:1)' : 'relations (1:N)';
            throw new OrmException(Code::RELATION_UNKNOWN, "$parent.$name is $is, not $want; declared: $declared");
        }
        return $name;
    }

    /** Dynamic terminals consume values; their connection is already bound. */
    public static function db(array &$args, string $name, ?Db $bound = null): Db
    {
        if (($args[0] ?? null) instanceof Db || ($args[0] ?? null) instanceof \PDO) {
            throw new OrmException(Code::IR_INVALID, "$name accepts values; bind the connection on the model");
        }
        if ($bound instanceof Tx) { $bound->assertActive(); }
        return $bound ?? throw new OrmException(Code::CONFIG, 'bind a database or transaction before executing');
    }

    /** How and()/or() with a non-closure argument is meant: nothing, a paren token, a raw fragment, or a condition name. */
    public static function connKind(mixed $x): string
    {
        if ($x === null) {
            return 'none';
        }
        if ($x instanceof \Closure) {
            return 'closure';
        }
        $x = trim((string) $x);
        return match (true) {
            $x === '(' => 'open',
            $x === ')' => 'close',
            str_contains($x, ' ') => 'raw',
            default => 'name',
        };
    }
}

/** Compat `__call` for the generated Where builders: predicates, paren tokens, raw fragments inside and(fn)/on(fn)/where(fn). */
trait CompatWhere
{
    /** @var list<W> groups enclosing the current one, opened by '(' tokens */
    private array $cstack = [];

    public function __call(string $name, array $args): static
    {
        $ins = Compat::decode(static::class, static::ENTITY, $name);
        switch ($ins['k']) {
            case 'cond':
                if ($ins['on'] || $ins['term'] !== null) {
                    throw new \BadMethodCallException(static::class . "::$name: on*/get* belong to the query, not the Where builder");
                }
                Compat::run($ins, $args, $name, static::ENTITY, fn() => $this->w, fn(bool $or) => $this->compatParen($or, true), fn() => $this->compatParen(false, false));
                return $this;
            case 'paren':
                $this->compatParen($ins['or'], $ins['open']);
                return $this;
            case 'exact':
                if ($name === 'condition') {
                    return $this->compatConn('condition', $args[0] ?? null, $args[1] ?? null);
                }
        }
        throw new \BadMethodCallException(static::class . "::$name is not part of the Where builder");
    }

    private function compatParen(bool $or, bool $open): void
    {
        if ($open) {
            if ($or) {
                $this->w->orConn();
            }
            $this->cstack[] = $this->w;
            $this->w = $this->w->group();
            return;
        }
        if ($this->cstack === []) {
            throw new OrmException(Code::PAREN_ACROSS_MODELS, "')' inside " . static::class . " closes no '(' opened in the same closure");
        }
        $this->w->req->end();
        $this->w = array_pop($this->cstack);
    }

    /** and($x, $v) / or($x, $v) / condition($x, $binds) with a non-closure $x. */
    public function compatConn(string $conn, mixed $x, mixed $v): static
    {
        switch (Compat::connKind($x)) {
            case 'none':
                if ($conn === 'or') {
                    $this->w->orConn();
                }
                return $this;
            case 'closure':
                $this->w->orConn();
                return $this->and($x);
            case 'open':
                $this->compatParen($conn === 'or', true);
                return $this;
            case 'close':
                $this->compatParen(false, false);
                return $this;
            case 'raw':
                if ($conn === 'or') {
                    $this->w->orConn();
                }
                [$frag, $binds] = Compat::positional(trim((string) $x), is_array($v) ? $v : []);
                $this->w->expr($frag, $binds);
                return $this;
            default:
                return $this->__call($conn . Names::pascal(trim((string) $x)), [$v]);
        }
    }
}

/** Compat `__call` for the generated query classes: the dynamic chain grammar (docs/dsl.md §6). */
trait CompatQuery
{
    /** @var array{0: string, 1: string}|null matchAWithB: (parent column, child column) of the relation this child selects */
    private ?array $cMatch = null;
    /** alias<Name>: the relation name when the pair fits several (also the attach key, which the row does not carry) */
    private ?string $cAlias = null;
    /** matchAWithB(false): remove the child's match column → dropChildKey at attach */
    private bool $cDropKey = false;
    /** keyName<Col>: key_by at attach (relations child) or client-side keying at the root terminal */
    private ?string $cKeyName = null;

    public function __call(string $name, array $args): mixed
    {
        $ins = Compat::decode(static::class, static::ENTITY, $name);
        switch ($ins['k']) {
            case 'cond':
                return $this->compatCond($ins, $args, $name);
            case 'paren':
                if ($ins['open']) {
                    $this->openGroup($ins['or']);
                } else {
                    $this->closeGroup();
                }
                return $this;
            case 'exact':
                return $this->compatExact($name, $args);
            case 'order':
                foreach ($ins['items'] as [$col, $desc]) {
                    if (isset($args[0]) && is_string($args[0])) {
                        $this->orderExpr(sprintf($args[0], "`$col`"), $desc);
                    } else {
                        $this->order($col, $desc);
                    }
                }
                return $this;
            case 'group':
                foreach ($ins['cols'] as $col) {
                    $this->groupBy($col);
                }
                return $this;
            case 'keyName':
                $this->cKeyName = $ins['col'];
                return $this;
            case 'alias':
                $this->cAlias = $ins['name'];
                return $this;
            case 'match':
                if ($ins['all']) {
                    $this->colMode('all');
                }
                $this->compatMatch($ins['l'], $ins['r'], $args[0] ?? null);
                return $this;
            case 'possible':
                if (!array_key_exists(0, $args)) {
                    throw new OrmException(Code::IR_INVALID, "$name(value) needs the parent value");
                }
                $this->ifParent($ins['col'], $args[0]);
                return $this;
            case 'rel':
                return $this->compatRelation($args[0] ?? null, $ins['many'], $ins['l'], $ins['r'], $name);
            case 'join':
                return $this->compatJoin($args[0] ?? null, $args[1] ?? null, $ins['left'], $ins['l'], $ins['r'], $name);
            case 'addColumn':
                $this->compatAddColumn($ins['col'], $ins['as'], $args[0] ?? null, $name);
                return $this;
            case 'removeColumn':
                $this->colRemove($ins['col']);
                return $this;
            case 'addRawColumn':
                $this->colExpr($ins['col'], (string) ($args[0] ?? throw new OrmException(Code::IR_INVALID, "$name(sql) needs the fragment")));
                return $this;
            case 'setRaw':
                [$frag, $binds] = Compat::positional((string) ($args[0] ?? ''), is_array($args[1] ?? null) ? $args[1] : []);
                $this->setExpr($ins['col'], $frag, $binds);
                return $this;
            case 'agg':
                $this->terminalArity(count($args));
                return (float) $this->runScalar(Compat::db($args, $name, $this->boundDb()), $ins['fn'], $ins['col']);
        }
        throw new \BadMethodCallException(static::class . "::$name");
    }

    /** and($x, $v) / or($x, $v) / condition($x, $binds) with a non-closure $x (the generated and()/or() route here). */
    public function compatConn(string $conn, mixed $x, mixed $v): static
    {
        switch (Compat::connKind($x)) {
            case 'none':
                if ($conn === 'or') {
                    $this->orConn();
                }
                return $this;
            case 'closure':
                $this->orConn();
                return $this->and($x);
            case 'open':
                $this->openGroup($conn === 'or');
                return $this;
            case 'close':
                $this->closeGroup();
                return $this;
            case 'raw':
                if ($conn === 'or') {
                    $this->orConn();
                }
                [$frag, $binds] = Compat::positional(trim((string) $x), is_array($v) ? $v : []);
                $this->w()->expr($frag, $binds);
                return $this;
            default:
                return $this->__call($conn . Names::pascal(trim((string) $x)), [$v]);
        }
    }

    private function compatCond(array $ins, array $args, string $name): mixed
    {
        $db = null;
        if ($ins['term'] !== null) {
            $db = Compat::db($args, $name, $this->boundDb());
        }
        if ($ins['all']) {
            $this->colMode('all');
        }
        if ($ins['on']) {
            $w = $this->onW();
            $stack = [];
            Compat::run($ins, $args, $name, static::ENTITY, fn() => $w,
                function (bool $or) use (&$w, &$stack): void {
                    if ($or) {
                        $w->orConn();
                    }
                    $stack[] = $w;
                    $w = $w->group();
                },
                function () use (&$w, &$stack): void {
                    $w->req->end();
                    $w = array_pop($stack);
                });
        } else {
            Compat::run($ins, $args, $name, static::ENTITY, fn() => $this->w(), fn(bool $or) => $this->openGroup($or), fn() => $this->closeGroup());
        }
        return match ($ins['term']) {
            null => $this,
            'one' => $this->compatGet($db),
            'all' => $this->compatGets($db),
            'count' => $this->count(),
        };
    }

    private function compatExact(string $name, array $args): mixed
    {
        if (in_array($name, ['get', 'gets', 'getAll', 'getsAll', 'getCount', 'getsCount', 'create'], true)) {
            $this->terminalArity(count($args));
        }
        switch ($name) {
            case 'condition':
                return $this->compatConn('condition', $args[0] ?? null, $args[1] ?? null);
            case 'get':
                return $this->compatGet(Compat::db($args, $name, $this->boundDb()));
            case 'gets':
                return $this->compatGets(Compat::db($args, $name, $this->boundDb()));
            case 'getAll':
                $this->colMode('all');
                return $this->compatGet(Compat::db($args, $name, $this->boundDb()));
            case 'getsAll':
                $this->colMode('all');
                return $this->compatGets(Compat::db($args, $name, $this->boundDb()));
            case 'getCount':
                Compat::db($args, $name, $this->boundDb()); return $this->count();
            case 'getsCount':
                return $this->compatGetsCount(Compat::db($args, $name, $this->boundDb()));
            case 'create':
                Compat::db($args, $name, $this->boundDb()); return $this->insert();
            case 'relation':
            case 'oneToOne':
                return $this->compatRelation($args[0] ?? null, false, null, null, $name);
            case 'relations':
            case 'oneToMany':
                return $this->compatRelation($args[0] ?? null, true, null, null, $name);
            case 'match':
                if (!isset($args[0], $args[1]) || !is_string($args[0]) || !is_string($args[1])) {
                    throw new OrmException(Code::IR_INVALID, 'match(left, right) takes two column names');
                }
                $this->compatMatch(Names::snake($args[0]), Names::snake($args[1]), null);
                return $this;
            case 'alias':
                $this->cAlias = Names::snake((string) ($args[0] ?? throw new OrmException(Code::IR_INVALID, 'alias(name) needs a name')));
                return $this;
            case 'keyName':
                $k = $args[0] ?? null;
                if ($k instanceof \Closure) {
                    return $this->keyByFn($k);
                }
                if (is_callable($k) && !is_string($k)) {
                    return $this->keyByFn(\Closure::fromCallable($k));
                }
                if (!is_string($k) || !isset(Registry::row(static::ENTITY)::columns()[$k])) {
                    throw new OrmException(Code::COLUMN_UNKNOWN, static::ENTITY . ': keyName(' . json_encode($k) . ') is not a column');
                }
                $this->cKeyName = $k;
                return $this;
            case 'fetchKey':
                $k = $args[0] ?? null;
                if (!is_callable($k)) {
                    throw new OrmException(Code::IR_INVALID, 'fetchKey(callable) needs a callable');
                }
                return $this->keyByFn($k instanceof \Closure ? $k : \Closure::fromCallable($k));
            case 'parentNode':
                $this->opt('flatten', true);
                return $this;
            case 'groupLimit':
                $this->opt('limit_per_parent', (int) ($args[0] ?? throw new OrmException(Code::IR_INVALID, 'groupLimit(n) needs n')));
                return $this;
            case 'deleteLock':
                if ($args[0] ?? true) {
                    $this->opt('no_cascade_delete', true);
                }
                return $this;
            case 'addColumn':
                $col = (string) ($args[0] ?? '');
                if (!isset(Registry::row(static::ENTITY)::columns()[$col])) {
                    throw new OrmException(Code::COLUMN_UNKNOWN, static::ENTITY . ": addColumn('$col') is not a column");
                }
                $alias = $args[1] ?? null;
                if ($alias instanceof \Closure || (is_callable($alias) && !is_string($alias))) {
                    throw new OrmException(Code::IR_INVALID, static::ENTITY . ": addColumn('$col', callback) computes a value after the fetch; the compat layer does not translate it — compute it on the rows");
                }
                $this->compatAddColumn($col, $alias === null ? null : (string) $alias, $args[2] ?? null, $name);
                return $this;
            case 'addColumns':
                foreach ((array) ($args[0] ?? []) as $col) {
                    $this->compatAddColumn((string) $col, null, null, $name);
                }
                return $this;
            case 'removeColumn':
                $this->colRemove((string) ($args[0] ?? ''));
                return $this;
            case 'removeColumns':
                foreach ((array) ($args[0] ?? []) as $col) {
                    $this->colRemove((string) $col);
                }
                return $this;
            case 'addAllColumns':
                $this->colMode('all');
                return $this;
            case 'removeAllColumns':
                $this->colMode('none');
                return $this;
            case 'onlyColumns':
                $this->colMode('none');
                foreach ((array) ($args[0] ?? []) as $col) {
                    $this->compatAddColumn((string) $col, null, null, $name);
                }
                return $this;
            case 'duplication':
                $this->compatDuplication($args[0] ?? null);
                return $this;
            case 'forceIndex':
                $this->opt('force_index', (string) ($args[0] ?? throw new OrmException(Code::IR_INVALID, 'forceIndex(name) needs a name')));
                return $this;
            case 'orderBy':
                $this->orderExpr(trim((string) ($args[0] ?? throw new OrmException(Code::IR_INVALID, 'orderBy(sql) needs a fragment'))), false);
                return $this;
        }
        throw new \BadMethodCallException(static::class . "::$name");
    }

    private function compatAddColumn(string $col, ?string $as, mixed $format, string $name): void
    {
        if (!isset(Registry::row(static::ENTITY)::columns()[$col])) {
            throw new OrmException(Code::COLUMN_UNKNOWN, static::ENTITY . ": $name: $col is not a column");
        }
        if ($as === null) {
            $this->colAdd($col);
        } elseif ($format === null) {
            $this->colAs($as, $col);
        } else {
            $this->colExpr($as, sprintf((string) $format, "`$col`"));
        }
    }

    /** matchAWithB: (parent column, child column); $keep === false drops the child's match column. Public: the parent calls it on the child. */
    public function compatMatch(string $left, string $right, mixed $keep): void
    {
        $this->cMatch = [$left, $right];
        if ($keep === false) {
            $this->cDropKey = true;
        }
    }

    /** What a child chain declared for its attachment: match pair, alias, drop-key flag, key column. */
    public function compatLink(): array
    {
        return [$this->cMatch, $this->cAlias, $this->cDropKey, $this->cKeyName];
    }

    private function compatRelation(mixed $child, bool $many, ?string $left, ?string $right, string $name): static
    {
        if (!$child instanceof Q || !method_exists($child, 'compatLink')) {
            throw new OrmException(Code::IR_INVALID, static::ENTITY . ": $name(new Y …) expects a generated query");
        }
        if ($left !== null) {
            $child->compatMatch($left, $right, null);
        }
        [$match, $alias, $drop, $key] = $child->compatLink();
        $rel = Compat::resolveRelation(static::ENTITY, $child::ENTITY, $match, $alias, $many ? 'many' : 'one');
        if ($many && $key !== null) {
            $child->opt('key_by', $key);
        }
        if ($drop && $match !== null && $match[1] !== Registry::row($child::ENTITY)::pk()) {
            $child->opt('drop_child_key', true);
        }
        $this->attachRelation($rel, $child);
        return $this;
    }

    private function compatJoin(mixed $child, mixed $target, bool $leftJoin, string $left, string $right, string $name): static
    {
        if (!$child instanceof Q || !method_exists($child, 'compatLink')) {
            throw new OrmException(Code::IR_INVALID, static::ENTITY . ": $name(new Y …) expects a generated query");
        }
        if ($target !== null) {
            throw new OrmException(Code::IR_INVALID, static::ENTITY . ": $name(child, target) joins off another joined model; nest the join inside that child's chain instead (docs/dsl.md §2.4)");
        }
        [, $alias] = $child->compatLink();
        $rel = Compat::resolveRelation(static::ENTITY, $child::ENTITY, [$left, $right], $alias, null);
        $this->attachJoin($rel, $leftJoin ? 'left' : 'inner', $child);
        return $this;
    }

    /** duplication(model) copies the model's set/plus/minus/expr assignments into ON DUPLICATE KEY UPDATE; duplication([col => v]) assigns values. */
    private function compatDuplication(mixed $dup): void
    {
        if (is_array($dup)) {
            $cols = Registry::row(static::ENTITY)::columns();
            foreach ($dup as $col => $v) {
                if (!isset($cols[$col])) {
                    throw new OrmException(Code::COLUMN_UNKNOWN, static::ENTITY . ": duplication: $col is not a column");
                }
                $this->onDuplicate((string) $col, $v);
            }
            return;
        }
        if (!$dup instanceof Q) {
            throw new OrmException(Code::IR_INVALID, static::ENTITY . ': duplication(new X …) expects a query with set*/plus*/minus* calls, or [column => value]');
        }
        $params = $dup->req->params;
        foreach ($dup->req->ir['set'] ?? [] as $a) {
            $col = $a['column'];
            if (isset($a['null'])) {
                $this->onDuplicate($col, null);
            } elseif (isset($a['plus_p'])) {
                $this->onDuplicatePlus($col, $params[$a['plus_p']]);
            } elseif (isset($a['minus_p'])) {
                $this->onDuplicateMinus($col, $params[$a['minus_p']]);
            } elseif (isset($a['expr'])) {
                $this->onDuplicateExpr($col, $a['expr'], array_map(fn(int $i) => $params[$i], $a['ps']));
            } else {
                $this->onDuplicate($col, $params[$a['p']]);
            }
        }
    }

    /** keyName<Col> on a root chain keys the collection on the client (key_by is a relation-child option in the IR). */
    private function compatRootKey(): void
    {
        if ($this->cKeyName !== null) {
            $col = $this->cKeyName;
            $this->cKeyName = null;
            $this->keyByFn(fn(Row $r) => $r[$col]);
        }
    }

    private function compatGet(Db $db): ?Row
    {
        $this->compatRootKey();
        return $this->one();
    }

    /** Compatibility gets() is null when nothing matched; canonical gets() is an empty collection. */
    private function compatGets(Db $db): ?Collection
    {
        $this->compatRootKey();
        $c = $this->all();
        return count($c) > 0 ? $c : null;
    }

    /** Compatibility getsCount(): grouped rows with row_count, keyed by keyName when supplied. */
    private function compatGetsCount(Db $db): Collection
    {
        if (empty($this->req->ir['group_by']) && empty($this->req->ir['group_by_expr'])) {
            throw new OrmException(Code::IR_INVALID, static::ENTITY . ': getsCount() needs groupBy()');
        }
        $this->compatRootKey();
        return Collection::fromRows($this->runQuery($db, 'group_count'), Registry::row(static::ENTITY), $this->keyFn);
    }
}
