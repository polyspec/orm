<?php

// The PHP error chain of the codec and of Model's value conversion: an expected failure keeps the parser's exception
// as its previous exception, and an unexpected throwable passes through by identity. The codec cases that every client
// shares are the codec recipe, tests/codec/codec.json (CodecRecipeTest).
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StyledValue;

#[Small]
class CodecErrorCauseTest extends TestCase
{
    private static function throwingJsonValue(\Throwable $failure): \JsonSerializable
    {
        return new class ($failure) implements \JsonSerializable {
            public function __construct(private readonly \Throwable $failure)
            {
            }

            public function jsonSerialize(): mixed
            {
                throw $this->failure;
            }
        };
    }

    // Requirements: COD-33, COD-35 (docs/spec).
    public function testCodecExpectedExceptionCause(): void
    {
        $cases = [
            'YAML parser syntax' => [
                fn() => Codec::decode(['yaml'], 'value: ['),
                Code::CODEC_DECODE,
            ],
            'YAML undefined alias' => [
                fn() => Codec::decode(['yaml'], "value: *missing\n"),
                Code::CODEC_DECODE,
            ],
            'YAML codec policy' => [
                fn() => Codec::decode(['yaml'], "value: &x 1\nother: *x\n"),
                Code::CODEC_DECODE,
            ],
            'YAML encode policy' => [
                fn() => Codec::encode(['yaml'], StyledValue::value(new \stdClass())),
                Code::CODEC_ENCODE,
            ],
            'ordered JSON parser' => [fn() => Codec::decode(['ordered_json'], '{'), Code::CODEC_DECODE],
            'JSON encoder' => [fn() => Codec::encode(['ordered_json'], StyledValue::value("\xFF")), Code::CODEC_ENCODE],
        ];
        foreach ($cases as $name => [$operation, $code]) {
            try {
                $operation();
                self::fail("$name: expected codec failure");
            } catch (OrmException $exception) {
                self::assertSame($code, $exception->code_, $name);
                self::assertInstanceOf(\Throwable::class, $exception->getPrevious(), $name);
                self::assertStringContainsString(
                    $exception->getPrevious()->getMessage(),
                    $exception->getMessage(),
                    $name
                );
            }
        }

        $cause = new \InvalidArgumentException('sentinel expected parser exception');
        try {
            Codec::encode(['ordered_json'], StyledValue::value(self::throwingJsonValue($cause)));
            self::fail('expected sentinel codec failure');
        } catch (OrmException $exception) {
            self::assertSame(Code::CODEC_ENCODE, $exception->code_);
            self::assertSame($cause, $exception->getPrevious());
        }
    }

    public function testCodecUnexpectedThrowableIdentity(): void
    {
        $causes = [
            new \RuntimeException('runtime sentinel'),
            new \TypeError('type sentinel'),
            new \Error('error sentinel'),
        ];
        foreach ($causes as $cause) {
            try {
                Codec::encode(['ordered_json'], StyledValue::value(self::throwingJsonValue($cause)));
                self::fail('expected the sentinel throwable');
            } catch (\Throwable $exception) {
                self::assertSame($cause, $exception);
            }
        }
    }

    public function testModelDateErrorKeepsItsNativeCause(): void
    {
        $timeValue = new \ReflectionMethod(Model::class, 'timeValue');
        try {
            $timeValue->invoke(null, '2026-13-40 12:00:00+99:99', new \DateTimeZone('UTC'));
            self::fail('an invalid offset date was accepted');
        } catch (\ReflectionException $error) {
            throw $error;
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: invalid date value 2026-13-40 12:00:00+99:99', $error->getMessage());
            self::assertInstanceOf(\Exception::class, $error->getPrevious());
        }
    }

    public function testModelJsonErrorKeepsItsNativeCause(): void
    {
        try {
            Model::jsonText("\xFF");
            self::fail('invalid UTF-8 JSON text was encoded');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_ENCODE, $error->code_);
            self::assertStringStartsWith('CODEC_ENCODE: json: ', $error->getMessage());
            self::assertInstanceOf(\JsonException::class, $error->getPrevious());
            self::assertSame(JSON_ERROR_UTF8, $error->getPrevious()->getCode());
        }
    }
}
