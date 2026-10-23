<?php

// The functions of declarations.php, which requires this file, and of DeclarationsTest.php, whose
// bootstrap requires it.
declare(strict_types=1);

// The namespace and the class outside it that the extension registers, which are those of the PHP client.
const EXTENSION_NAMESPACE = 'Polyspec\\Orm\\Dbspec\\';

const CLIENT_CLASSES = [
    'Polyspec\\Orm\\Code',
    'Polyspec\\Orm\\Codec',
    'Polyspec\\Orm\\Validator',
    'Polyspec\\Orm\\Planner',
    'Polyspec\\Orm\\Db',
    'Polyspec\\Orm\\StatementEvent',
    'Polyspec\\Orm\\Collection',
    'Polyspec\\Orm\\StyledValue',
    'Polyspec\\Orm\\Page',
    'Polyspec\\Orm\\Func',
    'Polyspec\\Orm\\Model',
    'Polyspec\\Orm\\Chain',
    'Polyspec\\Orm\\Registry',
    'Polyspec\\Orm\\Schema',
    'Polyspec\\Orm\\RuntimeModel',
    'Polyspec\\Orm\\GroupRow',
    'Polyspec\\Orm\\GroupRows'
];

const INTERNAL_CLASSES = [
    'Polyspec\\Orm\\CollectionIterator',
    'Polyspec\\Orm\\CollectionDeleteCallback',
    'Polyspec\\Orm\\ModelMetadata',
    'Polyspec\\Orm\\ModelCreatesCallback',
    'Polyspec\\Orm\\ModelRestoreHook',
    'Polyspec\\Orm\\ModelRestoreOrCreateCallback',
    'Polyspec\\Orm\\ModelDeleteCallback',
    'Polyspec\\Orm\\Frame',
    'Polyspec\\Orm\\Assembly',
    'Polyspec\\Orm\\GroupRowsIterator',
    'Polyspec\\Orm\\Request',
    'Polyspec\\Orm\\PendingTime'
];

/**
 * The declarations of $classes, keyed by class, constant, property and method; with $public only the public members, as
 * the client is compared with the extension by them. A return type `self` is read as the class's name, which the stub
 * writes.
 */
function declarations(array $classes, bool $public): array
{
    $type = static fn(?ReflectionType $t): string => $t === null ? '' : (string) $t;
    $modifiers = static fn(int $flags): string => implode(' ', Reflection::getModifierNames($flags));
    $out = [];
    sort($classes);
    foreach ($classes as $name) {
        if (
            !str_starts_with($name, EXTENSION_NAMESPACE)
            && !in_array($name, CLIENT_CLASSES, true)
            && !in_array($name, INTERNAL_CLASSES, true)
        ) {
            throw new RuntimeException(
                "$name is outside " . EXTENSION_NAMESPACE . ' and ' . implode(', ', CLIENT_CLASSES)
            );
        }
        $class = new ReflectionClass($name);
        $interfaces = $class->getInterfaceNames();
        sort($interfaces);
        $parent = $class->getParentClass();
        $members = [$name => $modifiers($class->getModifiers()) . ' class extends ' . (
            $parent === false ? '' : $parent->getName()
        )
            . ' implements ' . implode(',', $interfaces)];
        foreach ($class->getReflectionConstants() as $constant) {
            $members["$name::{$constant->getName()}"] = $modifiers($constant->getModifiers()) . ' const = '
                . json_encode($constant->getValue(), JSON_THROW_ON_ERROR);
        }
        foreach ($class->getProperties() as $property) {
            $members[
                "$name::\${$property->getName()}"
            ] = $modifiers($property->getModifiers()) . ' ' . $type($property->getType())
                . (
                    $property->hasDefaultValue() ? ' = ' . json_encode(
                        $property->getDefaultValue(),
                        JSON_THROW_ON_ERROR
                    ) : ''
                );
        }
        foreach ($class->getMethods() as $method) {
            $parameters = array_map(static function (ReflectionParameter $p) use ($type): string {
                $default = $p->isDefaultValueAvailable() ? ' = ' . json_encode(
                    $p->getDefaultValue(),
                    JSON_THROW_ON_ERROR
                ) : '';
                return $type($p->getType()) . ' ' . (
                    $p->isPassedByReference() ? '&' : ''
                ) . ($p->isVariadic() ? '...' : '')
                    . '$' . $p->getName() . $default;
            }, $method->getParameters());
            $members[
                "$name::{$method->getName()}()"
            ] = $modifiers($method->getModifiers()) . ' function(' . implode(', ', $parameters)
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
