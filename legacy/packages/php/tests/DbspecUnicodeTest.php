<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Checks that the PHP UnicodeWord table (the table the tests/dbspec/unicode generator wrote from Go's Unicode data)
// matches its ranges at every code point, and that the parser, which reads an ASCII byte without the table as Go's
// isWordRune does, takes the word bytes the table holds. Go's ranges are checked against Go by that generator's test.

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Parser;
use Polyspec\Orm\Dbspec\UnicodeWord;

#[Small]
final class DbspecUnicodeTest extends TestCase
{
    private const LAST_CODE_POINT = 0x10FFFF;

    public function testEveryCodePoint(): void
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

    public function testEveryAsciiByte(): void
    {
        $disagree = [];
        for ($b = 0; $b < 0x80; $b++) {
            $c = chr($b);
            if (Parser::isWord($c) !== ($c === '_' || $c === '.' || UnicodeWord::contains($b))) {
                $disagree[] = sprintf('U+%04X', $b);
            }
        }
        $this->assertSame([], $disagree, 'the ASCII word bytes of Parser differ from the UnicodeWord table');
    }
}
