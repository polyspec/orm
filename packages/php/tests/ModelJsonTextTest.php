<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\StyledValue;
use Polyspec\Orm\Tests\Model\Author;

use function Polyspec\OrderedJson\parse;

#[Small]
final class ModelJsonTextTest extends TestCase
{
    // Requirements: COD-16.
    public function testModelJsonTextPreservesOrderedJsonNumberText(): void
    {
        $stored = '{"z":9007199254740993,"b":1.50,"a":1e2}';
        $model = (new Author())->setJsonSetting(StyledValue::value(parse($stored)));
        self::assertSame(
            '{"json_setting":{"kind":"value","value":' . $stored . '}}',
            $model->toJson(),
        );
    }
}
