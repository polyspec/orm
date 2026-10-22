<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\Orm\Dbspec\CatalogRows;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\DocumentSet;
use Polyspec\Orm\Dbspec\Renderer;

/** AES key version status and rotation. */
final class AesUtils
{
    public function __construct(private readonly Db $db, private readonly Utils $u)
    {
    }

    /**
     * @return array{table: string, keys: list<string>, version: string,
     *     columns: list<array{name: string, styles: list<string>}>}
     */
    private function spec(Model $model): array
    {
        $this->db->unsupportedOnMarkdown('aes rotation');
        $meta = $model::meta();
        $columns = [];
        foreach ($meta['columns'] as $name => $col) {
            if (RuntimeModel::encrypted($col)) {
                $columns[] = ['name' => $name, 'styles' => array_values(array_filter(
                    $col['codec'],
                    static fn(string $s): bool => $s === 'aes' || $s === 'hex'
                ))];
            }
        }
        if ($meta['aes_version'] === '' || $columns === []) {
            throw new OrmException(Code::CONFIG, "entity {$meta['entity']} has no AES columns with a key version");
        }
        return ['table' => $meta['table'], 'keys' => $meta['pk'], 'version' => $meta['aes_version'],
            'columns' => $columns];
    }

    private function q(string $name): string
    {
        return $this->db->driver() === 'mysql' ? "`$name`" : "\"$name\"";
    }

    public function status(Model $model, AesKeyring $keyring): AesRotationStatus
    {
        $spec = $this->spec($model);
        $version = $this->q($spec['version']);
        $rows = $this->db->fetch(
            StatementEvent::UTILITY,
            [$spec['table']],
            $this->db->transactionNumber(),
            "SELECT $version, COUNT(*) FROM {$this->q($spec['table'])} GROUP BY $version ORDER BY $version"
        );
        $versions = [];
        $total = 0;
        $pending = 0;
        foreach ($rows as [$stored, $count]) {
            $stored = (int) $stored;
            $count = (int) $count;
            $versions[$stored] = $count;
            $total += $count;
            if ($stored !== $keyring->currentVersion) {
                $pending += $count;
            }
        }
        return new AesRotationStatus($keyring->currentVersion, $total, $pending, $versions);
    }

    /** Re-encrypts every row that is not at the current key version, in one transaction. */
    public function rotate(Model $model, AesKeyring $keyring): int
    {
        $spec = $this->spec($model);
        $pg = $this->db->driver() === 'postgres';
        // PostgreSQL uses $n placeholders. For pdo_pgsql, they are sent as ?.
        $ph = static fn(int $n): string => $pg ? '$' . $n : '?';
        $columns = array_merge(
            array_map($this->q(...), $spec['keys']),
            [$this->q($spec['version'])],
            array_map(fn(array $c): string => $this->q($c['name']), $spec['columns'])
        );
        $keyCount = count($spec['keys']);
        $select = 'SELECT ' . implode(', ', $columns)
            . " FROM {$this->q($spec['table'])} WHERE {$this->q($spec['version'])} <> {$ph(1)} ORDER BY "
            . implode(', ', array_slice($columns, 0, $keyCount)) . ' LIMIT 1000';
        $sets = [];
        foreach ($spec['columns'] as $i => $c) {
            $sets[] = $this->q($c['name']) . ' = ' . $ph($i + 1);
        }
        $sets[] = $this->q($spec['version']) . ' = ' . $ph(count($spec['columns']) + 1);
        $where = [];
        foreach ($spec['keys'] as $i => $k) {
            $where[] = $this->q($k) . ' = ' . $ph(count($spec['columns']) + 2 + $i);
        }
        $where[] = $this->q($spec['version']) . ' = ' . $ph(count($spec['columns']) + 2 + $keyCount);
        $update = "UPDATE {$this->q($spec['table'])} SET " . implode(', ', $sets)
            . ' WHERE ' . implode(' AND ', $where);
        return $this->u->run(function () use ($select, $update, $spec, $keyring, $keyCount, $pg): int {
            $db = $this->db;
            $tx = $db->transactionNumber();
            $tables = [$spec['table']];
            $rotated = 0;
            try {
                $up = $db->pdo()->prepare($pg ? preg_replace('/\$\d+/', '?', $update) : $update);
            } catch (\PDOException $e) {
                throw $db->driverError($e);
            }
            while (true) {
                $batch = $db->fetch(StatementEvent::UTILITY, $tables, $tx, $select, [$keyring->currentVersion]);
                if ($batch === []) {
                    return $rotated;
                }
                foreach ($batch as $values) {
                    $row = [];
                    foreach ($spec['keys'] as $i => $k) {
                        $row[$k] = $values[$i];
                    }
                    // The stored version is passed through unread: rotateRow reads it only for a non-NULL AES value
                    // (COD-44).
                    $version = $values[$keyCount];
                    $row[$spec['version']] = $version;
                    foreach ($spec['columns'] as $i => $c) {
                        $row[$c['name']] = $values[$keyCount + 1 + $i];
                    }
                    $after = $keyring->rotateRow($row, $spec['version'], $spec['columns'], $keyring->currentVersion);
                    $args = [];
                    foreach ($spec['columns'] as $c) {
                        $args[] = $after[$c['name']];
                    }
                    $args[] = $keyring->currentVersion;
                    foreach ($spec['keys'] as $k) {
                        $args[] = $row[$k];
                    }
                    $args[] = $version;
                    $changed = $db->observed(
                        StatementEvent::UTILITY,
                        $tables,
                        $tx,
                        $update,
                        $args,
                        static function () use ($up, $args): int {
                            foreach ($args as $i => $v) {
                                match (true) {
                                    $v instanceof Bytes => $up->bindValue($i + 1, $v->bytes, \PDO::PARAM_LOB),
                                    $v === null => $up->bindValue($i + 1, null, \PDO::PARAM_NULL),
                                    is_int($v) => $up->bindValue($i + 1, $v, \PDO::PARAM_INT),
                                    default => $up->bindValue($i + 1, (string) $v, \PDO::PARAM_STR),
                                };
                            }
                            $up->execute();
                            return $up->rowCount();
                        }
                    );
                    if ($changed !== 1) {
                        throw Orm::transactionConflict("aes rotation of {$spec['table']} changed $changed rows");
                    }
                    $rotated++;
                }
            }
        });
    }
}
