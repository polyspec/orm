/**
 * Joins vector lines with LF, CRLF, or alternating CRLF/LF line ends.
 * Mixed line ends have no final line end; the other forms include one.
 */
export function join(lines, crlf, mixed = false) {
  if (mixed) return lines.map((line, i) => (i === lines.length - 1 ? line : line + (i % 2 === 0 ? '\r\n' : '\n'))).join('');
  const end = crlf ? '\r\n' : '\n';
  return lines.join(end) + end;
}
