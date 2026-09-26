import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
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
const checkerRoot = resolve(new URL('../..', import.meta.url).pathname);

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
  if (!Array.isArray(coverage.dependents)) errors.push(`${feature.id}: missing dependents declaration`);
  for (const language of languages) {
    if (!['pass', 'partial'].includes(feature.clients?.[language])) continue;
    const owner = coverage.owners?.[language];
    if (!owner || !validPart(owner.part) || !owner.part.startsWith(`clients/${language}/`) && owner.part !== `clients/${language}`) {
      errors.push(`${feature.id}/owner/${language}: missing owning client part`);
      continue;
    }
    if (!validTests(owner.part, owner.tests) || owner.tests.some(file =>
      (Array.isArray(coverage.dependents) ? coverage.dependents : []).some(dependent =>
        dependent?.language === language && typeof dependent.part === 'string' &&
        file.startsWith(dependent.part + '/')))) {
      errors.push(`${feature.id}/owner/${language}: tests must reside in owning part`);
      continue;
    }
    for (const database of required) items.push({ key: `${feature.id}/owner/${language}/${database}`,
      role: 'owner', language, database, part: owner.part, tests: owner.tests, cases: coverage.cases,
      command: owner.commands?.[database] });
  }
  const dependentIds = new Set();
  for (const dependent of Array.isArray(coverage.dependents) ? coverage.dependents : []) {
    if (!dependent || typeof dependent.id !== 'string' || !dependent.id || dependentIds.has(dependent.id)) {
      errors.push(`${feature.id}: duplicate or missing dependent id`);
      continue;
    }
    dependentIds.add(dependent.id);
    if (!languages.includes(dependent.language) || !['pass', 'partial'].includes(feature.clients?.[dependent.language]) ||
        !validPart(dependent.part) || dependent.part === 'tests/conformance' ||
        dependent.part.startsWith('tests/conformance/') ||
        dependent.part === coverage.owners?.[dependent.language]?.part ||
        !Array.isArray(dependent.cases) || dependent.cases.length === 0 ||
        new Set(dependent.cases).size !== dependent.cases.length ||
        dependent.cases.some(id => typeof id !== 'string' || !id) ||
        !validTests(dependent.part, dependent.tests) ||
        dependent.tests.some(file => coverage.owners?.[dependent.language]?.tests?.includes(file))) {
      errors.push(`${feature.id}/dependent/${dependent.id}: invalid dependent part, tests, or cases`);
      continue;
    }
    for (const database of required) items.push({ key: `${feature.id}/dependent/${dependent.id}/${dependent.language}/${database}`,
      role: 'dependent', dependent: dependent.id, language: dependent.language, database,
      part: dependent.part, tests: dependent.tests, cases: dependent.cases, command: dependent.commands?.[database] });
  }
  return items;
}

// Reports in this function are constructed by executeCoverage from native test
// events and the checker's database reader, never parsed from test JSON.
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
              (item.role === 'dependent' && report.dependent !== item.dependent))
            errors.push(`${key}: report identity differs`);
          if (!Array.isArray(report?.tests) || report.tests.length !== item.tests.length ||
              new Set(report.tests).size !== report.tests.length ||
              item.tests.some(file => !report.tests.includes(file)))
            errors.push(`${key}: executed test paths differ from owning or dependent part`);
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

function run(program, args, cwd, timeoutMs) {
  return new Promise((finish) => {
    const child = spawn(program, args, { cwd, env: process.env, detached: true });
    let output = '';
    let settled = false;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({ error, value });
    };
    const append = chunk => {
      output += chunk;
      if (output.length > 1_000_000) stop();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => done(error.message));
    child.on('close', code => {
      if (output.length > 1_000_000) return done('test output exceeds 1000000 characters');
      if (code !== 0) return done(`exit ${code}: ${output.trim()}`);
      done(null, output);
    });
    const timer = setTimeout(() => {
      stop();
      done(`timeout after ${timeoutMs} ms`);
    }, timeoutMs);
  });
}

async function nativeTest(item, command, root) {
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      !item.tests.includes(command.test) || !Array.isArray(command.cases) ||
      command.cases.length === 0 || new Set(command.cases).size !== command.cases.length ||
      command.cases.some(id => !item.cases.includes(id)) ||
      !['node', 'php', 'go', 'cargo'].includes(command.runner) ||
      (item.language === 'typescript' && command.runner !== 'node') ||
      (item.language === 'php' && command.runner !== 'php') ||
      (item.language === 'go' && command.runner !== 'go') ||
      (item.language === 'rust' && command.runner !== 'cargo') ||
      (item.database !== 'none' && (typeof command.dsn_env !== 'string' ||
        !/^[A-Z][A-Z0-9_]*$/.test(command.dsn_env))) ||
      Object.keys(command).some(key => !['runner', 'test', 'cases', 'dsn_env'].includes(key)))
    throw new Error('invalid native test command');
  const testPath = resolve(root, command.test);
  if (await realpath(testPath) !== testPath) throw new Error('symbolic test path');
  const extension = extname(testPath);
  if ((command.runner === 'node' && extension !== '.mjs') ||
      (command.runner === 'php' && extension !== '.php') ||
      (command.runner === 'go' && extension !== '.go') ||
      (command.runner === 'cargo' && extension !== '.rs'))
    throw new Error('invalid native test file extension');
  if (command.runner === 'node' || command.runner === 'php')
    return { program: command.runner, args: [testPath, ...command.cases], format: 'case' };
  const source = await readFile(testPath, 'utf8');
  for (const id of command.cases) {
    const short = id.split('::').at(-1);
    const pattern = command.runner === 'go' ? `\\bfunc\\s+${short}\\s*\\(` : `\\bfn\\s+${short}\\s*\\(`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(short) || !new RegExp(pattern).test(source))
      throw new Error(`case ${id} is absent from declared test file`);
  }
  if (command.runner === 'go')
    return { program: 'go', args: ['test', '-json', '-run', `^(${command.cases.join('|')})$`, '.'],
      cwd: dirname(testPath), format: 'go' };
  let crate = dirname(testPath);
  while (crate.startsWith(resolve(root, item.part))) {
    try { await realpath(resolve(crate, 'Cargo.toml')); break; }
    catch { crate = dirname(crate); }
  }
  if (!crate.startsWith(resolve(root, item.part))) throw new Error('Rust test has no owning Cargo manifest');
  return { program: 'cargo', args: ['test', '--manifest-path', resolve(crate, 'Cargo.toml')],
    cwd: crate, format: 'cargo' };
}

