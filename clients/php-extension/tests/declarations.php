<?php
declare(strict_types=1);

// Orm\Dbspec\Native의 class 선언을 Reflection으로 읽어 JSON으로 출력한다: class와 그 modifier, 부모와
// interface, 상수와 값, property의 modifier, type과 기본값, 메서드의 modifier, 인자와 return type.
//
// Usage: php -d extension=<orm_dbspec library> declarations.php extension
//        php declarations.php stub
// extension은 load한 확장 orm_dbspec이 등록한 class를, stub은 stubs/orm_dbspec.stub.php가 선언한
// class를 읽는다. 두 출력이 같아야 한다(declarations_test.php).

const NATIVE_NAMESPACE = 'Orm\\Dbspec\\Native\\';

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
} else {
    fwrite(STDERR, "usage: php declarations.php extension|stub\n");
    exit(2);
}

$type = static fn(?ReflectionType $t): string => $t === null ? '' : (string) $t;
$modifiers = static fn(int $flags): string => implode(' ', Reflection::getModifierNames($flags));
$out = [];
sort($classes);
foreach ($classes as $name) {
    if (!str_starts_with($name, NATIVE_NAMESPACE)) {
        fwrite(STDERR, "declarations.php $mode: $name is outside " . NATIVE_NAMESPACE . "\n");
        exit(1);
    }
    $class = new ReflectionClass($name);
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
ksort($out);
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
