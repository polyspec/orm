import { runCasesOn } from './coverage_case.mjs';
import { hotPathGate } from './coverage_performance_gate.mjs';

// Requirements: PERF-1.
await runCasesOn('mysql', 'coverage_performance_gate_mysql.mjs', { hot_path_gate: () => hotPathGate('mysql') });
