import { behaviorCompletionErrors, type BehaviorContract } from '../../tests/interfaces/check/manifest.mts';

/** completionItemAdapterErrors prevents completing a declared checklist item while one of its behavior adapters is unresolved. */
export function completionItemAdapterErrors(checklist: string, contracts: BehaviorContract[]): string[] {
  const errors: string[] = [];
  for (const contract of contracts) {
    const item = contract.completion_item ?? '';
    const row = checklist.split(/\r?\n/).find(line => new RegExp(`^\\|\\s*${item.replaceAll('.', '\\.')}\\s*\\|`).test(line));
    if (row === undefined) {
      errors.push(`${contract.id ?? ''}: missing checklist item ${item}`);
      continue;
    }
    const state = /\|\s*\[([o~ -])\]\s*\|\s*$/.exec(row)?.[1];
    if (state === undefined) {
      errors.push(`${contract.id ?? ''}: checklist item ${item} has no recognized state`);
      continue;
    }
    if (state === 'o') errors.push(...behaviorCompletionErrors(contract).map(error => `${item}: ${error}`));
  }
  return errors;
}
