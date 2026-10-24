import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedEnvironment } from '../../../tests/environment.mts';
import { runLong, stepLines } from '../../../tests/testcase.mts';
import { readGeneratedModels } from './generated_model_output.mjs';

/** Runs one orm-gen process without inheriting caller variables or applying a wall-clock timeout. */
export async function runGeneratorCommand(bin, args, cwd = process.cwd()) {
  let result;
  let launchError;
  const passed = await runLong(`orm-gen ${args[0] ?? 'command'}`, ({ step }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: isolatedEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const stdoutLines = stepLines(step);
    const stderrLines = stepLines(step);
    child.stdout.on('data', chunk => { stdout.push(chunk); stdoutLines.write(chunk); });
    child.stderr.on('data', chunk => { stderr.push(chunk); stderrLines.write(chunk); });
    child.on('error', error => { launchError = error; reject(error); });
    child.on('close', (status, signal) => {
      stdoutLines.flush();
      stderrLines.flush();
      step(`orm-gen exit ${status ?? `signal ${signal}`}`);
      if (status === null) {
        reject(new Error(`orm-gen ended by ${signal}`));
        return;
      }
      result = { status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      resolve();
    });
  }));
  if (!passed) throw launchError ?? new Error('orm-gen command could not be observed');
  if (result === undefined) throw new Error('orm-gen command ended without an exit status');
  return result;
}

/** Runs one orm-gen source scan in an existing temporary directory and reads its generated models. */
export async function runGeneratorScan({ source, setPath, workDirectory, bin }) {
  const usage = join(workDirectory, 'usage.ts');
  await writeFile(usage, source);
  const output = join(workDirectory, 'models');
  const args = ['gen', '--set', setPath, '--out', output, '--scan', usage];
  const result = await runGeneratorCommand(bin, args);
  if (result.status !== 0) throw new Error(`orm-gen exited with ${result.status}: ${result.stderr}`);
  return await readGeneratedModels(output);
}
