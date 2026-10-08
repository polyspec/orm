<?php
// The hot-path gate measures the client in an ordinary PHP process. A debugger or
// coverage driver loaded into PHP slows every call of the client and of the native
// baseline by different amounts, so the gate refuses to measure with one loaded.
declare(strict_types=1);

/** The extensions that change the measured ratio when loaded. */
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
