// contracts/check-inputs.json: the scope, the setup needs and the owner inputs of each make target of CHECK_TARGETS, and
// the paths that no behaviour test selects. It is read against its schema (schema/check-inputs.schema.json); the rules
// the schema cannot state, which compare it with the Makefile and the tracked files, are in scripts/features/owners.mts.
import { resolve } from 'node:path';
import { readJsonFile } from '../json/schema.mts';

/** A make target: owner-check selects an owner target by its inputs or lints; make orm-check runs a suite target whole. */
export type TargetDeclaration = { scope: 'owner' | 'suite'; needs: string[]; inputs?: string[]; lints?: string[] };
/** A path that no behaviour test selects: lint is checked for its form only, suite is tested by make orm-check. */
export type PathDeclaration = { scope: 'lint' | 'suite'; reason: string };
/** contracts/check-inputs.json, the shape its schema declares. */
export type CheckInputs = { comment: string; targets: Record<string, TargetDeclaration>; paths: Record<string, PathDeclaration> };

/** The schema of contracts/check-inputs.json. */
export const CHECK_INPUTS_SCHEMA = new URL('./schema/check-inputs.schema.json', import.meta.url).pathname;

/** readCheckInputs reads contracts/check-inputs.json of root against its schema; it throws a JsonError or a SchemaError. */
export function readCheckInputs(root: string): CheckInputs {
  return readJsonFile<CheckInputs>(resolve(root, 'contracts/check-inputs.json'), CHECK_INPUTS_SCHEMA);
}

/** declaredNeeds is the setup steps each target of contracts/check-inputs.json needs. */
export function declaredNeeds(root: string): Record<string, string[]> {
  return Object.fromEntries(Object.entries(readCheckInputs(root).targets).map(([name, target]) => [name, target.needs]));
}
