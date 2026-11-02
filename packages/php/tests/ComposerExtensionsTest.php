<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Checks that packages/php/composer.json declares every PHP extension that the library source uses: each class and
// function that packages/php/src names is resolved by reflection to its extension, which require or suggest of
// composer.json lists as ext-<name>. The extensions that every PHP build holds are not declared.

use PhpParser\Node;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class ComposerExtensionsTest extends TestCase
{
    /** The extensions that every PHP build holds; they cannot be disabled, so composer.json does not name them. */
    private const ALWAYS = ['core', 'standard', 'date', 'pcre', 'reflection', 'spl', 'random', 'hash'];

    public function testEveryUsedExtensionIsDeclared(): void
    {
        $root = dirname(__DIR__);
        $composer = json_decode((string) file_get_contents("$root/composer.json"), true, 512, JSON_THROW_ON_ERROR);
        $declared = array_keys(($composer['require'] ?? []) + ($composer['suggest'] ?? []));
        $missing = [];
        foreach ($this->usedExtensions("$root/src") as $extension => $where) {
            if (!in_array($extension, self::ALWAYS, true) && !in_array("ext-$extension", $declared, true)) {
                $missing[] = "ext-$extension (used by $where)";
            }
        }
        $this->assertSame([], $missing, 'composer.json declares neither in require nor in suggest');
    }

    /**
     * The lower-case names of the extensions whose classes and functions the PHP files under $dir name, each with the
     * first file and name that uses it.
     *
     * @return array<string, string>
     */
    private function usedExtensions(string $dir): array
    {
        $parser = (new ParserFactory())->createForHostVersion();
        $collector = new class extends NodeVisitorAbstract {
            /** @var list<array{0: 'class'|'function', 1: string}> */
            public array $names = [];

            public function enterNode(Node $node): null
            {
                if ($node instanceof Node\Expr\FuncCall && $node->name instanceof Node\Name) {
                    $resolved = $node->name->getAttribute('namespacedName');
                    $name = $resolved instanceof Node\Name ? $resolved->getLast() : $node->name->toString();
                    $this->names[] = ['function', $name];
                } elseif ($node instanceof Node\Name\FullyQualified) {
                    $this->names[] = ['class', $node->toString()];
                }
                return null;
            }
        };
        $traverser = new NodeTraverser();
        $traverser->addVisitor(new NameResolver(null, ['replaceNodes' => true]));
        $traverser->addVisitor($collector);
        $used = [];
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
        foreach ($files as $file) {
            if (!$file instanceof \SplFileInfo || $file->getExtension() !== 'php') {
                continue;
            }
            $collector->names = [];
            $traverser->traverse($parser->parse((string) file_get_contents($file->getPathname())) ?? []);
            foreach ($collector->names as [$kind, $name]) {
                $extension = self::extensionOf($kind, $name);
                if ($extension !== null) {
                    $used[$extension] ??= substr($file->getPathname(), strlen($dir) + 1) . " $name";
                }
            }
        }
        ksort($used);
        return $used;
    }

    /** The lower-case extension of a built-in class or function, or null for a name of user code or an unknown name. */
    private static function extensionOf(string $kind, string $name): ?string
    {
        if ($kind === 'function') {
            if (!function_exists($name)) {
                return null;
            }
            $extension = (new \ReflectionFunction($name))->getExtensionName();
        } else {
            if (!class_exists($name, false) && !interface_exists($name, false) && !enum_exists($name, false)) {
                return null;
            }
            $class = new \ReflectionClass($name);
            if ($class->isUserDefined()) {
                return null;
            }
            $extension = $class->getExtensionName();
        }
        return is_string($extension) ? strtolower($extension) : null;
    }
}
