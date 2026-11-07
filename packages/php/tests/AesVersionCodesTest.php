<?php

// Requirements: COD-48, COD-55, COD-56.
// The codes that remain native to PHP (FCV-2): an AES column or version column that the client selected but did not
// get is INTERNAL, on the read path (COD-48, COD-56) and on the rotation path (COD-55). The other AES version codes
// are recipe cases of contracts/fixtures/aes_rotation/aes_rotation.json.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;

#[Small]
class AesVersionCodesTest extends TestCase
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

    // Requirements: COD-48. A selected encrypted row without its version cell is an internal invariant failure.
    public function testReadRowWithoutItsVersionCellIsInternal(): void
    {
        $config = new Config('', '', 2, [1 => 'old-key', 2 => 'new-key']);
        $rows = [[Codec::hostEncode('value', ['aes', 'hex'], 'old-key')]];
        $got = $this->codeOf(function () use (&$rows, $config): void {
            Codec::decodeRows($rows, [[0, ['aes', 'hex'], [], true, 1, 'user.aes_hex_email']], $config);
        });
        $this->assertSame('INTERNAL', $got);
    }

    // Requirements: COD-56. A read plan cannot infer a missing version column.
    public function testReadPlanWithoutVersionColumnIsInternal(): void
    {
        $config = new Config('', '', 2, [1 => 'old-key', 2 => 'new-key']);
        $rows = [[Codec::hostEncode('value', ['aes', 'hex'], 'old-key'), 1]];
        $got = $this->codeOf(function () use (&$rows, $config): void {
            Codec::decodeRows($rows, [[0, ['aes', 'hex'], [], true, null, 'user.aes_hex_email']], $config);
        });
        $this->assertSame('INTERNAL', $got);
    }

    // Requirements: COD-55. Rotation requires the AES column and the version column in the row.
    public function testRotationCodes(): void
    {
        $keyring = new AesKeyring([1 => 'old-key', 2 => 'new-key'], 2);
        $column = ['name' => 'email', 'styles' => ['aes', 'hex']];
        $cipher = Codec::hostEncode('value', ['aes', 'hex'], 'old-key');
        $cases = [
            [['aes_key_version' => 1], 'INTERNAL'],
            [['email' => $cipher], 'INTERNAL'],
        ];
        foreach ($cases as [$row, $want]) {
            $got = $this->codeOf(fn () => $keyring->rotateRow($row, 'aes_key_version', [$column], 2));
            $this->assertSame($want, $got, json_encode($row));
        }
    }
}
