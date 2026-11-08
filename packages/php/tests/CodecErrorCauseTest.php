<?php

// The PHP error chain of the codec and of Model's value conversion: a failure of a library is the text of its rule and
// keeps the library's exception as its previous exception (COD-71), a rule that the codec checks itself has no previous
// exception, and a throwable of a caller's value passes through by identity. The codec cases that every client
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

    public function testCodecExpectedExceptionCause(): void
    {
        // A failure of the library of a stage is the text of its rule and keeps the library exception as its previous
        // one; a rule that the codec checks itself is its text alone (COD-70, COD-71).
        $cases = [
            'YAML parser syntax' => [
                fn() => Codec::decode(['yaml'], 'value: ['),
                'CODEC_DECODE: yaml: the stream does not parse',
                true,
            ],
            'YAML undefined alias' => [
                fn() => Codec::decode(['yaml'], "value: *missing\n"),
                'CODEC_DECODE: yaml: aliases are not supported',
                true,
            ],
            'YAML codec policy' => [
                fn() => Codec::decode(['yaml'], "value: &x 1\nother: *x\n"),
                'CODEC_DECODE: yaml: anchors are not supported',
                false,
            ],
            'YAML encode policy' => [
                fn() => Codec::encode(['yaml'], StyledValue::value(new \stdClass())),
                'CODEC_ENCODE: yaml: the value is not a codec value',
                false,
            ],
            'ordered JSON parser' => [
                fn() => Codec::decode(['ordered_json'], '{'),
                'CODEC_DECODE: json: the cell is not JSON',
                true,
            ],
            'JSON text' => [
                fn() => Codec::encode(['ordered_json'], StyledValue::value("\xFF")),
                'CODEC_ENCODE: json: the text is not a sequence of Unicode scalar values',
                false,
            ],
            'gz stream' => [
                fn() => Codec::decode(['gz'], 'not zlib'),
                'CODEC_DECODE: gz: bad zlib stream',
                true,
            ],
        ];
        foreach ($cases as $name => [$operation, $message, $library]) {
            try {
                $operation();
                self::fail("$name: expected codec failure");
            } catch (OrmException $exception) {
                self::assertSame($message, $exception->getMessage(), $name);
                if ($library) {
                    self::assertInstanceOf(\Throwable::class, $exception->getPrevious(), $name);
                } else {
                    self::assertNull($exception->getPrevious(), $name);
                }
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
            $timeValue->invoke(null, '2026-13-40 12:00:00+99:99', new \DateTimeZone('UTC'), 'datetime');
            self::fail('an invalid offset date was accepted');
        } catch (\ReflectionException $error) {
            throw $error;
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: datetime cell is not a datetime', $error->getMessage());
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
            self::assertSame('CODEC_ENCODE: json: the value has no JSON text', $error->getMessage());
            self::assertInstanceOf(\JsonException::class, $error->getPrevious());
            self::assertSame(JSON_ERROR_UTF8, $error->getPrevious()->getCode());
        }
    }
}
