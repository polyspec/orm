<?php
declare(strict_types=1);

namespace Orm;

final readonly class AesRotationStatus
{
    /** @param array<int, int> $versions */
    public function __construct(public int $current, public int $total, public int $pending, public array $versions) {}
}

/** Versioned AES keys and row-level all-column rotation. */
final class AesKeyring
{
    /** @var array<int, string> */
    private array $keys;

    /** @param array<int, string> $keys */
    public function __construct(array $keys, public readonly int $currentVersion)
    {
        foreach ($keys as $version => $key) {
            if (!is_int($version) || $version < 1 || !is_string($key) || $key === '') {
                throw new OrmException(Code::CONFIG, "AES version $version has no key");
            }
        }
        if ($currentVersion < 1 || !isset($keys[$currentVersion])) {
            throw new OrmException(Code::CONFIG, "AES version $currentVersion is not declared");
        }
        $this->keys = $keys;
    }

    /** @return list<int> */
    public function versions(): array
    {
        $versions = array_keys($this->keys);
        sort($versions, SORT_NUMERIC);
        return $versions;
    }

    /**
     * Returns a copy after every AES column succeeds. The database caller
     * must persist the returned columns and version in one transaction.
     * @param array<string, mixed> $row
     * @param list<array{name: string, styles: list<string>}> $columns
     * @return array<string, mixed>
     */
    public function rotateRow(array $row, string $versionColumn, array $columns, int $targetVersion): array
    {
        $oldVersion = $row[$versionColumn] ?? null;
        if (!is_int($oldVersion)) {
            throw new OrmException(Code::CODEC_DECODE, 'AES row version must be an integer');
        }
        $oldKey = $this->keys[$oldVersion] ?? throw new OrmException(Code::CONFIG, "AES version $oldVersion is not declared");
        $newKey = $this->keys[$targetVersion] ?? throw new OrmException(Code::CONFIG, "AES version $targetVersion is not declared");
        $out = $row;
        foreach ($columns as $column) {
            if (!array_key_exists($column['name'], $row)) {
                throw new OrmException(Code::CODEC_DECODE, "AES column {$column['name']} is missing");
            }
            $plain = Codec::hostDecode($row[$column['name']], $column['styles'], $oldKey);
            $out[$column['name']] = Codec::hostEncode($plain, $column['styles'], $newKey);
        }
        $out[$versionColumn] = $targetVersion;
        return $out;
    }
}
