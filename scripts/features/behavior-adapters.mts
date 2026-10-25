import { behaviorCompletionErrors, type BehaviorContract } from '../../tests/interfaces/check/manifest.mts';
import { readChecklist } from '../../node_modules/@polyspec/kit/scripts/kit/checklist.mts';

const CHECKLIST_TRACKER = { path: '', translation: '', idPattern: '\\S+' };

/** completionItemAdapterErrors prevents completing a declared checklist item while one of its behavior adapters is unresolved. */
export function completionItemAdapterErrors(checklist: string, contracts: BehaviorContract[]): string[] {
  const errors: string[] = [];
  const parsed = readChecklist(checklist, CHECKLIST_TRACKER, { strict: true });
  for (const contract of contracts) {
    const item = contract.completion_item ?? '';
    const invalidState = item !== '' && parsed.findings.some(finding => finding.rule === 'checklist-state' && (
      finding.message.includes(`the row of ${item} `) || finding.message.includes(`the state of ${item} `)
    ));
    if (invalidState) {
      errors.push(`${contract.id ?? ''}: checklist item ${item} has no recognized state`);
      continue;
    }
    const row = parsed.items.find(candidate => candidate.id === item);
    if (row === undefined) {
      errors.push(`${contract.id ?? ''}: missing checklist item ${item}`);
      continue;
    }
    if (row.state === '[o]') errors.push(...behaviorCompletionErrors(contract).map(error => `${item}: ${error}`));
  }
  return errors;
}
