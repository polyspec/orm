// cargoTarget은 Makefile이 선언하고 export하는 Rust target directory CARGO_TARGET_DIR이다. cargo는 그
// directory에 build하므로 cargo가 만든 program의 경로는 여기서 얻는다. 값이 없으면 실패한다: 다른
// directory를 짐작하면 오래된 program을 실행하거나 없는 file을 찾는다.
export function cargoTarget() {
  const target = process.env.CARGO_TARGET_DIR;
  if (!target) throw new Error('CARGO_TARGET_DIR is unset; run this through make, which exports it');
  return target;
}
