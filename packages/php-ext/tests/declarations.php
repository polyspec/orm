<?php
declare(strict_types=1);

// Reads the class declarations of the extension's native classes with Reflection and prints them as JSON: each class and its modifiers, parent and
// interfaces, constants and values, property modifiers, types and defaults, method modifiers, arguments and return types.
//
// Usage: php -d extension=<orm_dbspec library> declarations.php extension
//        php declarations.php stub
//        php declarations.php client
// The extension reads the classes that the loaded extension orm_dbspec registers, and the stub reads the
// classes that the stubs (stubs/*.stub.php) declare. The two outputs must match (DeclarationsTest.php). The client reads the PHP client classes that
// the extension implements, the Polyspec\Orm\Dbspec classes that are not @internal and Polyspec\Orm\Code, as their native names: the extension
// must have the same public declarations for each class. A native name is the client's name with Native as the last namespace segment:
// Polyspec\Orm\Dbspec\Dbspec is Polyspec\Orm\Dbspec\Native\Dbspec, and Polyspec\Orm\Code is Polyspec\Orm\Native\Code.

const NATIVE_NAMESPACES = ['Polyspec\\Orm\\Dbspec\\Native\\', 'Polyspec\\Orm\\Native\\'];
/** The PHP client classes outside Polyspec\Orm\Dbspec that the extension implements. */
const CLIENT_CLASSES = ['Polyspec\\Orm\\Code'];

$mode = $argv[1] ?? '';
if ($mode === 'extension') {
    if (!extension_loaded('orm_dbspec')) {
        fwrite(STDERR, "declarations.php extension: the extension orm_dbspec is not loaded; run php -d extension=<library>\n");
        exit(1);
    }
    $classes = array_keys((new ReflectionExtension('orm_dbspec'))->getClasses());
} elseif ($mode === 'stub') {
    if (extension_loaded('orm_dbspec')) {
        fwrite(STDERR, "declarations.php stub: the extension orm_dbspec is loaded and declares the same classes; run php without it\n");
        exit(1);
    }
    $before = get_declared_classes();
    foreach (glob(dirname(__DIR__) . '/stubs/*.stub.php') as $file) {
        require $file;
    }
    $classes = array_values(array_diff(get_declared_classes(), $before));
} elseif ($mode === 'client') {
    if (extension_loaded('orm_dbspec')) {
        fwrite(STDERR, "declarations.php client: the extension orm_dbspec is loaded; run php without it\n");
        exit(1);
    }
    require dirname(__DIR__, 3) . '/vendor-php/autoload.php';
    $classes = [];
    foreach (glob(dirname(__DIR__, 2) . '/php/src/Dbspec/*.php') as $file) {
        $client = new ReflectionClass('Polyspec\\Orm\\Dbspec\\' . basename($file, '.php'));
        if (!str_contains((string) $client->getDocComment(), '@internal')) {
            $classes[] = $client->getName();
        }
    }
    array_push($classes, ...CLIENT_CLASSES);
} else {
    fwrite(STDERR, "usage: php declarations.php extension|stub|client\n");
    exit(2);
}
// The client's names and self are read as the extension's names: Native becomes the last namespace segment of each Polyspec\Orm name.
$native = static fn(string $text, string $class): string => preg_replace(
    ['/\\bPolyspec\\\\Orm\\\\(?!(?:[A-Z][A-Za-z0-9]*\\\\)*Native\\\\)((?:[A-Z][A-Za-z0-9]*\\\\)*)([A-Z][A-Za-z0-9]*)\\b(?!\\\\)/', '/\\bself\\b/'],
    ['Polyspec\\Orm\\\\${1}Native\\\\${2}', $class],
    $text,
);

$type = static fn(?ReflectionType $t): string => $t === null ? '' : (string) $t;
$client = $mode === 'client';
$modifiers = static fn(int $flags): string => implode(' ', Reflection::getModifierNames($flags));
$out = [];
sort($classes);
foreach ($classes as $source) {
    $name = $client ? $native($source, '') : $source;
    if (array_filter(NATIVE_NAMESPACES, static fn(string $namespace): bool => str_starts_with($name, $namespace)) === []) {
        fwrite(STDERR, "declarations.php $mode: $name is outside " . implode(' and ', NATIVE_NAMESPACES) . "\n");
        exit(1);
    }
    $class = new ReflectionClass($source);
    $interfaces = $class->getInterfaceNames();
    sort($interfaces);
    $parent = $class->getParentClass();
    $out[$name] = $modifiers($class->getModifiers()) . ' class extends ' . ($parent === false ? '' : $parent->getName())
        . ' implements ' . implode(',', $interfaces);
    foreach ($class->getReflectionConstants() as $constant) {
        $out["$name::{$constant->getName()}"] = $modifiers($constant->getModifiers()) . ' const = '
            . json_encode($constant->getValue(), JSON_THROW_ON_ERROR);
    }
    foreach ($class->getProperties() as $property) {
        $out["$name::\${$property->getName()}"] = $modifiers($property->getModifiers()) . ' ' . $type($property->getType())
            . ($property->hasDefaultValue() ? ' = ' . json_encode($property->getDefaultValue(), JSON_THROW_ON_ERROR) : '');
    }
    foreach ($class->getMethods() as $method) {
        $parameters = array_map(static function (ReflectionParameter $p) use ($type): string {
            $default = $p->isDefaultValueAvailable() ? ' = ' . json_encode($p->getDefaultValue(), JSON_THROW_ON_ERROR) : '';
            return $type($p->getType()) . ' ' . ($p->isPassedByReference() ? '&' : '') . ($p->isVariadic() ? '...' : '')
                . '$' . $p->getName() . $default;
        }, $method->getParameters());
        $out["$name::{$method->getName()}()"] = $modifiers($method->getModifiers()) . ' function(' . implode(', ', $parameters)
            . '): ' . $type($method->getReturnType());
    }
}
if ($client) {
    // The client compares only the public declarations with the extension, and reads its name and self as the extension's.
    $public = [];
    foreach ($out as $key => $value) {
        if (str_contains($key, '::') && !str_starts_with($value, 'public') && !str_starts_with($value, 'final public') && !str_starts_with($value, 'abstract public')) {
            continue;
        }
        $class = explode('::', $key)[0];
        $public[$key] = $native($value, $class);
    }
    $out = $public;
}
ksort($out);
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
