<?php

declare(strict_types=1);

// Reads class declarations with Reflection as a map of each class and its modifiers, parent and interfaces, constants and values,
// property modifiers, types and defaults, method modifiers, arguments and return types.
//
// Usage: php declarations.php stub
//        php declarations.php client
// The stub reads the classes that the one stub of the extension (src/polyspec_orm.stub.php) declares, in a PHP without the
// extension, which registers the same names. The client reads the PHP client classes that the extension implements, the
// Polyspec\Orm\Dbspec classes that are not @internal, Polyspec\Orm\Code and Polyspec\Orm\Codec, through the Composer autoloader of the development
// root, also in a PHP without the extension, which would take their place: only their public declarations are kept. Each prints
// its map as JSON. DeclarationsTest.php reads the classes of the loaded extension in its own process with declarations() and
// compares them with both.

/** The namespace and the class outside it that the extension registers, which are those of the PHP client. */
const EXTENSION_NAMESPACE = 'Polyspec\\Orm\\Dbspec\\';
const CLIENT_CLASSES = ['Polyspec\\Orm\\Code', 'Polyspec\\Orm\\Codec'];

/**
 * The declarations of $classes, keyed by class, constant, property and method; with $public only the public members, as the
 * client is compared with the extension by them. A return type `self` is read as the class's name, which the stub writes.
 */
function declarations(array $classes, bool $public): array
{
    $type = static fn(?ReflectionType $t): string => $t === null ? '' : (string) $t;
    $modifiers = static fn(int $flags): string => implode(' ', Reflection::getModifierNames($flags));
    $out = [];
    sort($classes);
    foreach ($classes as $name) {
        if (!str_starts_with($name, EXTENSION_NAMESPACE) && !in_array($name, CLIENT_CLASSES, true)) {
            throw new RuntimeException("$name is outside " . EXTENSION_NAMESPACE . ' and ' . implode(', ', CLIENT_CLASSES));
        }
        $class = new ReflectionClass($name);
        $interfaces = $class->getInterfaceNames();
        sort($interfaces);
        $parent = $class->getParentClass();
        $members = [$name => $modifiers($class->getModifiers()) . ' class extends ' . ($parent === false ? '' : $parent->getName())
            . ' implements ' . implode(',', $interfaces)];
        foreach ($class->getReflectionConstants() as $constant) {
            $members["$name::{$constant->getName()}"] = $modifiers($constant->getModifiers()) . ' const = '
                . json_encode($constant->getValue(), JSON_THROW_ON_ERROR);
        }
        foreach ($class->getProperties() as $property) {
            $members["$name::\${$property->getName()}"] = $modifiers($property->getModifiers()) . ' ' . $type($property->getType())
                . ($property->hasDefaultValue() ? ' = ' . json_encode($property->getDefaultValue(), JSON_THROW_ON_ERROR) : '');
        }
        foreach ($class->getMethods() as $method) {
            $parameters = array_map(static function (ReflectionParameter $p) use ($type): string {
                $default = $p->isDefaultValueAvailable() ? ' = ' . json_encode($p->getDefaultValue(), JSON_THROW_ON_ERROR) : '';
                return $type($p->getType()) . ' ' . ($p->isPassedByReference() ? '&' : '') . ($p->isVariadic() ? '...' : '')
                    . '$' . $p->getName() . $default;
            }, $method->getParameters());
            $members["$name::{$method->getName()}()"] = $modifiers($method->getModifiers()) . ' function(' . implode(', ', $parameters)
                . '): ' . $type($method->getReturnType());
        }
        foreach ($members as $key => $value) {
            if ($public && $key !== $name && !preg_match('/^(?:(?:final|abstract) )?public\b/', $value)) {
                continue;
            }
            $out[$key] = preg_replace('/\bself\b/', $name, $value);
        }
    }
    return $out;
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    $mode = $argv[1] ?? '';
    if ($mode !== 'stub' && $mode !== 'client') {
        fwrite(STDERR, "usage: php declarations.php stub|client\n");
        exit(2);
    }
    if (extension_loaded('polyspec_orm')) {
        fwrite(STDERR, "declarations.php $mode: the extension polyspec_orm is loaded and registers the same classes; run php without it\n");
        exit(1);
    }
    if ($mode === 'stub') {
        $before = get_declared_classes();
        require dirname(__DIR__) . '/src/polyspec_orm.stub.php';
        $classes = array_values(array_diff(get_declared_classes(), $before));
    } else {
        require dirname(__DIR__, 3) . '/vendor-php/autoload.php';
        $classes = CLIENT_CLASSES;
        foreach (glob(dirname(__DIR__, 2) . '/php/src/Dbspec/*.php') as $file) {
            $client = new ReflectionClass(EXTENSION_NAMESPACE . basename($file, '.php'));
            if (!str_contains((string) $client->getDocComment(), '@internal')) {
                $classes[] = $client->getName();
            }
        }
    }
    echo json_encode(declarations($classes, $mode === 'client'), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
}
