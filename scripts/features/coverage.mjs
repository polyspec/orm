import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const languages = ['go', 'php', 'rust', 'typescript'];
export const databases = ['mysql', 'postgres', 'sqlite'];

const validPart = part => typeof part === 'string' && part !== '' &&
  part.split('/').every(segment => segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_.-]+$/.test(segment));
const validTests = (part, tests) => Array.isArray(tests) && tests.length > 0 &&
  new Set(tests).size === tests.length && tests.every(file =>
    typeof file === 'string' && file.startsWith(part + '/') &&
    file.slice(part.length + 1).split('/').every(segment =>
      segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_.-]+$/.test(segment)));

function requirements(feature, errors) {
  const coverage = feature.coverage;
  const required = coverage.kind === 'database' ? databases : ['none'];
  const items = [];
  if (!coverage.owners || typeof coverage.owners !== 'object' || Array.isArray(coverage.owners))
    errors.push(`${feature.id}: missing owners`);
  for (const language of Object.keys(coverage.owners ?? {})) {
    if (!languages.includes(language) || !['pass', 'partial'].includes(feature.clients?.[language]))
      errors.push(`${feature.id}/owner/${language}: undeclared owning client`);
  }
  if (!Array.isArray(coverage.consumers)) errors.push(`${feature.id}: missing consumers declaration`);
  for (const language of languages) {
    if (!['pass', 'partial'].includes(feature.clients?.[language])) continue;
    const owner = coverage.owners?.[language];
    if (!owner || !validPart(owner.part) || !owner.part.startsWith(`clients/${language}/`) && owner.part !== `clients/${language}`) {
      errors.push(`${feature.id}/owner/${language}: missing owning client part`);
      continue;
    }
    if (!validTests(owner.part, owner.tests) || owner.tests.some(file =>
      (Array.isArray(coverage.consumers) ? coverage.consumers : []).some(consumer =>
        consumer?.language === language && typeof consumer.part === 'string' &&
        file.startsWith(consumer.part + '/')))) {
      errors.push(`${feature.id}/owner/${language}: tests must reside in owning part`);
      continue;
    }
    for (const database of required) items.push({ key: `${feature.id}/owner/${language}/${database}`,
      role: 'owner', language, database, part: owner.part, tests: owner.tests, cases: coverage.cases,
      command: owner.commands?.[database] });
  }
  const consumerIds = new Set();
  for (const consumer of Array.isArray(coverage.consumers) ? coverage.consumers : []) {
    if (!consumer || typeof consumer.id !== 'string' || !consumer.id || consumerIds.has(consumer.id)) {
      errors.push(`${feature.id}: duplicate or missing consumer id`);
      continue;
    }
    consumerIds.add(consumer.id);
    if (!languages.includes(consumer.language) || !['pass', 'partial'].includes(feature.clients?.[consumer.language]) ||
        !validPart(consumer.part) || consumer.part === 'tests/conformance' ||
        consumer.part.startsWith('tests/conformance/') ||
        consumer.part === coverage.owners?.[consumer.language]?.part ||
        !Array.isArray(consumer.cases) || consumer.cases.length === 0 ||
        new Set(consumer.cases).size !== consumer.cases.length ||
        consumer.cases.some(id => typeof id !== 'string' || !id) ||
        !validTests(consumer.part, consumer.tests) ||
        consumer.tests.some(file => coverage.owners?.[consumer.language]?.tests?.includes(file))) {
      errors.push(`${feature.id}/consumer/${consumer.id}: invalid consuming part, tests, or cases`);
      continue;
    }
    for (const database of required) items.push({ key: `${feature.id}/consumer/${consumer.id}/${consumer.language}/${database}`,
      role: 'consumer', consumer: consumer.id, language: consumer.language, database,
      part: consumer.part, tests: consumer.tests, cases: consumer.cases, command: consumer.commands?.[database] });
  }
  return items;
}

