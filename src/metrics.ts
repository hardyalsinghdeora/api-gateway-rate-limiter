import type { BreakerState } from './breaker.js';

export type Labels = Readonly<Record<string, string>>;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Stable text for a label set; it doubles as the series key. */
function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return '';
  return `{${entries.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(',')}}`;
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {}

  abstract render(): string;

  protected header(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n`;
  }
}

class Counter extends Metric {
  private readonly series = new Map<string, number>();

  constructor(name: string, help: string, type: 'counter' | 'gauge' = 'counter') {
    super(name, help, type);
  }

  inc(labels: Labels, by = 1): void {
    const key = formatLabels(labels);
    this.series.set(key, (this.series.get(key) ?? 0) + by);
  }

  set(labels: Labels, value: number): void {
    this.series.set(formatLabels(labels), value);
  }

  render(): string {
    return this.header() + [...this.series].map(([key, value]) => `${this.name}${key} ${value}\n`).join('');
  }
}

interface HistogramSeries {
  labels: Labels;
  /** Cumulative counts, one per bucket, in bucket order. */
  counts: number[];
  sum: number;
  count: number;
}

class Histogram extends Metric {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    name: string,
    help: string,
    private readonly buckets: readonly number[],
  ) {
    super(name, help, 'histogram');
  }

  observe(labels: Labels, value: number): void {
    const key = formatLabels(labels);
    let entry = this.series.get(key);
    if (entry === undefined) {
      entry = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    this.buckets.forEach((bound, i) => {
      if (value <= bound) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
    });
    entry.sum += value;
    entry.count += 1;
  }

  render(): string {
    let out = this.header();
    for (const { labels, counts, sum, count } of this.series.values()) {
      this.buckets.forEach((bound, i) => {
        out += `${this.name}_bucket${formatLabels({ ...labels, le: String(bound) })} ${counts[i] ?? 0}\n`;
      });
      out += `${this.name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${count}\n`;
      out += `${this.name}_sum${formatLabels(labels)} ${sum}\n`;
      out += `${this.name}_count${formatLabels(labels)} ${count}\n`;
    }
    return out;
  }
}

const BREAKER_GAUGE: Record<BreakerState, number> = { closed: 0, 'half-open': 1, open: 2 };

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Everything the gateway measures, rendered in the Prometheus text exposition format. */
export class GatewayMetrics {
  private readonly requests = new Counter('gateway_requests_total', 'Requests handled, by route, method and status.');
  private readonly rateLimited = new Counter('gateway_rate_limited_total', 'Requests rejected with 429, by route.');
  private readonly storeErrors = new Counter(
    'gateway_rate_limit_store_errors_total',
    'Rate limit store failures, by route and the policy that was applied.',
  );
  private readonly retries = new Counter('gateway_upstream_retries_total', 'Upstream attempts that were retried, by route.');
  private readonly breakerState = new Counter(
    'gateway_breaker_state',
    'Circuit breaker state per upstream: 0 closed, 1 half-open, 2 open.',
    'gauge',
  );
  private readonly inFlight = new Counter('gateway_in_flight_requests', 'Requests currently being handled.', 'gauge');
  private readonly latency = new Histogram(
    'gateway_upstream_latency_seconds',
    'Time until upstream response headers arrive, per attempt, by upstream.',
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  );
  private inFlightCount = 0;

  constructor() {
    this.inFlight.set({}, 0);
  }

  observeRequest(route: string, method: string, status: number): void {
    this.requests.inc({ route, method, status: String(status) });
  }

  observeRateLimited(route: string): void {
    this.rateLimited.inc({ route });
  }

  observeStoreError(route: string, policy: string): void {
    this.storeErrors.inc({ route, policy });
  }

  observeRetry(route: string): void {
    this.retries.inc({ route });
  }

  observeUpstreamLatency(upstream: string, seconds: number): void {
    this.latency.observe({ upstream }, seconds);
  }

  setBreakerState(upstream: string, state: BreakerState): void {
    this.breakerState.set({ upstream }, BREAKER_GAUGE[state]);
  }

  requestStarted(): void {
    this.inFlightCount += 1;
    this.inFlight.set({}, this.inFlightCount);
  }

  requestFinished(): void {
    this.inFlightCount -= 1;
    this.inFlight.set({}, this.inFlightCount);
  }

  render(): string {
    return [
      this.requests,
      this.rateLimited,
      this.storeErrors,
      this.retries,
      this.breakerState,
      this.inFlight,
      this.latency,
    ]
      .map((metric) => metric.render())
      .join('');
  }
}
