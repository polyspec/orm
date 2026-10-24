<?php

declare(strict_types=1);

namespace {
    require __DIR__ . '/fixtures/CodecProbeYamlStream.php';
    require __DIR__ . '/fixtures/CodecProbeYaml.php';
    require dirname(__DIR__, 3) . '/vendor-php/autoload.php';

    $operation = $argv[1] ?? '';
    $failure = $argv[2] ?? '';
    $mode = $argv[3] ?? 'library';
    $previous = match ($failure) {
        'parse' => new \Purr\Yaml\Exception\ParseException('parse sentinel', 1, 'value: ['),
        'reference' => \Purr\Yaml\Exception\ReferenceException::undefinedAnchor('missing', 1),
        'policy' => new \InvalidArgumentException('policy sentinel'),
        'dump' => new \Symfony\Component\Yaml\Exception\DumpException('dump sentinel'),
        'runtime' => new \RuntimeException('runtime sentinel'),
        'type' => new \TypeError('type sentinel'),
        'error' => new \Error('error sentinel'),
        default => throw new \InvalidArgumentException("unknown probe failure $failure"),
    };
    $expectedCode = $operation === 'dump' ? \Polyspec\Orm\Code::CODEC_ENCODE : \Polyspec\Orm\Code::CODEC_DECODE;
    if ($operation === 'decode') {
        \Purr\Yaml\YamlStream::$failure = $previous;
    } elseif ($operation === 'dump') {
        \Symfony\Component\Yaml\Yaml::$failure = $previous;
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
        $expectedFailure = in_array($failure, ['parse', 'reference', 'policy', 'dump'], true);
        if ($expectedFailure) {
            $valid = $actual instanceof \Polyspec\Orm\OrmException
                && $actual->code_ === $expectedCode
                && $actual->getPrevious() === $previous;
            if (!$valid) {
                fwrite(STDERR, 'the expected YAML wrapper did not retain its exact cause object');
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
        if ($actual !== $previous) {
            fwrite(STDERR, 'the unexpected YAML throwable changed identity');
            exit(1);
        }
        fwrite(STDOUT, json_encode([
            'identity' => $actual === $previous,
            'native' => $mode === 'native' && (new \ReflectionClass(\Polyspec\Orm\Codec::class))->isInternal(),
        ], JSON_THROW_ON_ERROR));
        exit(0);
    }
}
