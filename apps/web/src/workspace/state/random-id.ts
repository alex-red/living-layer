type IdSource = Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string };

/**
 * A v4 UUID. `crypto.randomUUID` exists only in a secure context, so the lab
 * opened over the network on plain HTTP builds one from random bytes.
 */
export function randomId(source: IdSource = crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const b = source.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
