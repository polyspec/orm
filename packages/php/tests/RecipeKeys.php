<?php

// The key check of the recipe format (FCV-2 to FCV-4, T334-3-5-6): the PHP loader refuses a file, case or step key that
// the key table beside the recipe's schema does not hold, and each op that the table does not hold, by name, before any
// case runs. It needs no built client, so its unit test runs without one.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class RecipeKeys
{
    /**
     * The nesting depth with which a recipe is read: a recipe holds a value nested past the 256 levels of the
     * ordered-json parser (tests/codec/codec-json-depth.json), each level of a wrapper is two JSON levels, and the
     * recipe nests around the value.
     */
    public const DEPTH = 1024;

    /** @var array<string, array<string, mixed>> the key tables that have been read, by file */
    private static array $tables = [];

    /** The key table beside the schema that the $schema of the recipe at path names, relative to the recipe's directory. */
    public static function table(string $path, string $schema): array
    {
        $file = dirname(__DIR__, 3) . '/' . dirname($path) . '/' . dirname($schema) . '/recipe-keys.json';
        return self::$tables[$file] ??= json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
    }

    /** The first key of $object, in sorted order, that $keys does not hold, or null. */
    private static function unknown(array $object, array $keys): ?string
    {
        $names = array_map('strval', array_keys($object));
        sort($names, SORT_STRING);
        foreach ($names as $name) {
            if (!in_array($name, $keys, true)) {
                return $name;
            }
        }
        return null;
    }

    /** Refuses the recipe text at path (relative to the repository root) on its first key or op that its table does not hold. */
    public static function check(string $path, string $text): void
    {
        self::decoded($path, $text);
    }

    /** The recipe of the text at path, decoded once: the same refusals as check. */
    public static function decoded(string $path, string $text): array
    {
        $recipe = json_decode($text, true, self::DEPTH, JSON_THROW_ON_ERROR);
        $schema = $recipe['$schema'] ?? null;
        if (!is_string($schema) || $schema === '') {
            throw new \RuntimeException("recipe $path: no \$schema names the recipe key table");
        }
        $table = self::table($path, $schema);
        $key = self::unknown($recipe, $table['file']);
        if ($key !== null) {
            throw new \RuntimeException("recipe $path: unknown key $key");
        }
        if (!is_array($recipe['cases'] ?? null)) {
            throw new \RuntimeException("recipe $path: cases is not a list");
        }
        foreach ($recipe['cases'] as $case) {
            $id = (string) ($case['id'] ?? '');
            $key = self::unknown($case, $table['case']);
            if ($key !== null) {
                throw new \RuntimeException("recipe $path case $id: unknown key $key");
            }
            if (!is_array($case['steps'] ?? null)) {
                throw new \RuntimeException("recipe $path case $id: steps is not a list");
            }
            foreach ($case['steps'] as $index => $step) {
                $op = $step['op'] ?? null;
                if (!is_string($op) || !array_key_exists($op, $table['step'])) {
                    throw new \RuntimeException("recipe $path case $id step $index: unknown op " . json_encode($op));
                }
                $key = self::unknown($step, $table['step'][$op]);
                if ($key !== null) {
                    throw new \RuntimeException("recipe $path case $id step $index ($op): unknown key $key");
                }
            }
        }
        return $recipe;
    }
}
