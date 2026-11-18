// releasedSpecErrors compares the statements of a released spec with the current spec (AGENTS.md:87, T682): an identifier of the
// released spec fails when its body has changed in the current spec, and a retired marker passes. Red stub: no comparison yet.
export function releasedSpecErrors(released: string, current: string): string[] {
  void released;
  void current;
  return [];
}
