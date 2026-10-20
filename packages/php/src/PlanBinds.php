<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal the bind slots of one statement */
final class PlanBinds
{
    /** @var list<array> */
    public array $slots = [];
    public int $subs = 0;
    /** @var array<string, true> Tables that the statement used, by name */
    private array $tables = [];

    public function __construct(private readonly Dialect $d)
    {
    }

    /** Quotes the entity's table name and records it as a table of the statement. */
    public function table(array $ent): string
    {
        $this->tables[$ent['table']] = true;
        return $this->d->quote($ent['table']);
    }

    /** @return list<string> The tables the statement wrote, sorted */
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

    /** Adds a slot with a type. A slot without a type is a planner error. */
    private function typed(array $slot): string
    {
        if (($slot['col_type'] ?? '') === '') {
            throw new OrmException(Code::IR_INVALID,
                sprintf('bind slot %d (%s) has no declared type', count($this->slots), $slot['from']));
        }
        return $this->add($slot);
    }

    /**
     * The placeholder of request value Params[$i], compared with or assigned to column $col. $type is the
     * dbspec type of that value.
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
     * The placeholder of value Params[$i] compared with or assigned to column $col. The type is the type of $col, and
     * it carries the decimal's precision and scale, the datetime's precision, and the varchar's length.
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

    /** An executor setting value. $type is the type of the column that uses the value. */
    public function config(string $name, string $type): string
    {
        return $this->typed(['from' => 'config', 'param' => 0, 'name' => $name, 'col_type' => $type]);
    }

    /**
     * The executor's UTC time. A statement reads the clock once and truncates it at microsecond
     * precision. The time written to a column uses the column's fractional digits; for comparison
     * values use six digits.
     */
    public function now(int $precision): string
    {
        return $this->typed(['from' => 'now', 'param' => 0, 'precision' => $precision, 'col_type' => 'datetime']);
    }

    /**
     * The key of the transaction's audit record. name is the audit record table; the executor
     * checks that the audit is a row of that table. type is the type of the audit column.
     */
    public function audit(array $ent): string
    {
        return $this->typed(['from' => 'audit', 'param' => 0, 'name' => $ent['audit_record'],
            'col_type' => RuntimeModel::column($ent, $ent['audit'])['type']]);
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
