<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Go;
use Polyspec\Orm\GoMap;

#[Small]
final class GoSerializationTest extends TestCase
{
    // Requirements: INT-144.
    public function testGoTextMatchesGoFormatVectors(): void
    {
        $map = new GoMap(['z' => 1, 'a' => ['x' => true]]);
        self::assertSame(['z' => 1, 'a' => ['x' => true]], $map->items);
        $map->items['b'] = null;
        self::assertSame('{"a":{"x":true},"b":null,"z":1}', Go::json($map));
        self::assertSame('{"-1":"negative","z":1}', Go::json([-1 => 'negative', 'z' => 1]));

        self::assertSame(
            '"\\a\\b\\f\\n\\r\\t\\v\\x00\\x7f\\\\\\"é\\u200b"',
            Go::quote("\x07\x08\x0c\n\r\t\x0b\x00\x7f\\\"é\u{200b}"),
        );
        self::assertSame(
            "{\n  \"z\": [\n    1,\n    \"\\u003c\\u003e\\u0026\"\n  ],\n  \"a\": true\n}",
            Go::json(['z' => [1, '<>&'], 'a' => true], '  '),
        );
        self::assertSame('{"x":"\\ufffd"}', Go::json(['x' => "\xff"]));

        try {
            Go::json(1.5);
            self::fail('floating-point values are unsupported by Go::json');
        } catch (\InvalidArgumentException $error) {
            self::assertSame('unsupported JSON value float', $error->getMessage());
        }
    }
}
