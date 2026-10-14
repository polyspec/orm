<?php
declare(strict_types=1);

namespace Polyspec\Orm;

use PhpParser\Error;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\ParserFactory;

/**
 * Collects the methods that PHP sources call on the generated models, for orm-gen --scan. The sources are read with
 * nikic/php-parser. A call counts only when its receiver resolves to a model of the generated classes (docs/dsl.md
 * lists the receivers); a call on any other receiver adds nothing.
 */
final class Scan
{
    /** Methods of a model whose result is no model: a call on it ends the chain. */
    private const TERMINALS = ['delete', 'deleteRow', 'creates', 'toArray', 'toJson', 'jsonSerialize', 'connection', 'meta', 'readColumn',
        'writeColumn', 'getsCount', 'getCount', 'getSum', 'getAvg', 'getsPage', 'getQuery'];
    /** Methods of a model whose closure receives a model of the receiver's class as its first parameter. */
    private const MODEL_CALLBACKS = ['and', 'or', 'not', 'andNot', 'orNot', 'on', 'fetchKey', 'fetchValue'];

    /**
     * For each model class name (without namespace), the argument counts of every call by method name; null stands
     * for a call whose count is not known (a spread or a named argument).
     * @param list<string> $paths files or directories
     * @param list<string> $classes the class names of the generated models, without namespace
     * @return array<string, array<string, list<int|null>>>
     */
    public static function calls(array $paths, string $namespace, array $classes): array
    {
        $out = [];
        $files = [];
        foreach ($paths as $path) {
            if (is_dir($path)) {
                self::collect($path, $files);
            } elseif (is_file($path)) {
                $files[] = $path;
            } else {
                throw new \RuntimeException("--scan: $path does not exist");
            }
        }
        $parser = (new ParserFactory())->createForNewestSupportedVersion();
        $models = [];
        foreach ($classes as $class) {
            $models[strtolower(ltrim($namespace, '\\') . '\\' . $class)] = $class;
        }
        foreach ($files as $file) {
            if (!str_ends_with($file, '.php')) {
                continue;
            }
            try {
                $tree = $parser->parse((string) file_get_contents($file));
            } catch (Error $e) {
                throw new \RuntimeException("--scan: $file does not parse: " . $e->getMessage());
            }
            // A file that does not parse would hide its calls, so it fails the scan.
            $traverser = new NodeTraverser(new NameResolver());
            $tree = $traverser->traverse($tree ?? []);
            $visitor = new ScanVisitor($models, $out);
            (new NodeTraverser($visitor))->traverse($tree);
        }
        return $out;
    }

    /** @param list<string> $files */
    private static function collect(string $dir, array &$files): void
    {
        $entries = scandir($dir) ?: [];
        sort($entries, SORT_STRING);
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..' || $entry === 'vendor' || $entry === 'node_modules') {
                continue;
            }
            $path = rtrim($dir, '/') . '/' . $entry;
            if (is_dir($path)) {
                self::collect($path, $files);
            } else {
                $files[] = $path;
            }
        }
    }

    public static function terminal(string $name): bool
    {
        return in_array($name, self::TERMINALS, true);
    }

    public static function modelCallback(string $name): bool
    {
        return in_array($name, self::MODEL_CALLBACKS, true);
    }
}
