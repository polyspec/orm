import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const languages = ['go', 'php', 'rust', 'typescript'];
export const databases = ['mysql', 'postgres', 'sqlite'];

// A successful command must report the cases it actually executed. A declared
// test path or an old output file is not execution evidence.
export function checkCoverage(manifest, reports) {
  const errors = [];
  const ids = new Set();
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
    const expectedDatabases = coverage.kind === 'database' ? databases : ['none'];
    for (const language of languages) {
      const status = feature.clients?.[language];
      if (status !== 'pass' && status !== 'partial') continue;
      for (const database of expectedDatabases) {
        const key = `${feature.id}/${language}/${database}`;
        const executions = reports[key];
        if (!executions) { errors.push(`${key}: no executed report`); continue; }
        if (!Array.isArray(executions) || executions.length !== 2) {
          errors.push(`${key}: exactly two executions required`);
          continue;
        }
        for (const report of executions) {
          if (!report || report.feature !== feature.id || report.language !== language || report.database !== database)
            errors.push(`${key}: report identity differs`);
          if (report?.success !== true) errors.push(`${key}: execution failed`);
          const seen = report?.cases;
          const values = report?.results;
          if (!Array.isArray(seen) || new Set(seen).size !== seen.length ||
              seen.length !== coverage.cases.length ||
              coverage.cases.some(id => !seen.includes(id)) ||
              !Array.isArray(values) || values.length !== coverage.cases.length ||
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
    }
    if (feature.status === 'implemented' && languages.some(language => feature.clients?.[language] !== 'pass'))
      errors.push(`${feature.id}: implemented feature lacks a passing client`);
  }
  for (const key of Object.keys(reports)) {
    const [feature, language, database, extra] = key.split('/');
    const contract = manifest.features?.find(item => item.id === feature);
    const expectedDatabases = contract?.coverage?.kind === 'database' ? databases : ['none'];
    if (extra || !contract || !languages.includes(language) || !expectedDatabases.includes(database) ||
        !['pass', 'partial'].includes(contract.clients?.[language]))
      errors.push(`${key}: undeclared execution report`);
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
    const required = coverage.kind === 'database' ? databases : ['none'];
    for (const language of languages) {
      if (!['pass', 'partial'].includes(feature.clients?.[language])) continue;
      for (const database of required) {
        const key = `${feature.id}/${language}/${database}`;
        const command = coverage.commands?.[language]?.[database];
        if (typeof command !== 'string' || !command.trim()) {
          errors.push(`${key}: no executable command`);
          continue;
        }
        reports[key] = [];
        for (let attempt = 1; attempt <= 2; attempt++) {
          const result = await run(command, root, timeoutMs);
          if (result.error) { errors.push(`${key} run ${attempt}: ${result.error}`); break; }
          reports[key].push(result.value);
        }
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
