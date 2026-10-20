<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * @internal rewrites a request so that its plan does not depend on the length of an IN list (T169-3, the Go
 * canonicalize of packages/go/orm/canonical.go): an IN list pads to a power of two by repeating its last value,
 * every parameter reference gets a slot of its own in walk order, and a parameter no reference names follows the
 * slots. Map keys are walked in sorted order, so the numbering is the same on every run.
 */
final class CanonicalRequest
{
    /** @var list<mixed> the canonical parameters */
    private array $out = [];
    /** @var array<int, bool> */
    private array $used = [];

    /** @param list<mixed> $params */
    private function __construct(private readonly array $params)
    {
    }

    /** @return array{0: array, 1: list<mixed>} the canonical IR and parameters */
    public static function of(array $ir, array $params): array
    {
        $c = new self($params);
        $canonical = $c->node($ir);
        foreach ($params as $i => $value) {
            if (!isset($c->used[$i])) {
                $c->out[] = $value;
            }
        }
        return [$canonical, $c->out];
    }

    private function index(int $p): int
    {
        if ($p < 0 || $p >= count($this->params)) {
            throw new OrmException(Code::IR_INVALID, "param index $p out of range (n_params "
                . count($this->params) . ')');
        }
        $this->used[$p] = true;
        $this->out[] = $this->params[$p];
        return count($this->out) - 1;
    }

    private function node(mixed $v): mixed
    {
        if (!is_array($v)) {
            return $v;
        }
        if (array_is_list($v)) {
            return array_map(fn(mixed $x): mixed => $this->node($x), $v);
        }
        $in = isset($v['op']) && ($v['op'] === 'in' || $v['op'] === 'not_in') && !isset($v['sub']);
        $keys = array_keys($v);
        sort($keys);
        foreach ($keys as $k) {
            $x = $v[$k];
            if (($k === 'p' || $k === 'plus_p' || $k === 'minus_p') && is_int($x)) {
                $v[$k] = $this->index($x);
            } elseif ($k === 'ps' && is_array($x)) {
                $v[$k] = $in ? $this->list($x) : $this->ints($x);
            } elseif ($k === 'rows' && is_array($x)) {
                $v[$k] = array_map(fn(mixed $row): array => $this->ints((array) $row), $x);
            } else {
                $v[$k] = $this->node($x);
            }
        }
        return $v;
    }

    /** @param array<mixed> $ps */
    private function ints(array $ps): array
    {
        return array_map(fn(mixed $p): int => $this->index((int) $p), array_values($ps));
    }

    /** Pads an IN list to its bucket: the slots past the last value repeat it. @param array<mixed> $ps */
    private function list(array $ps): array
    {
        $ps = array_values($ps);
        $n = count($ps);
        if ($n === 0) {
            return [];
        }
        $bucket = 1;
        while ($bucket < $n) {
            $bucket <<= 1;
        }
        $out = [];
        for ($j = 0; $j < $bucket; $j++) {
            $out[] = $this->index((int) $ps[min($j, $n - 1)]);
        }
        return $out;
    }
}
