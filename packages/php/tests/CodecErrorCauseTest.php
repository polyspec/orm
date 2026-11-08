<?php

// The PHP error chain of the codec and of Model's value conversion: an expected failure of a library is the stage's
// own text and keeps the library's exception as its previous exception, a rule of the codec keeps itself, and an
// unexpected throwable passes through by identity. The codec cases that every client
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
        // A failure of the library of a stage is the stage's own text and keeps the library exception as its previous
        // one; a rule of the codec is its rule text and keeps the rule as an InvalidArgumentException.
        $cases = [
            'YAML parser syntax' => [
                fn() => Codec::decode(['yaml'], 'value: ['),
                'CODEC_DECODE: yaml: the stream does not parse',
                true,
            ],
            'YAML undefined alias' => [
                fn() => Codec::decode(['yaml'], "value: *missing\n"),
                'CODEC_DECODE: yaml: the stream does not parse',
                true,
            ],
            'YAML codec policy' => [
                fn() => Codec::decode(['yaml'], "value: &x 1\nother: *x\n"),
                'CODEC_DECODE: yaml: anchors are not supported at line 1',
                false,
            ],
            'YAML encode policy' => [
                fn() => Codec::encode(['yaml'], StyledValue::value(new \stdClass())),
                'CODEC_ENCODE: yaml: value type is not supported',
                false,
            ],
            'ordered JSON parser' => [
                fn() => Codec::decode(['ordered_json'], '{'),
                'CODEC_DECODE: json: the cell is not JSON',
                true,
            ],
            'JSON encoder' => [
                fn() => Codec::encode(['ordered_json'], StyledValue::value("\xFF")),
                'CODEC_ENCODE: json: the value has no JSON text',
                true,
            ],
        ];
        foreach ($cases as $name => [$operation, $message, $library]) {
            try {
                $operation();
                self::fail("$name: expected codec failure");
            } catch (OrmException $exception) {
                self::assertSame($message, $exception->getMessage(), $name);
                $previous = $exception->getPrevious();
                self::assertInstanceOf(\Throwable::class, $previous, $name);
                if (!$library) {
                    self::assertInstanceOf(\InvalidArgumentException::class, $previous, $name);
                    self::assertStringEndsWith(': ' . $previous->getMessage(), $message, $name);
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
