#!/usr/bin/env node
// Checks the vendored files of kit in this checkout against `.kit/kit.lock.json`, without a network (`make kit-check`):
// every file of the vendored directories has the sha256 that the lock records, and no other file is in them.
//
//   node scripts/kit/kit-check.mjs
//
// A change of a vendored file is made in kit and copied with `make kit-sync`, never in the checkout; the check names
// each file whose hash differs, each file that is missing and each unexpected file, with its expected and actual value.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { validate } from './schema-validate.mjs';
import { isMain, ROOT } from './paths.mjs';
import { fileDigest } from './digest.mjs';
import { readJson } from './files.mjs';
import { gitResult } from './git.mjs';

export const LOCK = '.kit/kit.lock.json';

/** The vendored directories of the checkout at `root`, from kit.json. */
export function vendoredDirectories(root) {
  return readJson(root, 'kit.json').vendored;
}

/** Every file below `directory` (relative to root), sorted; a missing directory has none. */
export function walk(root, directory) {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return [];
  const files = [];
  const visit = (relative) => {
    for (const entry of readdirSync(path.join(root, relative)).sort()) {
      const next = path.join(relative, entry);
      if (statSync(path.join(root, next)).isDirectory()) visit(next);
      else files.push(next.split(path.sep).join('/'));
    }
  };
  visit(directory);
  return files;
}

/**
 * The findings of the configuration of `root` against the schemas of scripts/kit/schema: each config/<name>.json that the
 * repository has must validate against scripts/kit/schema/<name>.schema.json; an error names the file, the location and the rule.
 */
export function checkConfig(root) {
  const directory = path.join(root, 'scripts/kit/schema');
  if (!existsSync(directory)) return [];
  const found = [];
  for (const schemaFile of readdirSync(directory).filter(name => name.endsWith('.schema.json')).sort()) {
    const name = schemaFile.slice(0, -'.schema.json'.length);
    const config = `config/${name}.json`;
    // A repository declares a configuration by having its file; the schema checks the declared file only.
    if (!existsSync(path.join(root, config))) continue;
    const schema = readJson(directory, schemaFile);
    const value = readJson(root, config);
    for (const error of validate(value, schema)) found.push(`${config}: ${error}. Rule: scripts/kit/schema/${schemaFile}`);
  }
  return found;
}

/** The findings of the vendored files of `root` against its lock: a list of lines, empty when they match. */
// The repository that holds the source of the vendored files has no lock: it does not vendor itself. Its origin is the
// repository of kit.json, so the check reads only its configuration.
export function isSource(root) {
  const declared = readJson(path.join(root, 'kit.json')).repository;
  const origin = gitResult(root, 'remote', 'get-url', 'origin');
  return origin.status === 0 && origin.stdout.trim() === declared;
}

export function check(root) {
  const config = checkConfig(root);
  if (existsSync(path.join(root, 'kit.json')) && isSource(root)) return config;
  const lockFile = path.join(root, LOCK);
  if (!existsSync(lockFile)) return [...config, `${LOCK}: the lock is missing. Fix: make kit-sync KIT_TAG=<tag>`];
  const lock = readJson(lockFile);
  const found = [];
  const present = new Set(vendoredDirectories(root).flatMap(directory => walk(root, directory)));
  if (existsSync(path.join(root, 'kit.json'))) present.add('kit.json');
  for (const [file, expected] of Object.entries(lock.files)) {
    if (!present.has(file)) {
      found.push(`${file}: the vendored file is missing; expected sha256 ${expected}. Fix: make kit-sync KIT_TAG=${lock.tag}`);
      continue;
    }
    const actual = fileDigest(path.join(root, file));
    if (actual !== expected) found.push(`${file}: sha256 is ${actual}, the lock records ${expected}. Fix: make kit-sync KIT_TAG=${lock.tag}`);
  }
  for (const file of [...present].sort()) {
    if (!(file in lock.files)) found.push(`${file}: the file is not in the lock. Fix: make kit-sync KIT_TAG=${lock.tag}`);
  }
  return [...config, ...found];
}

if (isMain(import.meta.url)) {
  const root = ROOT;
  const found = check(root);
  for (const line of found) console.error(`[kit-check] ${line}`);
  if (found.length) {
    console.error(`[kit-check] ${found.length} findings in the vendored files of kit`);
    process.exit(1);
  }
  console.log(`[kit-check] the vendored files match ${LOCK}`);
}
