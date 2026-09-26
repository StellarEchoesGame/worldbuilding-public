const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

function hostPart(host: string): string | null {
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(host);
  if (bracketed !== null) return bracketed[1] ?? null;
  if (host === '::1') return host;
  const m = /^([^:]+)(?::(\d{1,5}))?$/u.exec(host);
  return m === null ? null : (m[1] ?? null);
}

/** Loopback host names and addresses the UI may bind to or be addressed by: 127.0.0.0/8, ::1, localhost (brackets and a :port allowed). */
export function loopbackOnly(host: string): boolean {
  const name = hostPart(host.trim() === host ? host : '');
  if (name === null) return false;
  const lower = name.toLowerCase();
  if (lower === 'localhost' || lower === 'localhost.' || lower === '::1') return true;
  const v4 = IPV4_LOOPBACK.exec(lower);
  return v4 !== null && v4.slice(1).every((octet) => Number(octet) <= 255);
}
