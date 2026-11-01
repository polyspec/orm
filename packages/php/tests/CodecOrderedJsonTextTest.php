<?php

// A text that is not a sequence of Unicode scalar values is no JSON text (RFC 8259, 8.1), so an ordered_json stage
// returns CODEC_ENCODE for it (COD-64); a recipe text is a JSON string, which holds Unicode only, so each client tests
// this.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Codec;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StyledValue;

#[Small]
class CodecOrderedJsonTextTest extends TestCase
{
    // Requirements: COD-64 (docs/spec).
    public function testOrderedJsonRefusesATextThatIsNotUnicode(): void
    {
        try {
            Codec::encode(['ordered_json'], StyledValue::value("\xFF"));
            self::fail('a text that is not UTF-8 must be CODEC_ENCODE');
        } catch (OrmException $e) {
            self::assertSame(Code::CODEC_ENCODE, $e->code_);
        }
    }
}
