<?php
declare(strict_types=1);

// Reflection reads resolved classes, inheritance, traits, properties and signatures.
// No constructors or SQL are run while inspecting the declarations.
$root = $argv[1];
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
$params = static function (ReflectionFunctionAbstract $fn): array {
    return array_map(static function (ReflectionParameter $p): string {
        $default = $p->isDefaultValueAvailable() ? '=' . json_encode($p->getDefaultValue(), JSON_THROW_ON_ERROR) : '';
        return (string)$p->getType() . ' ' . ($p->isPassedByReference() ? '&' : '') . ($p->isVariadic() ? '...' : '') . '$' . $p->getName() . $default;
    }, $fn->getParameters());
};
$signature = static function (ReflectionFunctionAbstract $fn) use ($params): string {
    return '(' . implode(', ', $params($fn)) . '): ' . (string)$fn->getReturnType();
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
        $out[$key . '::$' . $p->getName()] = implode(' ', $modifiers) . ' ' . (string)$p->getType();
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
