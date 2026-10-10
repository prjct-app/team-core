/** Rejects text over a byte budget instead of silently cutting it. */
export function bounded(value: string, bytes: number, label = 'text'): string {
  if (Buffer.byteLength(value, 'utf8') > bytes) throw new Error(`${label} exceeds ${bytes} UTF-8 bytes.`);
  return value;
}

/**
 * Teammate text is shown in a terminal and sent to a model: strip terminal
 * control sequences, redact obvious credentials, cap the size. Best-effort
 * redaction, not a secret detector.
 */
export function clean(value: string, bytes = 4096): string {
  const safe = value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[^\s]+)\b/gi, '[redacted]')
    .replace(/\b(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
  const encoded = Buffer.from(safe, 'utf8');
  // A cut through a multi-byte character decodes to U+FFFD: drop that tail.
  return encoded.length <= bytes ? safe : encoded.subarray(0, bytes).toString('utf8').replace(/�+$/, '');
}

/** "3m", "40s", "2h": how long a teammate has been in its current state. */
export function ago(since: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
