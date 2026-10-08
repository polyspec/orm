// Globs of repository paths: `*` within one path segment, `**` across segments, `{a,b}` either alternative.
// Owner rules and the document configuration select tracked paths with them.

/** The regular expression source of a glob. */
function globSource(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (glob.startsWith('**/', index)) { source += '(?:.*/)?'; index += 2; }
    else if (glob.startsWith('**', index)) { source += '.*'; index += 1; }
    else if (character === '*') source += '[^/]*';
    else if (character === '{') {
      const end = glob.indexOf('}', index);
      if (end === -1) throw new Error(`the glob ${glob} has a { without a closing }; write {a,b} or escape the character`);
      source += `(?:${glob.slice(index + 1, end).split(',').map(globSource).join('|')})`;
      index = end;
    } else source += character.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return source;
}

/** The regular expression of a glob. */
export function globExpression(glob) {
  return new RegExp(`^${globSource(glob)}$`);
}

/** Whether `file` matches one of `globs`. */
export function matchesAny(globs, file) {
  return globs.some(glob => globExpression(glob).test(file));
}
