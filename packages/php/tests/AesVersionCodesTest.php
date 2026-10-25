<?php

// Requirements: COD-44.
// The codes of AES key-version failures: an undeclared key version is CONFIG, a stored version that is not a positive
// 32-bit integer is CODEC_DECODE on the read path and on the rotation path, and an AES column or version column that
// the client selected but did not get is INTERNAL.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;

#[Small]
final class AesVersionCodesTest extends TestCase
{
    private function codeOf(callable $run): string
    {
        try {
            $run();
        } catch (OrmException $error) {
            return $error->code_;
        }
        return '';
    }

    // Requirements: COD-49, COD-50, COD-51, COD-52, COD-53.
    public function testReadPathCodes(): void
    {
        $config = new Config('', '', 2, [1 => 'old-key', 2 => 'new-key']);
        $cipher = Codec::hostEncode('value', ['aes', 'hex'], 'old-key');
        $cell = [0, ['aes', 'hex'], [], true, 1];
        foreach (
            [
            ['abc', 'CODEC_DECODE'],
            [0, 'CODEC_DECODE'],
            [2147483648, 'CODEC_DECODE'],
            [9, 'CONFIG'],
            ['1', '']
            ] as [$stored, $want]
        ) {
            $rows = [[$cipher, $stored]];
            $got = $this->codeOf(function () use (&$rows, $cell, $config): void {
                Codec::decodeRows($rows, [$cell], $config);
            });
            $this->assertSame($want, $got, 'stored version ' . var_export($stored, true));
        }
    }

    // Requirements: COD-48. A selected encrypted row without its version cell is an internal invariant failure.
    public function testReadRowWithoutItsVersionCellIsInternal(): void
    {
        $config = new Config('', '', 2, [1 => 'old-key', 2 => 'new-key']);
        $rows = [[Codec::hostEncode('value', ['aes', 'hex'], 'old-key')]];
        $got = $this->codeOf(function () use (&$rows, $config): void {
            Codec::decodeRows($rows, [[0, ['aes', 'hex'], [], true, 1]], $config);
        });
        $this->assertSame('INTERNAL', $got);
    }

    // Requirements: COD-56. A read plan cannot infer a missing version column.
    public function testReadPlanWithoutVersionColumnIsInternal(): void
    {
        $config = new Config('', '', 2, [1 => 'old-key', 2 => 'new-key']);
        $rows = [[Codec::hostEncode('value', ['aes', 'hex'], 'old-key'), 1]];
        $got = $this->codeOf(function () use (&$rows, $config): void {
            Codec::decodeRows($rows, [[0, ['aes', 'hex'], [], true, null]], $config);
        });
        $this->assertSame('INTERNAL', $got);
    }

    // Requirements: COD-57. The stored-version keyring entry is required even when a single key could decrypt the value.
    public function testReadKeyringLacksStoredVersionIsConfig(): void
    {
        // The single key is new-key: a fallback to it would decrypt the value, so the CONFIG shows the keyring is used.
        $config = new Config('', 'new-key', 2, [1 => 'old-key', 2 => 'new-key']);
        $rows = [[Codec::hostEncode('value', ['aes', 'hex'], 'new-key'), 9]];
        $got = $this->codeOf(function () use (&$rows, $config): void {
            Codec::decodeRows($rows, [[0, ['aes', 'hex'], [], true, 1]], $config);
        });
        $this->assertSame('CONFIG', $got);
    }

    // Requirements: COD-58. A non-NULL encrypted value cannot use a NULL stored version.
    public function testReadNullVersionWithAesValueIsCodecDecode(): void
    {
        $config = new Config('', '', 2, [1 => 'old-key', 2 => 'new-key']);
        $rows = [[Codec::hostEncode('value', ['aes', 'hex'], 'old-key'), null]];
        $got = $this->codeOf(function () use (&$rows, $config): void {
            Codec::decodeRows($rows, [[0, ['aes', 'hex'], [], true, 1]], $config);
        });
        $this->assertSame('CODEC_DECODE', $got);
    }

    // Requirements: COD-59. A NULL encrypted value with a NULL version stays NULL without version lookup.
    public function testReadNullAesWithNullVersionStaysNull(): void
    {
        $config = new Config('', '', 2, [1 => 'old-key', 2 => 'new-key']);
        $rows = [[null, null]];
        $got = $this->codeOf(function () use (&$rows, $config): void {
            Codec::decodeRows($rows, [[0, ['aes', 'hex'], [], true, 1]], $config);
        });
        $this->assertSame('', $got);
        $this->assertNull($rows[0][0]);
    }

    // Requirements: COD-60. Rotation leaves NULL encrypted cells unchanged for either stored version.
    public function testRotationNullAesIsLeftUnchanged(): void
    {
        $keyring = new AesKeyring([1 => 'old-key', 2 => 'new-key'], 2);
        $column = ['name' => 'email', 'styles' => ['aes', 'hex']];
        foreach ([['aes_key_version' => null, 'email' => null], ['aes_key_version' => 1, 'email' => null]] as $row) {
            $this->assertSame($row, $keyring->rotateRow($row, 'aes_key_version', [$column], 2), json_encode($row));
        }
    }

    // Requirements: COD-47. Rotation uses the stored-version errors from the read path.
    public function testRotationCodes(): void
    {
        $keyring = new AesKeyring([1 => 'old-key', 2 => 'new-key'], 2);
        $column = ['name' => 'email', 'styles' => ['aes', 'hex']];
        $cipher = Codec::hostEncode('value', ['aes', 'hex'], 'old-key');
        $cases = [
            [['aes_key_version' => 0, 'email' => $cipher], 'CODEC_DECODE'],
            [['aes_key_version' => 9, 'email' => $cipher], 'CONFIG'],
            [['aes_key_version' => 1], 'INTERNAL'],
            [['email' => $cipher], 'INTERNAL'],
        ];
        foreach ($cases as [$row, $want]) {
            $got = $this->codeOf(fn () => $keyring->rotateRow($row, 'aes_key_version', [$column], 2));
            $this->assertSame($want, $got, json_encode($row));
        }
    }
}
