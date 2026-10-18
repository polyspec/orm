// cargoTarget is the Rust target directory CARGO_TARGET_DIR that the Makefile declares and exports. cargo builds into the
// directory, so the path of the program cargo built is obtained here. It fails when the value is missing: guessing another
// directory would run an old program or find a file that does not exist.
export function cargoTarget() {
  const target = process.env.CARGO_TARGET_DIR;
  if (!target) throw new Error('CARGO_TARGET_DIR is unset; run this through make, which exports it');
  return target;
}
