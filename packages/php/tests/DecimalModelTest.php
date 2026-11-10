<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use ReflectionMethod;
use ReflectionNamedType;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Decimal;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;

#[Small]
class DecimalModelTest extends TestCase
{
    public function testDecimalDecodePreservesTheNormalizationFailureAsItsCause(): void
    {
        try {
            Decimal::decode('1.234', 3, 2);
            self::fail('an over-scale decimal cell must fail');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame(
                'CODEC_DECODE: decimal cell is not a decimal of its precision and scale',
                $error->getMessage()
            );
            self::assertInstanceOf(OrmException::class, $error->getPrevious());
            self::assertSame(Code::CODEC_ENCODE, $error->getPrevious()->code_);
            self::assertSame(
                'CODEC_ENCODE: decimal: fraction exceeds scale',
                $error->getPrevious()->getMessage()
            );
        }
    }

    // Requirements: DBS-112, COD-2.
    public function testGeneratedDecimalType(): void
    {
        $getter = (new ReflectionMethod(Author::class, 'getPrice'))->getReturnType();
        $setter = (new ReflectionMethod(Author::class, 'setPrice'))->getParameters()[0]->getType();
        self::assertInstanceOf(ReflectionNamedType::class, $getter);
        self::assertInstanceOf(ReflectionNamedType::class, $setter);
        self::assertSame(
            ['string', 'string'],
            [$getter->getName(), $setter->getName()],
            'generated decimal getter and setter must use nullable string'
        );
    }
}
