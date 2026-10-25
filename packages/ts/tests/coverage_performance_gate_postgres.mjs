import { runCases } from './coverage_case.mjs';
import { hotPathGate } from './coverage_performance_gate.mjs';

// Requirements: PERF-1.
await runCases('coverage_performance_gate_postgres.mjs', { hot_path_gate: (item) => hotPathGate(item, 'postgres') }, 300_000);
