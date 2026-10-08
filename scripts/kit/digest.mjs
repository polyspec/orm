// The hexadecimal digest of bytes or of a file.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The hexadecimal digest of `data` (text or bytes) by `algorithm`. */
export const digest = (algorithm, data) => createHash(algorithm).update(data).digest('hex');

/** The sha256 of `data`. */
export const sha256 = data => digest('sha256', data);

/** The digest of the file `file` by `algorithm`, sha256 when absent. */
export const fileDigest = (file, algorithm = 'sha256') => digest(algorithm, readFileSync(file));
