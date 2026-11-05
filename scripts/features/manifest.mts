// contracts/features.json, the feature manifest, read against its schema (schema/features.schema.json). The rules the
// schema cannot state (VERSION, the paths on disk, the unique ids, the shards, the fixtures) are in scripts/features/check.mts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRecipeCases, type RecipeCases } from '../json/formats.mts';
import { parseJson, readJsonFile } from '../json/schema.mts';

/** A language of the clients (the declared implementations of config/parity.json). */
export type Language = 'go' | 'php' | 'php-extension' | 'rust' | 'typescript' | 'python';
/** A verification command of a feature. */
export type Verification = { id: string; command: string; shard: string; inputs?: string[]; cwd?: string; environment?: 'linux-runner' };
/** A native test command of a coverage part, per database (or none). */
export type NativeCommand = { runner: 'go' | 'php' | 'cargo' | 'node' | 'python'; test: string; cases: string[]; recipe?: string; symbol?: string; database?: string };
/** The native commands of a coverage part, keyed by database or none. */
export type Commands = Partial<Record<'mysql' | 'postgres' | 'sqlite' | 'none', NativeCommand[]>>;
/** The owner part of a language. */
export type CoverageOwner = { part: string; tests: string[]; inputs?: string[]; commands: Commands };
/** A dependent part of a language. */
export type CoverageDependent = { id: string; language: Language; part: string; tests: string[]; cases: string[]; commands: Commands };
/** The coverage of a feature. */
export type Coverage = { kind: 'database' | 'independent'; cases: string[]; owners: Partial<Record<Language, CoverageOwner>>; dependents: CoverageDependent[] };
/** The vector contract of a feature. */
export type VectorContract = { source: string; required_databases: string[]; minimum_vectors: number };
/** A feature of the manifest. */
export type ManifestFeature = {
  id: string; title: string; title_ko: string; status: 'planned' | 'partial' | 'implemented'; description: string; description_ko: string;
  inputs: { type: string; fields: string[] }; outputs: { type: string; fields: string[] }; state: string[]; errors: { code: string; when: string }[];
  parity: string[]; fixtures: string[]; tests: string[]; docs: string[]; verification: Verification[];
  coverage?: Coverage; public_constraints?: string[]; vector_contract?: VectorContract;
};
/** A helper that several features use. */
export type ManifestHelper = { id: string; paths: string[]; tests: string[]; command: string };
/** contracts/features.json, the shape its schema declares. */
export type FeatureManifest = {
  manifest_version: 1; contract_version: string; source: { read_order: string[]; path_rule: string };
  features: ManifestFeature[]; helpers?: ManifestHelper[];
};

/** The schema of contracts/features.json. */
export const FEATURES_SCHEMA = new URL('./schema/features.schema.json', import.meta.url).pathname;

/** parseFeatures reads the text of a feature manifest against its schema; source names it in the errors. */
export function parseFeatures(text: string, source: string): FeatureManifest {
  return parseJson<FeatureManifest>(text, FEATURES_SCHEMA, source);
}

/** readFeatures reads contracts/features.json of root against its schema; it throws a JsonError or a SchemaError. */
export function readFeatures(root: string): FeatureManifest {
  return withRecipeCases(readJsonFile<FeatureManifest>(resolve(root, 'contracts/features.json'), FEATURES_SCHEMA), root);
}

/** A native command of an owner of a feature that runs a recipe, with the language of the owner and the database that lists it. */
export type OwnerRecipeCommand = { language: string; database: string; recipe: string; command: NativeCommand };

/** ownerRecipeCommands lists the recipe commands of the owners of a feature; every holds when each list of each owner has one, the feature's owners are then recipe owners. */
export function ownerRecipeCommands(feature: ManifestFeature): { every: boolean; commands: OwnerRecipeCommand[] } {
  const owners = Object.entries(feature.coverage?.owners ?? {});
  const found: OwnerRecipeCommand[] = [];
  let every = owners.length > 0;
  for (const [language, owner] of owners) {
    const commands = Object.entries(owner.commands ?? {});
    if (!commands.length || commands.some(([, list]) => !(list ?? []).some(command => command.recipe))) every = false;
    for (const [database, list] of commands) {
      for (const command of list ?? []) {
        if (command.recipe) found.push({ language, database, recipe: command.recipe, command });
      }
    }
  }
  return { every, commands: found };
}

// withRecipeCases fills the cases of each recipe owner from its recipe, the list of the owner (FCV-12), which the manifest
// does not copy; a feature all of whose owners are recipe owners has the cases of those recipes as its coverage cases.
function withRecipeCases(manifest: FeatureManifest, root: string): FeatureManifest {
  const recipes = new Map<string, RecipeCases>();
  for (const feature of manifest.features) {
    const { every, commands } = ownerRecipeCommands(feature);
    const whole = new Set<string>();
    for (const { database, recipe: path, command } of commands) {
      const recipe = recipes.get(path) ?? parseRecipeCases(readFileSync(resolve(root, path), 'utf8'), path);
      recipes.set(path, recipe);
      const on = command.database ?? database;
      command.cases = recipe.cases.filter(item => item.only === undefined || item.only.includes(on)).map(item => item.id);
      command.cases.forEach(id => whole.add(id));
    }
    if (every && feature.coverage) feature.coverage.cases = [...whole];
  }
  return manifest;
}
