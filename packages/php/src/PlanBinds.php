<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal the bind slots of one statement */
final class PlanBinds
{
    /** @var list<array> */
    public array $slots = [];
    public int $subs = 0;
    /** @var array<string, true> statement가 이름으로 쓴 table */
    private array $tables = [];

    public function __construct(private readonly Dialect $d) {}

    /** ent의 table 이름을 quote하고 statement의 table로 기록한다. */
    public function table(array $ent): string
    {
        $this->tables[$ent['table']] = true;
        return $this->d->quote($ent['table']);
    }

    /** @return list<string> statement가 쓴 table, 정렬한 것 */
    public function tables(): array
    {
        $out = array_map('strval', array_keys($this->tables));
        sort($out, SORT_STRING);
        return $out;
    }

    private function add(array $slot): string
    {
        $this->slots[] = $slot;
        return $this->d->placeholder(count($this->slots));
    }

    /** type 있는 slot을 더한다. type 없는 slot은 planner 오류다. */
    private function typed(array $slot): string
    {
        if (($slot['col_type'] ?? '') === '') {
            throw new OrmException(Code::IR_INVALID, sprintf('bind slot %d (%s) has no declared type', count($this->slots), $slot['from']));
        }
        return $this->add($slot);
    }

    /**
     * request 값 Params[$i]의 placeholder다. $type은 그 값의 dbspec type이다.
     *
     * @param list<string> $hostStyles
     */
    public function param(int $i, string $type, string $transform = '', array $hostStyles = []): string
    {
        $slot = ['from' => 'param', 'param' => $i];
        if ($transform !== '') {
            $slot['transform'] = $transform;
        }
        if ($hostStyles !== []) {
            $slot['host_styles'] = $hostStyles;
        }
        $slot['col_type'] = $type;
        // A datetime or time compared with a function's argument or result is text of six fraction digits.
        if ($type === 'datetime' || $type === 'time') {
            $slot['precision'] = 6;
        }
        return $this->typed($slot);
    }

    /**
     * column $col과 비교하거나 $col에 할당하는 값 Params[$i]의 placeholder다. type은 $col의 type이고
     * decimal의 precision과 scale, datetime의 precision, varchar의 length를 싣는다.
     *
     * @param list<string> $hostStyles
     */
    public function colParam(int $i, array $col, string $transform = '', array $hostStyles = []): string
    {
        $slot = ['from' => 'param', 'param' => $i];
        if ($transform !== '') {
            $slot['transform'] = $transform;
        }
        if ($hostStyles !== []) {
            $slot['host_styles'] = $hostStyles;
        }
        $slot['col_type'] = $col['type'];
        if ($col['type'] === 'decimal') {
            $slot['precision'] = $col['precision'];
            $slot['scale'] = $col['scale'];
        } elseif ($col['type'] === 'datetime' || $col['type'] === 'time') {
            $slot['precision'] = $col['precision'];
        } elseif ($col['type'] === 'varchar') {
            $slot['length'] = $col['length'];
        }
        return $this->typed($slot);
    }

    /** Plaintext the executor hashes with the blind-index key; $type is the index column's type. */
    public function blindIndex(int $i, string $type): string
    {
        return $this->param($i, $type, '', ['blind_index']);
    }

    /** executor 설정 값이다. $type은 그 값을 쓰는 column의 type이다. */
    public function config(string $name, string $type): string
    {
        return $this->typed(['from' => 'config', 'param' => 0, 'name' => $name, 'col_type' => $type]);
    }

    /**
     * executor의 UTC 시각이다. 한 statement는 clock을 한 번 읽고 microsecond에서
     * precision 자리로 자른다. column에 쓰는 시각은 column의 소수 자리를, 비교
     * 값은 여섯 자리를 쓴다.
     */
    public function now(int $precision): string
    {
        return $this->typed(['from' => 'now', 'param' => 0, 'precision' => $precision, 'col_type' => 'datetime']);
    }

    /**
     * transaction의 audit 기록 key다. name은 audit 기록 table이며, executor는 transaction의
     * audit이 그 table의 행인지 확인한다. type은 audit column의 type이다.
     */
    public function audit(array $ent): string
    {
        return $this->typed(['from' => 'audit', 'param' => 0, 'name' => $ent['audit_record'], 'col_type' => RuntimeModel::column($ent, $ent['audit'])['type']]);
    }

    /**
     * The one placeholder the executor expands to the parent key values.
     *
     * @param list<string> $keyTypes the types of the compared key columns, in key order
     */
    public function parent(int $step, array $keyTypes): string
    {
        $slot = ['from' => 'parent', 'param' => 0];
        if ($step !== 0) {
            $slot['step'] = $step;
        }
        $slot['key_types'] = $keyTypes;
        return $this->add($slot);
    }
}
