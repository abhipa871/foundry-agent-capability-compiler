import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

// A temporary loopback receiver, not a service. It retains only numeric request counters,
// never OTEL logs, traces, prompt content, reasoning, headers or tool values.
export class ProviderRequestCounters {
  received = 0;
  rejected = 0;
  private points = new Map<string, { name: string; value: number }>();
  private readonly server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2_000_000) throw new Error('Metric body too large.');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const raw = JSON.parse(
        (request.headers['content-encoding'] === 'gzip'
          ? gunzipSync(body, { maxOutputLength: 2_000_000 })
          : body
        ).toString(),
      );
      this.received++;
      this.accept(raw);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    } catch {
      this.rejected++;
      response.writeHead(400);
      response.end();
    }
  });
  accept(raw: any) {
    for (const resource of raw.resourceMetrics ?? [])
      for (const scope of resource.scopeMetrics ?? [])
        for (const metric of scope.metrics ?? []) {
          if (
            ![
              'codex.api_request',
              'codex.websocket.request',
              'codex.websocket.continuation',
            ].includes(metric.name)
          )
            continue;
          // Codex exports cumulative monotonic sums. Repeated flushes must not double count.
          if (Number(metric.sum?.aggregationTemporality) !== 2)
            throw new Error('Expected cumulative provider metrics.');
          for (const point of metric.sum.dataPoints ?? []) {
            const value = Number(point.asInt ?? point.asDouble);
            if (!Number.isSafeInteger(value) || value < 0)
              throw new Error('Invalid request count.');
            const key = createHash('sha256')
              .update(JSON.stringify([metric.name, point.startTimeUnixNano, point.attributes]))
              .digest('hex');
            const previous = this.points.get(key);
            this.points.set(key, {
              name: metric.name,
              value: Math.max(previous?.value ?? 0, value),
            });
          }
        }
  }
  async start() {
    this.server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => this.server.once('listening', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1/metrics`;
  }
  result() {
    return Object.fromEntries(
      ['codex.api_request', 'codex.websocket.request', 'codex.websocket.continuation'].map(
        (name) => [
          name,
          [...this.points.values()]
            .filter((point) => point.name === name)
            .reduce((sum, point) => sum + point.value, 0),
        ],
      ),
    );
  }
  async close() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
