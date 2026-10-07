// select는 scripts/features/check.mjs가 실행할 검증 명령과 helper check를 고른다.
//
// --feature <id>는 그 기능의 검증 명령만, 함께 준 --command <id>(여럿)는 그 기능의 그 명령만 실행한다. --helper <id>
// (여럿)는 그 helper의 check만 실행한다. --features는 모든 기능의 검증 명령을 helper 없이 실행하고(make feature-check),
// --helpers는 모든 helper의 check를 기능 없이 실행하며, 함께 준 --without-helper <id>(여럿)는 그 helper를 뺀다(make
// feature-helper-check). 아무것도 고르지 않으면 모든 기능의 명령과 모든 helper의 check를 실행한다.

export const USAGE = 'usage: check.mjs [--run] [--feature <id> [--command <id>]... | --features | --helpers [--without-helper <id>]...] [--helper <id>]...';

// parseSelection은 명령 줄 인자에서 고른 것을 읽는다. 맞지 않는 조합은 USAGE와 함께 던진다.
export function parseSelection(argv) {
  const values = flag => argv.flatMap((arg, index) => arg === flag ? [argv[index + 1]] : []);
  const [feature, ...extraFeatures] = values('--feature');
  const commands = values('--command');
  const helpers = values('--helper');
  const without = values('--without-helper');
  const features = argv.includes('--features');
  const allHelpers = argv.includes('--helpers');
  if (extraFeatures.length || [...values('--feature'), ...commands, ...helpers, ...without].some(value => !value || value.startsWith('--'))
    || (commands.length && feature === undefined)
    || ((features || allHelpers) && (feature !== undefined || helpers.length > 0))
    || (features && allHelpers) || (without.length && !allHelpers))
    throw new Error(USAGE);
  return { feature, commands, helpers, without, features, allHelpers };
}

// selectionErrors는 manifest에 없는 기능, 명령과 helper를 고른 곳마다 오류 하나를 돌려준다.
export function selectionErrors(manifest, { feature, commands, helpers, without }) {
  const errors = [];
  const selected = (manifest.features ?? []).find(item => item.id === feature);
  if (feature !== undefined && !selected) errors.push(`unknown feature ${feature}`);
  for (const id of commands)
    if (selected && !(selected.verification ?? []).some(check => check.id === id)) errors.push(`unknown verification command ${feature}/${id}`);
  for (const id of [...helpers, ...without])
    if (!(manifest.helpers ?? []).some(helper => helper.id === id)) errors.push(`unknown helper ${id}`);
  return errors;
}

// selectChecks는 실행할 것을 [{ feature, check }]로 돌려준다. helper의 check는 helper를 쓰는 기능 대신 helper 자신을
// 검사하며 feature id `helpers` 아래에 있다(이름 features/helpers/<id>).
export function selectChecks(manifest, { feature, commands, helpers, without, features, allHelpers }) {
  const chosen = feature !== undefined || helpers.length > 0;
  const featureSelected = item => allHelpers ? false : chosen ? item.id === feature : true;
  const helperSelected = item => features ? false : allHelpers ? !without.includes(item.id) : chosen ? helpers.includes(item.id) : true;
  const checks = (manifest.features ?? []).filter(featureSelected)
    .flatMap(item => (item.verification ?? []).filter(check => commands.length === 0 || commands.includes(check.id)).map(check => ({ feature: item, check })));
  for (const helper of (manifest.helpers ?? []).filter(helperSelected))
    checks.push({ feature: { id: 'helpers' }, check: { id: helper.id, command: helper.command } });
  return checks;
}
