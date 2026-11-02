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
use Polyspec\Orm\Tests\Model\Author;

#[Small]
class AesVersionCodesTest extends TestCase
{
    // Requirements: INT-88, INT-89.
    public function testTerminalReturnsTheFirstRecordedBuilderError(): void
    {
        $model = new Author();
        $model->limit(-1, 1)->limit(0, 0);
        try {
            $model->getCount();
            self::fail('the terminal must return the recorded builder error');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame(
                'CONFIG: limit requires a non-negative offset and a positive count',
                $error->getMessage()
            );
        }
    }

    // Requirements: INT-74, INT-130.
    public function testKeyringExposesCurrentVersionAndSortedVersions(): void
    {
        $keyring = new AesKeyring([3 => 'third', 1 => 'first', 2 => 'second'], 2);
        self::assertSame(2, $keyring->currentVersion);
        self::assertSame([1, 2, 3], $keyring->versions());
    }

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
