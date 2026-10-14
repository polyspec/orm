// Generates 150 entities with polyspec-orm-build and compiles a crate that calls a getter, a setter, and a chain on
// every model.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is unset; run this through make, which exports it`);
    process.exit(2);
  }
  return value;
};
const target = required('CARGO_TARGET_DIR');
const lease = required('LEASE');
const leases = required('CARGO_LEASES');
const work = mkdtempSync(join(tmpdir(), 'orm-rust-150.'));
const remove = () => rmSync(work, { recursive: true, force: true });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { remove(); process.exit(1); });
try {
  const names = Array.from({ length: 150 }, (_, index) => String(index + 1).padStart(3, '0'));
  const tables = names.map(n => `\ntable entity_${n} {\n  seq i64 identity\n  name varchar(64)\n  revision i32 default 0\n  created_ts datetime(6) default now\n  primary key (seq)\n}`);
  writeFileSync(join(work, 'rust-150.dbs'), `dbspec 1 rust_150\n${tables.join('\n')}\n`);
  writeFileSync(join(work, 'dbspec-set.json'), `${JSON.stringify({ schema: 1, documents: ['rust-150.dbs'] })}\n`);
  mkdirSync(join(work, 'crate/src'), { recursive: true });
  writeFileSync(join(work, 'crate/Cargo.toml'), `[package]
name = "rust-150"
version = "0.0.1"
edition = "2021"
publish = false

[dependencies]
polyspec-orm = { path = "${root}/packages/rust/orm" }

[build-dependencies]
polyspec-orm-build = { path = "${root}/packages/rust/build" }

[workspace]
`);
  writeFileSync(join(work, 'crate/build.rs'), 'fn main() {\n    polyspec_orm_build::Builder::set("../dbspec-set.json").scan("src").generate();\n}\n');
  const calls = names.map(n => `    let m = model::Entity${n}::new().set_name("x").revision(1).and_gt_seq(0);\n    let _ = m.get_name();`);
  writeFileSync(join(work, 'crate/src/lib.rs'), `polyspec_orm::models!();\npub fn touch() {\n${calls.join('\n')}\n}\n`);
  copyFileSync(join(root, 'packages/rust/Cargo.lock'), join(work, 'crate/Cargo.lock'));
  // The generated crate shares the target directory of the workspace, so orm and its dependencies are not compiled
  // again; it builds into the shared Rust target directory and so under its lease.
  const checked = spawnSync(lease, ['run', leases, 'exclusive', '--wait', '--', 'cargo', 'check', '--manifest-path', join(work, 'crate/Cargo.toml')], {
    cwd: root, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target, PATH: `${join(homedir(), '.cargo/bin')}${delimiter}${process.env['PATH'] ?? ''}` },
  });
  if (checked.status !== 0) process.exitCode = checked.status ?? 1;
  else console.log('rust-150: 150 generated entities compiled');
} finally {
  remove();
}
