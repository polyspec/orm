export class CompilerError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CompilerError';
  }
}