// A successful command must report the cases it actually executed. A declared
// test path or an old output file is not execution evidence.
export function checkCoverage(manifest, reports) {
  const errors = [];
  const ids = new Set();
  const expected = new Set();
  for (const feature of manifest.features ?? []) {
    if (ids.has(feature.id)) errors.push(`duplicate feature ${feature.id}`);
    ids.add(feature.id);
    const coverage = feature.coverage;
    if (!coverage || !['database', 'independent'].includes(coverage.kind)) {
      errors.push(`${feature.id}: missing coverage kind`);
      continue;
    }
    if (!Array.isArray(coverage.cases) || coverage.cases.length === 0 ||
        new Set(coverage.cases).size !== coverage.cases.length ||
        coverage.cases.some(id => typeof id !== 'string' || !id)) {
      errors.push(`${feature.id}: coverage cases must be distinct nonempty IDs`);
      continue;
    }
    for (const item of requirements(feature, errors)) {
        const { key, language, database } = item;
        expected.add(key);
        const executions = reports[key];
        if (!executions) { errors.push(`${key}: no executed report`); continue; }
        if (!Array.isArray(executions) || executions.length !== 2) {
          errors.push(`${key}: exactly two executions required`);
          continue;
        }
        for (const report of executions) {
          if (!report || report.feature !== feature.id || report.language !== language || report.database !== database ||
              report.role !== item.role || report.part !== item.part ||
              (item.role === 'consumer' && report.consumer !== item.consumer))
            errors.push(`${key}: report identity differs`);
          if (!Array.isArray(report?.tests) || report.tests.length !== item.tests.length ||
              new Set(report.tests).size !== report.tests.length ||
              item.tests.some(file => !report.tests.includes(file)))
            errors.push(`${key}: executed test paths differ from owning or consuming part`);
          if (report?.success !== true) errors.push(`${key}: execution failed`);
          const seen = report?.cases;
          const values = report?.results;
          if (!Array.isArray(seen) || new Set(seen).size !== seen.length ||
              seen.length !== item.cases.length ||
              item.cases.some(id => !seen.includes(id)) ||
              !Array.isArray(values) || values.length !== item.cases.length ||
              new Set(values.map(value => value.id)).size !== values.length ||
              values.some(value => !seen.includes(value.id) || typeof value.value_json !== 'string' ||
                !value.value_json || !validJSON(value.value_json)))
            errors.push(`${key}: executed case IDs differ from contract`);
          if (coverage.kind === 'database' &&
              (typeof report.state_before !== 'string' || !report.state_before ||
               report.state_before !== report.state_after))
            errors.push(`${key}: database state changed or was not observed`);
        }
        if (!isDeepStrictEqual(executions[0]?.results, executions[1]?.results))
          errors.push(`${key}: results changed on repeated execution`);
        if (coverage.kind === 'database' && executions[0]?.state_before !== executions[1]?.state_before)
          errors.push(`${key}: database state changed between executions`);
    }
    if (feature.status === 'implemented' && languages.some(language => feature.clients?.[language] !== 'pass'))
      errors.push(`${feature.id}: implemented feature lacks a passing client`);
  }
  for (const key of Object.keys(reports)) {
    if (!expected.has(key)) errors.push(`${key}: undeclared execution report`);
  }
  return errors;
}

function validJSON(value) {
  try { JSON.parse(value); return true; }
  catch { return false; }
}

function run(command, cwd, timeoutMs) {
  return new Promise((finish) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: process.env, detached: true });
    let output = '';
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({ error, value });
    };
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => done(error.message));
    child.on('close', code => {
      if (code !== 0) return done(`exit ${code}: ${output.trim()}`);
      try { done(null, JSON.parse(output)); }
      catch (error) { done(`invalid JSON report: ${error.message}`); }
    });
    const timer = setTimeout(() => {
      process.kill(-child.pid, 'SIGKILL');
      done(`timeout after ${timeoutMs} ms`);
    }, timeoutMs);
  });
}

export async function executeCoverage(manifest, root, timeoutMs = 600_000) {
  const reports = {};
  const errors = [];
  for (const feature of manifest.features ?? []) {
    const coverage = feature.coverage;
    if (!coverage || !['database', 'independent'].includes(coverage.kind)) continue;
    for (const item of requirements(feature, errors)) {
        const { key, command } = item;
        if (typeof command !== 'string' || !command.trim()) {
          errors.push(`${key}: no executable command`);
          continue;
        }
        const cwd = resolve(root, item.part);
        if (!cwd.startsWith(resolve(root) + '/')) {
          errors.push(`${key}: invalid part directory`);
          continue;
        }
        try {
          if (await realpath(cwd) !== cwd) throw new Error('symbolic path');
          for (const file of item.tests) {
            const target = resolve(root, file);
            if (await realpath(target) !== target) throw new Error(`symbolic test path ${file}`);
          }
        } catch (error) {
          errors.push(`${key}: unavailable part directory: ${error.message}`);
          continue;
        }
        reports[key] = [];
        for (let attempt = 1; attempt <= 2; attempt++) {
          const result = await run(command, cwd, timeoutMs);
          if (result.error) { errors.push(`${key} run ${attempt}: ${result.error}`); break; }
          reports[key].push(result.value);
        }
    }
  }
  return [...errors, ...checkCoverage(manifest, reports)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const manifest = JSON.parse(await readFile(resolve(root, 'contracts/features.json'), 'utf8'));
  const errors = await executeCoverage(manifest, root);
  for (const error of errors) console.error(`feature coverage: ${error}`);
  if (errors.length) process.exitCode = 1;
  else console.log(`feature coverage: ${manifest.features.length} contracts executed`);
}
