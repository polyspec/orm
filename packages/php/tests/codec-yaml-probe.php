<?php

declare(strict_types=1);

namespace {
    require __DIR__ . '/fixtures/CodecProbeYamlStream.php';
    require __DIR__ . '/fixtures/CodecProbeDumper.php';
    require dirname(__DIR__, 3) . '/vendor-php/autoload.php';

    $operation = $argv[1] ?? '';
    $failure = $argv[2] ?? '';
    $mode = $argv[3] ?? 'library';
    $previous = match ($failure) {
        'parse' => new \Purr\Yaml\Exception\ParseException('parse sentinel', 1, 'value: ['),
        'reference' => \Purr\Yaml\Exception\ReferenceException::undefinedAnchor('missing', 1),
        'policy' => new \InvalidArgumentException('policy sentinel'),
        'runtime' => new \RuntimeException('runtime sentinel'),
        'type' => new \TypeError('type sentinel'),
        'error' => new \Error('error sentinel'),
        default => throw new \InvalidArgumentException("unknown probe failure $failure"),
    };
    $expectedCode = $operation === 'dump' ? \Polyspec\Orm\Code::CODEC_ENCODE : \Polyspec\Orm\Code::CODEC_DECODE;
    if ($operation === 'decode') {
        \Purr\Yaml\YamlStream::$failure = $previous;
    } elseif ($operation === 'dump') {
        \Purr\Yaml\Dumper\Dumper::$failure = $previous;
    } else {
        throw new \InvalidArgumentException("unknown probe operation $operation");
    }

    try {
        if ($operation === 'decode') {
            \Polyspec\Orm\Codec::decode(['yaml'], 'ignored');
        } else {
            \Polyspec\Orm\Codec::encode(['yaml'], \Polyspec\Orm\StyledValue::value('value'));
        }
        fwrite(STDERR, 'the codec returned instead of propagating the configured YAML failure');
        exit(1);
    } catch (\Throwable $actual) {
        // Every failure of the library is the error of its rule, with the failure as its exact cause (COD-71).
        $valid = $actual instanceof \Polyspec\Orm\OrmException
            && $actual->code_ === $expectedCode
            && $actual->getPrevious() === $previous;
        if (!$valid) {
            fwrite(STDERR, 'the YAML wrapper did not retain its exact cause object');
            exit(1);
        }
        fwrite(STDOUT, json_encode([
            'wrapped' => true,
            'code' => $actual->code_,
            'previousSame' => $actual->getPrevious() === $previous,
            'native' => $mode === 'native' && (new \ReflectionClass(\Polyspec\Orm\Codec::class))->isInternal(),
        ], JSON_THROW_ON_ERROR));
        exit(0);
    }
}
