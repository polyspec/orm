<?php
declare(strict_types=1);

// Reflection reads resolved classes, inheritance, traits, properties and signatures.
// No constructors or SQL are run while inspecting the declarations.
$root = realpath($argv[1]);
if ($root === false) { throw new InvalidArgumentException('Source root does not exist'); }
$dirs = array_slice($argv, 2);
$files = [];
foreach ($dirs as $dir) {
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$root/$dir", FilesystemIterator::SKIP_DOTS));
    foreach ($it as $file) {
        if ($file->getExtension() === 'php') { $files[] = $file->getRealPath(); }
    }
}
sort($files);
// Load the runtime before generated subclasses. Top-level bootstrap only registers names.
$autoload = "$root/clients/php/tests/autoload.php";
if (is_file($autoload)) { require_once $autoload; }
foreach ($files as $file) { require_once $file; }
$out = [];
$type = static function (?ReflectionType $t, ?ReflectionClass $scope = null) use (&$type): string {
    if ($t === null) { return ''; }
    if ($t instanceof ReflectionNamedType) {
        $name = $t->getName();
        // Resolve lexical types consistently across PHP Reflection versions.
        // `static` remains distinct because its meaning depends on the called class.
        if ($name === 'self' && $scope !== null) { $name = $scope->getName(); }
        if ($name === 'parent' && $scope !== null && ($parent = $scope->getParentClass()) !== false) { $name = $parent->getName(); }
        return ($t->allowsNull() && !in_array($name, ['mixed', 'null'], true) ? '?' : '') . $name;
    }
    $parts = array_map(static function (ReflectionType $part) use ($type, $scope, $t): string {
        $name = $type($part, $scope);
        return $t instanceof ReflectionUnionType && $part instanceof ReflectionIntersectionType ? "($name)" : $name;
    }, $t->getTypes());
    return implode($t instanceof ReflectionUnionType ? '|' : '&', $parts);
};
$params = static function (ReflectionFunctionAbstract $fn) use ($type): array {
    $scope = $fn instanceof ReflectionMethod ? $fn->getDeclaringClass() : null;
    return array_map(static function (ReflectionParameter $p) use ($type, $scope): string {
        $default = $p->isDefaultValueAvailable() ? '=' . json_encode($p->getDefaultValue(), JSON_THROW_ON_ERROR) : '';
        return $type($p->getType(), $scope) . ' ' . ($p->isPassedByReference() ? '&' : '') . ($p->isVariadic() ? '...' : '') . '$' . $p->getName() . $default;
    }, $fn->getParameters());
};
$signature = static function (ReflectionFunctionAbstract $fn) use ($params, $type): string {
    $scope = $fn instanceof ReflectionMethod ? $fn->getDeclaringClass() : null;
    return '(' . implode(', ', $params($fn)) . '): ' . $type($fn->getReturnType(), $scope);
};
foreach (array_merge(get_declared_classes(), get_declared_interfaces(), get_declared_traits()) as $name) {
    $r = new ReflectionClass($name);
    if (!in_array($r->getFileName(), $files, true)) { continue; }
    $key = substr($r->getFileName(), strlen($root) + 1) . '::' . $name;
    $kind = $r->isInterface() ? 'interface' : ($r->isTrait() ? 'trait' : 'class');
    $interfaces = $r->getInterfaceNames(); sort($interfaces);
    $traits = $r->getTraitNames(); sort($traits);
    $parent = $r->getParentClass();
    $out[$key] = implode(' ', Reflection::getModifierNames($r->getModifiers())) . " $kind $name extends " . ($parent === false ? '' : $parent->getName()) . ' implements ' . implode(',', $interfaces) . ' uses ' . implode(',', $traits);
    foreach ($r->getProperties() as $p) {
        if ($p->getDeclaringClass()->getName() !== $name) { continue; }
        $modifiers = Reflection::getModifierNames($p->getModifiers());
        // PHP 8.4+ reports the implicit protected(set) of readonly properties.
        // Preserve explicit private(set), but keep default readonly portable to 8.2.
        if ($p->isReadOnly()) { $modifiers = array_values(array_diff($modifiers, ['protected(set)'])); }
        $out[$key . '::$' . $p->getName()] = implode(' ', $modifiers) . ' ' . $type($p->getType(), $p->getDeclaringClass());
    }
    foreach ($r->getMethods() as $m) {
        if ($m->getDeclaringClass()->getName() !== $name) { continue; }
        $out[$key . '::' . $m->getName()] = implode(' ', Reflection::getModifierNames($m->getModifiers())) . ' function ' . $m->getName() . $signature($m);
    }
}
foreach (get_defined_functions()['user'] as $name) {
    $f = new ReflectionFunction($name);
    if (in_array($f->getFileName(), $files, true)) {
        $out[substr($f->getFileName(), strlen($root) + 1) . '::' . $name] = 'function ' . $name . $signature($f);
    }
}
ksort($out);
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
