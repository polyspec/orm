import { runCasesOn } from './coverage_case.mjs';
import { hotPathGate } from './coverage_performance_gate.mjs';

// Requirements: PERF-1.
await runCasesOn('sqlite', 'coverage_performance_gate_sqlite.mjs', { hot_path_gate: () => hotPathGate('sqlite') }, 300_000);
