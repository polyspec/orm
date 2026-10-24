/** Binds one shared case deadline to a test suite's vector registrar. */
export function vectorRegistrar(registerCase, deadline) {
  return (name, body) => registerCase(name, deadline, body);
}
