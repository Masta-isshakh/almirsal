/**
 * Postgres silently truncates identifiers to 63 bytes, which would make DDL
 * and queries disagree (and lets two long names collide). Shorten
 * deterministically instead, keeping a readable prefix plus a hash.
 */
export function pgIdentifier(name: string): string {
  if (name.length <= 63) return name;
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `${name.slice(0, 54)}_${hash.toString(36)}`;
}
