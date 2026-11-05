import { describe, expect, it } from 'vitest';
import { GatewayMetrics } from '../src/metrics.js';

describe('GatewayMetrics', () => {
  it('renders counters and gauges in the Prometheus text format with sorted, escaped labels', () => {
    const metrics = new GatewayMetrics();
    metrics.observeRequest('/api/orders', 'GET', 200);
    metrics.observeRequest('/api/orders', 'GET', 200);
    metrics.observeRequest('/api/"quoted"\\path\n', 'POST', 503);
    metrics.observeRateLimited('/api/orders');
    metrics.observeStoreError('/api/orders', 'open');
    metrics.observeRetry('/api/orders');
    metrics.setBreakerState('http://127.0.0.1:4001', 'half-open');
    const text = metrics.render();

    expect(text).toContain('# HELP gateway_requests_total Requests handled, by route, method and status.\n# TYPE gateway_requests_total counter\n');
    expect(text).toContain('gateway_requests_total{method="GET",route="/api/orders",status="200"} 2\n');
    expect(text).toContain('gateway_requests_total{method="POST",route="/api/\\"quoted\\"\\\\path\\n",status="503"} 1\n');
    expect(text).toContain('gateway_rate_limited_total{route="/api/orders"} 1\n');
    expect(text).toContain('gateway_rate_limit_store_errors_total{policy="open",route="/api/orders"} 1\n');
    expect(text).toContain('gateway_upstream_retries_total{route="/api/orders"} 1\n');
    expect(text).toContain('# TYPE gateway_breaker_state gauge\ngateway_breaker_state{upstream="http://127.0.0.1:4001"} 1\n');
    expect(text).toContain('# TYPE gateway_in_flight_requests gauge\ngateway_in_flight_requests 0\n');
  });

  it('tracks in-flight requests as a gauge', () => {
    const metrics = new GatewayMetrics();
    metrics.requestStarted();
    metrics.requestStarted();
    metrics.requestFinished();
    expect(metrics.render()).toContain('gateway_in_flight_requests 1\n');
  });

  it('renders a cumulative histogram with +Inf, sum and count', () => {
    const metrics = new GatewayMetrics();
    metrics.observeUpstreamLatency('u', 0.004);
    metrics.observeUpstreamLatency('u', 0.03);
    metrics.observeUpstreamLatency('u', 42);
    const text = metrics.render();
    expect(text).toContain('# TYPE gateway_upstream_latency_seconds histogram\n');
    expect(text).toContain('gateway_upstream_latency_seconds_bucket{le="0.005",upstream="u"} 1\n');
    expect(text).toContain('gateway_upstream_latency_seconds_bucket{le="0.025",upstream="u"} 1\n');
    expect(text).toContain('gateway_upstream_latency_seconds_bucket{le="0.05",upstream="u"} 2\n');
    expect(text).toContain('gateway_upstream_latency_seconds_bucket{le="10",upstream="u"} 2\n');
    expect(text).toContain('gateway_upstream_latency_seconds_bucket{le="+Inf",upstream="u"} 3\n');
    expect(text).toContain('gateway_upstream_latency_seconds_sum{upstream="u"} 42.034\n');
    expect(text).toContain('gateway_upstream_latency_seconds_count{upstream="u"} 3\n');
  });
});
