<?php
declare(strict_types=1);

// Polyspec\Orm\Dbspec\Native의 class 선언을 Reflection으로 읽어 JSON으로 출력한다: class와 그 modifier, 부모와
// interface, 상수와 값, property의 modifier, type과 기본값, 메서드의 modifier, 인자와 return type.
//
// Usage: php -d extension=<orm_dbspec library> declarations.php extension
//        php declarations.php stub
//        php declarations.php client
// extension은 load한 확장 orm_dbspec이 등록한 class를, stub은 stubs/orm_dbspec.stub.php가 선언한
// class를 읽는다. 두 출력이 같아야 한다(declarations_test.php). client는 PHP client의 Polyspec\Orm\Dbspec에서 @internal이
// 아닌 class를 Polyspec\Orm\Dbspec\Native의 이름으로 읽는다: 확장은 그 class의 public 선언을 같게 가져야 한다.

const NATIVE_NAMESPACE = 'Polyspec\\Orm\\Dbspec\\Native\\';

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
    require dirname(__DIR__) . '/stubs/orm_dbspec.stub.php';
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
} else {
    fwrite(STDERR, "usage: php declarations.php extension|stub|client\n");
    exit(2);
}
// client의 이름과 self는 확장의 이름으로 읽는다.
$native = static fn(string $text, string $class): string => preg_replace(['/\\bPolyspec\\\\Orm\\\\Dbspec\\\\(?!Native\\\\)/', '/\\bself\\b/'], ['Polyspec\\Orm\\Dbspec\\Native\\', $class], $text);

$type = static fn(?ReflectionType $t): string => $t === null ? '' : (string) $t;
$client = $mode === 'client';
$modifiers = static fn(int $flags): string => implode(' ', Reflection::getModifierNames($flags));
$out = [];
sort($classes);
foreach ($classes as $source) {
    $name = $client ? $native($source, '') : $source;
    if (!str_starts_with($name, NATIVE_NAMESPACE)) {
        fwrite(STDERR, "declarations.php $mode: $name is outside " . NATIVE_NAMESPACE . "\n");
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
    // client는 public 선언만 확장과 비교하고, 이름과 self를 확장의 것으로 읽는다.
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
