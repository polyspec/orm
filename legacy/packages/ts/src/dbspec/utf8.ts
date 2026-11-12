/** Whether `error` is the refusal of a fatal TextDecoder: the bytes it decoded are not valid UTF-8. */
export function invalidEncoding(error: unknown): boolean {
  return error instanceof TypeError && 'code' in error && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA';
}
