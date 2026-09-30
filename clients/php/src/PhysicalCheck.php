<?php
declare(strict_types=1);
namespace Orm;

/** Structural constraint interchange, not SQL execution permission. */
final readonly class PhysicalCheck
{
    private function __construct(private array $record) {}

    public static function fromValue(mixed $value): self
    {
        $record = PhysicalRecord::shape($value, ['id', 'name', 'tableId', 'expressionSql', 'enforced', 'validated', 'comment', 'options']);
        $validator = new PhysicalRecord();
        $validator->id($record['id']);
        $validator->id($record['tableId']);
        if ($record['name'] !== null) {
            $name = $validator->text($record['name'], 1, 1024);
            new PhysicalIdentity(null, null, $name, null);
        }
        $validator->text($record['expressionSql'], 1, 16384);
        foreach (['enforced', 'validated'] as $field) {
            if ($record[$field] !== null && !is_bool($record[$field])) {
                throw new \InvalidArgumentException('SCHEMA_INVALID');
            }
        }
        $validator->text($record['comment'], 0, 8192);
        $validator->options($record['options']);
        return new self(PhysicalRecord::detached($record));
    }

    public function value(): array
    {
        return $this->record;
    }
}
