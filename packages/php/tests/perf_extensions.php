<?php

// The hot-path gate measures the client in an ordinary PHP process. A debugger or
// coverage driver loaded into PHP slows every call of the client and of the native
// baseline by different amounts, so the gate refuses to measure with one loaded.
declare(strict_types=1);

// The extensions that change the measured ratio when loaded.
const PERF_GATE_REFUSED_EXTENSIONS = ['xdebug', 'pcov'];

/**
 * Returns the loaded extensions of PERF_GATE_REFUSED_EXTENSIONS; $loaded reports
 * whether one extension is loaded, as extension_loaded does.
 * @param Closure(string): bool $loaded
 * @return list<string>
 */
function perfGateRefusedExtensions(Closure $loaded): array
{
    return array_values(array_filter(PERF_GATE_REFUSED_EXTENSIONS, $loaded));
}

/** The refused extensions that this PHP loads, read from get_loaded_extensions. */
function loadedRefusedExtensions(): array
{
    $names = get_loaded_extensions();
    return perfGateRefusedExtensions(static fn (string $name): bool => in_array($name, $names, true));
}

/**
 * The refused extensions that the run declares it loads: ORM_PERF_REFUSED_LOADED, a comma list that the make target and
 * scripts/perf-test.mts set empty, since the perf runs use no debugger or coverage driver. A missing declaration fails.
 * @return list<string>
 */
function declaredRefusedExtensions(): array
{
    $declared = getenv('ORM_PERF_REFUSED_LOADED');
    if ($declared === false) {
        throw new RuntimeException('ORM_PERF_REFUSED_LOADED is not declared; run the perf target, which declares it');
    }
    return array_values(array_filter(explode(',', $declared), static fn (string $name): bool => $name !== ''));
}
