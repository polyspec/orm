// select chooses the verify commands and the helper checks that scripts/features/check.mts will run.
//
// --feature <id> runs only that feature's verify commands; --command <id> given with it (multiple) runs only that command of that feature. --helper <id>
// (multiple) runs only that helper's check. --features runs every feature's verify commands without helpers, and --shard <shard> given with it
// runs only the commands whose declared `shard` is that shard (make feature-verify-rust, make feature-verify-other). --helpers runs
// every helper's check without features, and --without-helper <id> given with it (multiple) removes that helper (make feature-helper-check).
// If nothing is chosen, all features' commands and all helpers' checks run.

import { parseArgs } from 'node:util';

export const USAGE = 'usage: check.mts [--run] [--feature <id> [--command <id>]... | --features [--shard <shard>] | --helpers [--without-helper <id>]...] [--helper <id>]...';

// SHARDS is the `shard` that verify commands declare. rust is the command that builds and runs Rust with cargo, and other is the rest. make check
// runs the two shards in different CI groups: because a cargo build in one job runs one at a time under the Rust target directory's lease,
// it gathers the cargo commands into one job and runs the rest in another job together.
export const SHARDS = ['rust', 'other'];

// parseSelection reads what was chosen from command-line arguments: node:util's parseArgs reads options and their values (rejects if a value looks like an option),
// and this function checks only option combinations. Invalid combinations and unreadable arguments throw with USAGE. Positional arguments (node and the script's
// paths) are ignored.
/** The selection of a feature check run. */
export type Selection = { feature: string | undefined; commands: string[]; helpers: string[]; without: string[]; features: boolean; allHelpers: boolean; shard: string | undefined };

export function parseSelection(argv: string[]): Selection {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        feature: { type: 'string', multiple: true }, command: { type: 'string', multiple: true }, helper: { type: 'string', multiple: true },
        'without-helper': { type: 'string', multiple: true }, shard: { type: 'string', multiple: true },
        features: { type: 'boolean' }, helpers: { type: 'boolean' }, run: { type: 'boolean' },
      },
    }));
  } catch {
    throw new Error(USAGE);
  }
  const [feature, ...extraFeatures] = values.feature ?? [];
  const commands = values.command ?? [];
  const helpers = values.helper ?? [];
  const without = values['without-helper'] ?? [];
  const [shard, ...extraShards] = values.shard ?? [];
  const features = values.features ?? false;
  const allHelpers = values.helpers ?? false;
  if (extraFeatures.length || extraShards.length || [feature, ...commands, ...helpers, ...without, shard].some(value => value === '')
    || (commands.length && feature === undefined)
    || ((features || allHelpers) && (feature !== undefined || helpers.length > 0))
    || (features && allHelpers) || (without.length && !allHelpers) || (shard !== undefined && !features))
    throw new Error(USAGE);
  return { feature, commands, helpers, without, features, allHelpers, shard };
}

// selectionErrors returns one error for each place where a feature, command, or helper not in the manifest was selected.
/** A verification command of a feature, or the check of a helper. */
export type Check = { id: string; command: string; shard?: string; cwd?: string };
/** The features and helpers of contracts/features.json that a selection reads. */
export type SelectManifest = { features?: { id: string; verification?: Check[] }[]; helpers?: { id: string; command: string }[] };

export function selectionErrors(manifest: SelectManifest, { feature, commands, helpers, without, shard }: Selection): string[] {
  const errors: string[] = [];
  if (shard !== undefined && !SHARDS.includes(shard)) errors.push(`unknown shard ${shard}; give one of ${SHARDS.join(', ')}`);
  const selected = (manifest.features ?? []).find(item => item.id === feature);
  if (feature !== undefined && !selected) errors.push(`unknown feature ${feature}`);
  for (const id of commands)
    if (selected && !(selected.verification ?? []).some(check => check.id === id)) errors.push(`unknown verification command ${feature}/${id}`);
  for (const id of [...helpers, ...without])
    if (!(manifest.helpers ?? []).some(helper => helper.id === id)) errors.push(`unknown helper ${id}`);
  return errors;
}

// selectChecks returns what to run as [{ feature, check }]. A helper's check checks the helper itself, not the feature that uses the helper,
// and it sits under feature id `helpers` (name features/helpers/<id>).
export function selectChecks(manifest: SelectManifest, { feature, commands, helpers, without, features, allHelpers, shard }: Selection): { feature: { id: string }; check: Check }[] {
  const chosen = feature !== undefined || helpers.length > 0;
  const featureSelected = (item: { id: string }) => allHelpers ? false : chosen ? item.id === feature : true;
  const helperSelected = (item: { id: string }) => features ? false : allHelpers ? !without.includes(item.id) : chosen ? helpers.includes(item.id) : true;
  const checks: { feature: { id: string }; check: Check }[] = (manifest.features ?? []).filter(featureSelected)
    .flatMap(item => (item.verification ?? []).filter(check => (commands.length === 0 || commands.includes(check.id)) && (shard === undefined || check.shard === shard))
      .map(check => ({ feature: item, check })));
  for (const helper of (manifest.helpers ?? []).filter(helperSelected))
    checks.push({ feature: { id: 'helpers' }, check: { id: helper.id, command: helper.command } });
  return checks;
}
