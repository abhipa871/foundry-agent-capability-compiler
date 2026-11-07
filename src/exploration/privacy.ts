export type PrivacyMode = 'minimal' | 'standard' | 'full';
const sensitive =
  /token|secret|password|authorization|api[_-]?key|credential|email|phone|address|document|prompt|content/i;
export function safeText(value: string): string {
  return value
    .slice(0, 1000)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|api[_-]?key[=: ]+)\S+)/gi, '[redacted]');
}
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[omitted]';
  if (typeof value === 'string') return safeText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.length > 100 ? '[omitted]' : value.map((item) => redact(item, depth + 1));
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) return '[omitted]';
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      sensitive.test(key) ? '[redacted]' : redact(item, depth + 1),
    ]),
  );
}
// Structural export deliberately omits values and prompts. Replay evidence is a separate
// explicitly authorized channel; redacted sentinel strings are never executable bindings.
export function structuralEvent(event: {
  eventId: string;
  operation: string;
  adapterVersion: string;
  effect: string;
  status: string;
  startMs: number;
  endMs: number;
  args: Record<string, { source: string }>;
}) {
  return {
    eventId: event.eventId,
    operation: event.operation,
    adapterVersion: event.adapterVersion,
    effect: event.effect,
    status: event.status,
    startMs: event.startMs,
    endMs: event.endMs,
    args: Object.fromEntries(
      Object.entries(event.args).map(([name, arg]) => [name, { source: arg.source }]),
    ),
  };
}
