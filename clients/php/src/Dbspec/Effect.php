<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * How a step's statement shows that it took effect (docs/plans.md "Steps",
 * effects). The kind is table, column, index, constraint, trigger, function,
 * sequence, rows or repeat; `present` is the state after the statement.
 */
final readonly class Effect
{
    public function __construct(public string $kind, public string $table, public string $name, public bool $present)
    {
    }

    public static function repeat(): self
    {
        return new self('repeat', '', '', true);
    }

    /** The text form of docs/plans.md "Effects", such as `present table users`. */
    public function text(): string
    {
        if ($this->kind === 'repeat') {
            return 'repeat';
        }
        $s = ($this->present ? 'present' : 'absent') . ' ' . $this->kind;
        foreach ([$this->table, $this->name] as $n) {
            if ($n !== '') {
                $s .= " $n";
            }
        }
        return $s;
    }
}
