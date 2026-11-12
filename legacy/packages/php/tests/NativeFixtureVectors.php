<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;

/** Shared validation and lookup for native tests that select existing fixture vectors. */
final class NativeFixtureVectors
{
    /** @param iterable<array<mixed>> $cases @return iterable<string, array{string}> */
    public static function ids(iterable $cases, string $subject): iterable
    {
        $seen = [];
        foreach ($cases as $arguments) {
            $case = $arguments[0] ?? null;
            $id = is_array($case) ? ($case['id'] ?? null) : null;
            if (!is_string($id) || $id === '' || isset($seen[$id])) {
                throw new RuntimeException("$subject fixture cases must have non-empty unique IDs");
            }
            $seen[$id] = true;
            yield $id => [$id];
        }
        if ($seen === []) {
            throw new RuntimeException("$subject fixture has no cases");
        }
    }

    /** @param iterable<array<mixed>> $cases @return array<mixed> */
    public static function argumentsForId(iterable $cases, string $id, string $subject): array
    {
        $match = null;
        foreach ($cases as $arguments) {
            $case = $arguments[0] ?? null;
            if (is_array($case) && ($case['id'] ?? null) === $id) {
                if ($match !== null) {
                    throw new RuntimeException("$subject fixture repeats case $id");
                }
                $match = $arguments;
            }
        }
        return $match ?? throw new RuntimeException("$subject fixture has no case $id");
    }
}
