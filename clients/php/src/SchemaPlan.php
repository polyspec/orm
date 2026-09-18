<?php
declare(strict_types=1);

namespace Orm;

/**
 * The migration plan file of `ormgen plan`: the forward and rollback
 * statements between two manifests with their checksums, as reviewed JSON.
 */
final class SchemaPlan
{
    /** The plan file text, with a trailing newline. */
    public static function render(array $from, array $to, string $dialect, string $id, string $name): string
    {
        try {
            $sql = SchemaDiff::render($from, $to, $dialect, true);
        } catch (\RuntimeException $e) {
            throw new \RuntimeException('MIGRATION_PLAN: ' . $e->getMessage());
        }
        try {
            $rollback = SchemaDiff::render($to, $from, $dialect, true);
        } catch (\RuntimeException $e) {
            throw new \RuntimeException('MIGRATION_ROLLBACK_PLAN: ' . $e->getMessage());
        }
        $operations = self::operations($sql);
        $rollbackOperations = self::operations($rollback);
        return Go::json([
            'version' => 1,
            'migration_id' => $id,
            'name' => $name,
            'driver' => $dialect,
            'from_schema_hash' => $from['schema_hash'],
            'from_schema' => SchemaBuilder::document($from),
            'to_schema_hash' => $to['schema_hash'],
            'to_schema' => SchemaBuilder::document($to),
            'plan_checksum' => hash('sha256', self::sql($operations)),
            'operations' => $operations,
            'rollback_checksum' => hash('sha256', self::sql($rollbackOperations)),
            'rollback_operations' => $rollbackOperations,
            'rollback_data_loss_risk' => self::destructive($operations) || self::destructive($rollbackOperations),
        ], '  ') . "\n";
    }

    /**
     * One operation per statement; drops and column type changes are destructive.
     * @return list<array{sql: string, destructive: bool}>
     */
    public static function operations(string $sql): array
    {
        $out = [];
        foreach (SchemaDdl::splitSql($sql) as $statement) {
            $upper = strtoupper($statement);
            $destructive = false;
            foreach (['DROP TABLE', 'DROP COLUMN', 'MODIFY COLUMN', 'ALTER COLUMN'] as $word) {
                $destructive = $destructive || str_contains($upper, $word);
            }
            $out[] = ['sql' => $statement . ';', 'destructive' => $destructive];
        }
        return $out;
    }

    /** The statements of a plan, one per line, as the checksum reads them. */
    public static function sql(array $operations): string
    {
        $out = '';
        foreach ($operations as $operation) {
            $out .= $operation['sql'] . (str_ends_with($operation['sql'], "\n") ? '' : "\n");
        }
        return $out;
    }

    private static function destructive(array $operations): bool
    {
        foreach ($operations as $operation) {
            if ($operation['destructive']) {
                return true;
            }
        }
        return false;
    }
}