function observedCases(format, output, requested) {
  const seen = new Set();
  const add = id => {
    if (seen.has(id)) throw new Error(`duplicate observed case ${id}`);
    seen.add(id);
  };
  if (format === 'case') {
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const match = /^CASE ([A-Za-z0-9_.-]+) PASS$/.exec(line);
      if (!match) throw new Error(`unexpected test output: ${line}`);
      add(match[1]);
    }
  } else if (format === 'go') {
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error('invalid Go test event'); }
      if (event.Action === 'pass' && event.Test) add(event.Test);
    }
  } else {
    for (const line of output.split(/\r?\n/)) {
      const match = /^test ([A-Za-z0-9_:]+) \.\.\. ok$/.exec(line);
      if (match) add(match[1]);
    }
  }
  if (seen.size !== requested.length || requested.some(id => !seen.has(id)))
    throw new Error(`observed cases ${[...seen].join(',')} differ from ${requested.join(',')}`);
  return requested.map(id => ({ id, value_json: 'true' }));
}

async function state(database, dsn, timeoutMs) {
  const result = await run('go', ['run', './tests/conformance/check', 'state', '-driver', database,
    '-dsn', dsn], checkerRoot, timeoutMs);
  if (result.error) throw new Error(`database state reader: ${result.error.replaceAll(dsn, '[redacted]')}`);
  const match = new RegExp(`^${database} state ([a-f0-9]{64})\\n$`).exec(result.value);
  if (!match) throw new Error('database state reader returned an invalid digest');
  return match[1];
}

export async function executeCoverage(manifest, root, timeoutMs = 600_000) {
  const reports = {};
  const errors = [];
  for (const feature of manifest.features ?? []) {
    const coverage = feature.coverage;
    if (!coverage || !['database', 'independent'].includes(coverage.kind)) continue;
    for (const item of requirements(feature, errors)) {
        const { key, command } = item;
        if (!command) {
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
        let native;
        try {
          if (!Array.isArray(command) || command.length !== item.tests.length ||
              new Set(command.map(entry => entry?.test)).size !== item.tests.length ||
              item.tests.some(test => !command.some(entry => entry?.test === test)) ||
              command.flatMap(entry => entry?.cases ?? []).length !== item.cases.length ||
              new Set(command.flatMap(entry => entry?.cases ?? [])).size !== item.cases.length ||
              item.cases.some(id => !command.some(entry => entry?.cases?.includes(id))) ||
              (item.database !== 'none' && new Set(command.map(entry => entry?.dsn_env)).size !== 1))
            throw new Error('invalid native test command');
          native = await Promise.all(command.map(entry => nativeTest(item, entry, root)));
        }
        catch (error) { errors.push(`${key}: ${error.message}`); continue; }
        const dsnEnv = command[0].dsn_env;
        const dsn = item.database === 'none' ? null : process.env[dsnEnv];
        if (item.database !== 'none' && !dsn) {
          errors.push(`${key}: missing database DSN in ${dsnEnv}`);
          continue;
        }
        reports[key] = [];
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const stateBefore = dsn ? await state(item.database, dsn, timeoutMs) : null;
            const results = [];
            for (let index = 0; index < native.length; index++) {
              const spec = native[index];
              const entry = command[index];
              let output = '';
              for (const id of spec.format === 'cargo' ? entry.cases : [null]) {
                const args = spec.format === 'cargo' ? [...spec.args, id, '--', '--exact'] : spec.args;
                const result = await run(spec.program, args, spec.cwd ?? cwd, timeoutMs);
                if (result.error) throw new Error(result.error);
                output += result.value + '\n';
              }
              results.push(...observedCases(spec.format, output, entry.cases));
            }
            const stateAfter = dsn ? await state(item.database, dsn, timeoutMs) : null;
            reports[key].push({ feature: feature.id, role: item.role, language: item.language,
              database: item.database, part: item.part, tests: item.tests, success: true,
              cases: item.cases, results, ...(item.dependent ? { dependent: item.dependent } : {}),
              ...(dsn ? { state_before: stateBefore, state_after: stateAfter } : {}) });
          } catch (error) {
            const message = String(error.message);
            errors.push(`${key} run ${attempt}: ${dsn ? message.replaceAll(dsn, '[redacted]') : message}`);
            break;
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
