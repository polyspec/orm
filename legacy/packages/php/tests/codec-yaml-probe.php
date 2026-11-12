<?php

declare(strict_types=1);

namespace {
    require __DIR__ . '/fixtures/CodecProbeDumper.php';
    require dirname(__DIR__, 3) . '/vendor-php/autoload.php';

    $operation = $argv[1] ?? '';
    $failure = $argv[2] ?? '';
    $mode = $argv[3] ?? 'library';
    $previous = match ($failure) {
        'policy' => new \InvalidArgumentException('policy sentinel'),
        'runtime' => new \RuntimeException('runtime sentinel'),
        'type' => new \TypeError('type sentinel'),
        'error' => new \Error('error sentinel'),
        default => throw new \InvalidArgumentException("unknown probe failure $failure"),
    };
    // No library parses on the read path (COD-74), so only the writer has a failure to inject.
    $expectedCode = \Polyspec\Orm\Code::CODEC_ENCODE;
    if ($operation !== 'dump') {
        throw new \InvalidArgumentException("unknown probe operation $operation");
    }
    \Purr\Yaml\Dumper\Dumper::$failure = $previous;

    try {
        \Polyspec\Orm\Codec::encode(['yaml'], \Polyspec\Orm\StyledValue::value('value'));
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
