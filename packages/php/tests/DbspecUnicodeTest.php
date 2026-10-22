<?php

declare(strict_types=1);

// Checks that the PHP UnicodeWord table (the table the tests/dbspec/unicode generator wrote from Go's Unicode data)
// matches its ranges at every code point. Go's ranges are checked against Go by that generator's test.

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\UnicodeWord;

#[Small]
final class DbspecUnicodeTest extends TestCase
{
    private const LAST_CODE_POINT = 0x10FFFF;

    public function test_every_code_point(): void
    {
        // listed[cp] is '1' if cp falls in one range of the table.
        $listed = str_repeat('0', self::LAST_CODE_POINT + 1);
        foreach (UnicodeWord::RANGES as [$lo, $hi]) {
            $listed = substr_replace($listed, str_repeat('1', $hi - $lo + 1), $lo, $hi - $lo + 1);
        }
        $disagree = [];
        for ($cp = 0; $cp <= self::LAST_CODE_POINT; $cp++) {
            if (UnicodeWord::contains($cp) !== ($listed[$cp] === '1')) {
                $disagree[] = sprintf('U+%04X', $cp);
                if (count($disagree) === 10) {
                    break;
                }
            }
        }
        $this->assertSame(
            [],
            $disagree,
            'UnicodeWord::contains differs from its ranges; run go run ./tests/dbspec/unicode -write'
        );
    }
}
