// Release numbers: reading the numeric part of a version and putting versions in order.

/** The order of two lists of numbers, a missing number counting as 0: negative when `left` is lower, 0 when equal. */
export function compareParts(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The numbers of a version that is only dotted numbers, as `1.2.3` or `2024.1`; null for any other text. */
export function dottedParts(version) {
  return /^\d+(?:\.\d+)*$/.test(version) ? version.split('.').map(Number) : null;
}

/** The numeric release of a version, without a leading `v`; null when the version does not start with `<major>.<minor>.<patch>`. */
export function versionParts(version) {
  const match = String(version).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

/** Whether a version is a prerelease: a suffix after `-`, as in `10.0.0-rc.2` of npm and `2.0.0-beta1` of Composer. */
export function isPrerelease(version) {
  return /^v?\d+\.\d+\.\d+-/.test(String(version));
}

/** Whether `current` is an older release than `latest`; versions that are not numeric compare as strings. */
export function older(current, latest) {
  const left = versionParts(current);
  const right = versionParts(latest);
  if (!left || !right) return String(current).replace(/^v/, '') !== String(latest).replace(/^v/, '');
  return compareParts(left, right) < 0;
}

/** The stable releases of a list of versions, highest first. */
export function stableDescending(versions) {
  return versions.filter(version => !isPrerelease(version) && versionParts(version))
    .sort((left, right) => compareParts(versionParts(right), versionParts(left)));
}
