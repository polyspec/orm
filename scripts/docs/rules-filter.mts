export const implementationCountRule = 'docs.implementation-count';

export function onlyRuleFromArgs(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== '--only' || args[1] !== implementationCountRule) {
    throw new Error(`unsupported docs rules arguments ${JSON.stringify(args)}; use --only ${implementationCountRule}`);
  }
  return implementationCountRule;
}

export function filterRuleFailures(failures: readonly string[], selectedRule: string | undefined): readonly string[] {
  if (selectedRule === undefined || selectedRule === '') return failures;
  if (selectedRule !== implementationCountRule) {
    throw new Error(`docs rule ${JSON.stringify(selectedRule)} is unsupported; use ${implementationCountRule}`);
  }
  return failures.filter(failure => failure.startsWith(`${selectedRule}:`));
}
