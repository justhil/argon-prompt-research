#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Normalize dynamic path segments (UUIDs, numeric IDs, long hex hashes) into placeholders
 */
export function normalizePath(rawPath, normalize = false) {
  const cleanPath = String(rawPath || '/').split('?')[0].trim() || '/';
  if (!normalize) return cleanPath;
  return cleanPath
    .replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/g, '/:uuid')
    .replace(/\/[0-9a-fA-F]{24}(?=\/|$)/g, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

/**
 * Parse a single log line (supports JSON logs, key=value logs, Nginx/Common/Combined + duration logs, simple whitespace logs)
 */
export function parseLogLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // 1. JSON log line
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      let method = obj.method || obj.http_method || obj.req?.method;
      let path = obj.path || obj.url || obj.uri || obj.endpoint || obj.req?.url;
      if (!method && typeof obj.request === 'string') {
        const parts = obj.request.trim().split(/\s+/);
        method = parts[0];
        path = path || parts[1];
      }
      const status = Number(obj.status ?? obj.statusCode ?? obj.status_code ?? obj.res?.statusCode ?? 200);
      let durationMs = obj.durationMs ?? obj.duration_ms ?? obj.latency ?? obj.latency_ms ?? obj.rt ?? obj.response_time ?? obj.time_ms ?? obj.duration;
      if (typeof durationMs === 'string') {
        const sMatch = durationMs.match(/^([\d.]+)\s*(ms|s|us|µs)?$/i);
        if (sMatch) {
          const val = parseFloat(sMatch[1]);
          const unit = (sMatch[2] || 'ms').toLowerCase();
          durationMs = unit === 's' ? val * 1000 : unit === 'us' || unit === 'µs' ? val / 1000 : val;
        } else {
          durationMs = parseFloat(durationMs);
        }
      } else if (typeof durationMs === 'number' && (obj.rt !== undefined || obj.request_time !== undefined) && obj.durationMs === undefined && obj.duration_ms === undefined && durationMs < 60 && !Number.isInteger(durationMs)) {
        // Common nginx rt in seconds if explicitly from request_time
        if (obj.request_time !== undefined) durationMs = durationMs * 1000;
      }
      const timestamp = obj.timestamp || obj.time || obj.ts || obj['@timestamp'] || null;
      const ip = obj.ip || obj.client_ip || obj.remote_addr || null;
      if (path && !Number.isNaN(status) && !Number.isNaN(Number(durationMs))) {
        return {
          timestamp: timestamp ? String(timestamp) : null,
          ip,
          method: String(method || 'GET').toUpperCase(),
          path: String(path),
          status,
          durationMs: Number(durationMs),
          raw: trimmed,
        };
      }
    } catch {
      // Fallback to text parsers
    }
  }

  // 2. Nginx / Apache Combined-style with request ("METHOD /path HTTP/1.1" status [bytes] ... duration)
  const quotedReqMatch = trimmed.match(
    /^(?:(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+|(\S+)\s+)?["']([A-Z]+)\s+(\S+?)(?:\s+HTTP\/[\d.]+)?["']\s+(\d{3})(?:\s+(?:\d+|-))?(?:.*?(\d+(?:\.\d+)?)\s*(ms|s)?)?\s*$/i
  );
  if (quotedReqMatch) {
    const ip = quotedReqMatch[1] || null;
    const timestamp = quotedReqMatch[2] || quotedReqMatch[3] || null;
    const method = quotedReqMatch[4].toUpperCase();
    const path = quotedReqMatch[5];
    const status = Number(quotedReqMatch[6]);
    // Also check explicit rt= or duration= inside the line
    const kvDuration = trimmed.match(/(?:rt|request_time|duration|latency|time)=([\d.]+)(ms|s)?/i);
    let durationMs = 0;
    if (kvDuration) {
      const val = parseFloat(kvDuration[1]);
      const unit = (kvDuration[2] || (kvDuration[0].startsWith('rt=') || kvDuration[0].startsWith('request_time=') ? 's' : 'ms')).toLowerCase();
      durationMs = unit === 's' ? val * 1000 : val;
    } else if (quotedReqMatch[7] !== undefined) {
      const val = parseFloat(quotedReqMatch[7]);
      const unit = (quotedReqMatch[8] || 'ms').toLowerCase();
      durationMs = unit === 's' ? val * 1000 : val;
    }
    return { timestamp, ip, method, path, status, durationMs, raw: trimmed };
  }

  // 3. Key=Value logs (e.g. method=GET path=/api/users status=200 duration=45ms)
  if (trimmed.includes('=') && /(?:method|path|url|status)/i.test(trimmed)) {
    const kv = {};
    const kvRegex = /(\w+)=(?:"([^"]*)"|(\S+))/g;
    let m;
    while ((m = kvRegex.exec(trimmed)) !== null) {
      kv[m[1].toLowerCase()] = m[2] ?? m[3];
    }
    const method = (kv.method || 'GET').toUpperCase();
    const path = kv.path || kv.url || kv.uri || kv.endpoint;
    const status = Number(kv.status || kv.status_code || kv.code);
    const rawDur = kv.duration || kv.duration_ms || kv.latency || kv.rt || kv.request_time || kv.time || '0';
    const durMatch = String(rawDur).match(/^([\d.]+)(ms|s|us|µs)?$/i);
    if (path && !Number.isNaN(status) && durMatch) {
      const val = parseFloat(durMatch[1]);
      const unit = (durMatch[2] || ((kv.rt || kv.request_time) && ! rawDur.endsWith('ms') && val < 60 && String(rawDur).includes('.') ? 's' : 'ms')).toLowerCase();
      const durationMs = unit === 's' ? val * 1000 : unit === 'us' || unit === 'µs' ? val / 1000 : val;
      return {
        timestamp: kv.time || kv.timestamp || kv.ts || null,
        ip: kv.ip || kv.client_ip || kv.remote_addr || null,
        method,
        path,
        status,
        durationMs,
        raw: trimmed,
      };
    }
  }

  // 4. Simple whitespace logs:
  // Supports: [timestamp] [ip] METHOD /path STATUS DURATION[ms|s]
  // or: METHOD /path STATUS DURATION[ms|s]
  const simpleMatch = trimmed.match(
    /^(?:(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+)?(?:(\d{1,3}(?:\.\d{1,3}){3})\s+)?([A-Z]{3,10})\s+(\/\S*)\s+(\d{3})\s+([\d.]+)\s*(ms|s|us|µs)?(?:\s+.*)?$/i
  );
  if (simpleMatch) {
    const [, timestamp = null, ip = null, method, path, statusStr, durStr, unitStr] = simpleMatch;
    const val = parseFloat(durStr);
    const unit = (unitStr || 'ms').toLowerCase();
    const durationMs = unit === 's' ? val * 1000 : unit === 'us' || unit === 'µs' ? val / 1000 : val;
    return {
      timestamp,
      ip,
      method: method.toUpperCase(),
      path,
      status: Number(statusStr),
      durationMs,
      raw: trimmed,
    };
  }

  return null;
}

/**
 * Compute percentile from a sorted ascending array of numbers
 */
export function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  if (p <= 0) return sortedValues[0];
  if (p >= 100) return sortedValues[sortedValues.length - 1];
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1;
  return Number(sortedValues[Math.max(0, Math.min(sortedValues.length - 1, idx))].toFixed(2));
}

function computeLatencyStats(durations) {
  if (!durations.length) {
    return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: Number(sorted[0].toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    avg: Number((sum / sorted.length).toFixed(2)),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function computeHistogram(durations, buckets = [50, 100, 200, 500, 1000, 3000]) {
  const sortedBuckets = [...buckets].map(Number).filter((n) => !Number.isNaN(n) && n > 0).sort((a, b) => a - b);
  const counts = new Array(sortedBuckets.length + 1).fill(0);
  for (const d of durations) {
    let placed = false;
    for (let i = 0; i < sortedBuckets.length; i++) {
      if (d <= sortedBuckets[i]) {
        counts[i]++;
        placed = true;
        break;
      }
    }
    if (!placed) counts[sortedBuckets.length]++;
  }

  const total = durations.length;
  const result = [];
  for (let i = 0; i < sortedBuckets.length; i++) {
    const prev = i === 0 ? 0 : sortedBuckets[i - 1];
    const curr = sortedBuckets[i];
    const label = `${prev}-${curr}ms`;
    const count = counts[i];
    result.push({
      label,
      minMs: prev,
      maxMs: curr,
      count,
      rate: total ? Number(((count / total) * 100).toFixed(2)) : 0,
    });
  }
  const lastBound = sortedBuckets[sortedBuckets.length - 1] ?? 0;
  const overCount = counts[sortedBuckets.length];
  result.push({
    label: `>${lastBound}ms`,
    minMs: lastBound,
    maxMs: Infinity,
    count: overCount,
    rate: total ? Number(((overCount / total) * 100).toFixed(2)) : 0,
  });
  return result;
}

function matchesStatusFilter(status, statusFilter) {
  if (!statusFilter) return true;
  const filters = Array.isArray(statusFilter)
    ? statusFilter
    : String(statusFilter)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
  if (!filters.length) return true;

  return filters.some((f) => {
    if (/^\dxx$/.test(f)) {
      return Math.floor(status / 100) === Number(f[0]);
    }
    if (/^\d{3}-\d{3}$/.test(f)) {
      const [min, max] = f.split('-').map(Number);
      return status >= min && status <= max;
    }
    if (/^>=\d{3}$/.test(f)) {
      return status >= Number(f.slice(2));
    }
    return status === Number(f);
  });
}

/**
 * Analyze access logs from raw text
 *
 * @param {string} rawText - Raw log content
 * @param {object} [options] - Analysis options
 * @param {number} [options.topN=10] - Top N slow requests / endpoints to return
 * @param {number} [options.slowThresholdMs=500] - Threshold (ms) to classify a request as slow
 * @param {string|string[]} [options.method] - Filter by HTTP method(s), e.g. 'GET' or 'GET,POST'
 * @param {string|RegExp} [options.pathFilter] - Substring or RegExp to filter request path
 * @param {string|number|Array} [options.statusFilter] - Filter by status code (e.g. 500, '5xx', '4xx,5xx', '400-499')
 * @param {number} [options.minDurationMs] - Filter requests with duration >= minDurationMs
 * @param {string|Date} [options.from] - Filter requests with timestamp >= from
 * @param {string|Date} [options.to] - Filter requests with timestamp <= to
 * @param {boolean} [options.normalizePaths=true] - Normalize dynamic path params (/users/123 -> /users/:id)
 * @param {number[]} [options.buckets] - Custom latency histogram buckets in ms
 */
export function analyzeLogs(rawText, options = {}) {
  const {
    topN = 10,
    slowThresholdMs = 500,
    method: methodFilter,
    pathFilter,
    statusFilter,
    minDurationMs = 0,
    from,
    to,
    normalizePaths = true,
    buckets = [50, 100, 200, 500, 1000, 3000],
  } = options;

  const lines = String(rawText ?? '').split(/\r?\n/);
  let totalLines = 0;
  let invalidLines = 0;
  const parsedEntries = [];

  const allowedMethods = methodFilter
    ? new Set(
        (Array.isArray(methodFilter) ? methodFilter : String(methodFilter).split(','))
          .map((m) => m.trim().toUpperCase())
          .filter(Boolean)
      )
    : null;

  const fromTime = from ? new Date(from).getTime() : null;
  const toTime = to ? new Date(to).getTime() : null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    totalLines++;
    const parsed = parseLogLine(line);
    if (!parsed) {
      invalidLines++;
      continue;
    }

    const endpointPath = normalizePath(parsed.path, normalizePaths);
    const entry = {
      ...parsed,
      endpointPath,
      endpoint: `${parsed.method} ${endpointPath}`,
    };

    // Apply filters
    if (allowedMethods && !allowedMethods.has(entry.method)) continue;
    if (pathFilter) {
      if (pathFilter instanceof RegExp) {
        if (!pathFilter.test(entry.path) && !pathFilter.test(entry.endpointPath)) continue;
      } else {
        const sub = String(pathFilter);
        if (!entry.path.includes(sub) && !entry.endpointPath.includes(sub)) continue;
      }
    }
    if (!matchesStatusFilter(entry.status, statusFilter)) continue;
    if (minDurationMs > 0 && entry.durationMs < minDurationMs) continue;
    if (fromTime || toTime) {
      const entryTime = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
      if (Number.isNaN(entryTime)) continue;
      if (fromTime && entryTime < fromTime) continue;
      if (toTime && entryTime > toTime) continue;
    }

    parsedEntries.push(entry);
  }

  const totalRequests = parsedEntries.length;
  const allDurations = parsedEntries.map((e) => e.durationMs);
  const latency = computeLatencyStats(allDurations);
  const histogram = computeHistogram(allDurations, buckets);

  // Status & Error breakdown
  const byClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  const byCode = {};
  const errorEntries = [];
  const slowEntries = [];
  const endpointMap = new Map();

  for (const entry of parsedEntries) {
    const statusClass = `${Math.floor(entry.status / 100)}xx`;
    if (statusClass in byClass) byClass[statusClass]++;
    else byClass.other++;

    byCode[entry.status] = (byCode[entry.status] || 0) + 1;

    if (entry.status >= 400) {
      errorEntries.push(entry);
    }
    if (entry.durationMs >= slowThresholdMs) {
      slowEntries.push(entry);
    }

    let ep = endpointMap.get(entry.endpoint);
    if (!ep) {
      ep = {
        endpoint: entry.endpoint,
        method: entry.method,
        path: entry.endpointPath,
        durations: [],
        errorCount: 0,
        status4xx: 0,
        status5xx: 0,
        slowCount: 0,
      };
      endpointMap.set(entry.endpoint, ep);
    }
    ep.durations.push(entry.durationMs);
    if (entry.status >= 400) ep.errorCount++;
    if (entry.status >= 400 && entry.status < 500) ep.status4xx++;
    if (entry.status >= 500) ep.status5xx++;
    if (entry.durationMs >= slowThresholdMs) ep.slowCount++;
  }

  // Endpoint stats
  const endpoints = Array.from(endpointMap.values())
    .map((ep) => {
      const stats = computeLatencyStats(ep.durations);
      const errorRate = ep.durations.length
        ? Number(((ep.errorCount / ep.durations.length) * 100).toFixed(2))
        : 0;
      const slowRate = ep.durations.length
        ? Number(((ep.slowCount / ep.durations.length) * 100).toFixed(2))
        : 0;
      return {
        endpoint: ep.endpoint,
        method: ep.method,
        path: ep.path,
        count: stats.count,
        min: stats.min,
        max: stats.max,
        avg: stats.avg,
        p50: stats.p50,
        p90: stats.p90,
        p95: stats.p95,
        p99: stats.p99,
        errorCount: ep.errorCount,
        status4xx: ep.status4xx,
        status5xx: ep.status5xx,
        errorRate,
        slowCount: ep.slowCount,
        slowRate,
      };
    })
    .sort((a, b) => b.p95 - a.p95 || b.avg - a.avg || b.count - a.count);

  // Error summary by endpoint + status
  const errorGroupMap = new Map();
  for (const err of errorEntries) {
    const key = `${err.endpoint}::${err.status}`;
    const existing = errorGroupMap.get(key) || {
      endpoint: err.endpoint,
      method: err.method,
      path: err.endpointPath,
      status: err.status,
      count: 0,
    };
    existing.count++;
    errorGroupMap.set(key, existing);
  }
  const topErrors = Array.from(errorGroupMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  // Top N slowest individual requests
  const slowRequests = [...parsedEntries]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, topN)
    .map(({ timestamp, ip, method, path, endpointPath, endpoint, status, durationMs, raw }) => ({
      timestamp,
      ip,
      method,
      path,
      endpointPath,
      endpoint,
      status,
      durationMs: Number(durationMs.toFixed(2)),
      raw,
    }));

  const errorCount = errorEntries.length;
  const count4xx = byClass['4xx'];
  const count5xx = byClass['5xx'];
  const errorRate = totalRequests ? Number(((errorCount / totalRequests) * 100).toFixed(2)) : 0;
  const rate4xx = totalRequests ? Number(((count4xx / totalRequests) * 100).toFixed(2)) : 0;
  const rate5xx = totalRequests ? Number(((count5xx / totalRequests) * 100).toFixed(2)) : 0;
  const slowCount = slowEntries.length;
  const slowRate = totalRequests ? Number(((slowCount / totalRequests) * 100).toFixed(2)) : 0;

  return {
    summary: {
      totalLines,
      parsedLines: totalLines - invalidLines,
      invalidLines,
      matchedRequests: totalRequests,
      totalRequests,
      errorCount,
      errorRate,
      count4xx,
      rate4xx,
      count5xx,
      rate5xx,
      slowThresholdMs,
      slowCount,
      slowRate,
      ...latency,
    },
    latency: {
      ...latency,
      histogram,
    },
    errors: {
      totalErrors: errorCount,
      errorRate,
      count4xx,
      rate4xx,
      count5xx,
      rate5xx,
      byStatusClass: byClass,
      byStatusCode: byCode,
      topErrorEndpoints: topErrors,
    },
    endpoints,
    slowRequests,
  };
}

/**
 * Format analysis result into target format ('text' | 'json' | 'markdown' | 'csv')
 */
export function formatReport(report, format = 'text', options = {}) {
  const fmt = String(format || 'text').toLowerCase();
  const topN = options.topN ?? 10;

  if (fmt === 'json') {
    return JSON.stringify(report, null, 2);
  }

  if (fmt === 'csv') {
    const header = [
      'endpoint',
      'method',
      'path',
      'count',
      'avg_ms',
      'min_ms',
      'p50_ms',
      'p90_ms',
      'p95_ms',
      'p99_ms',
      'max_ms',
      'error_count',
      'error_rate_pct',
      'slow_count',
      'slow_rate_pct',
    ];
    const rows = report.endpoints.map((ep) =>
      [
        `"${ep.endpoint.replace(/"/g, '""')}"`,
        ep.method,
        `"${ep.path.replace(/"/g, '""')}"`,
        ep.count,
        ep.avg,
        ep.min,
        ep.p50,
        ep.p90,
        ep.p95,
        ep.p99,
        ep.max,
        ep.errorCount,
        ep.errorRate,
        ep.slowCount,
        ep.slowRate,
      ].join(',')
    );
    return [header.join(','), ...rows].join('\n');
  }

  if (fmt === 'md' || fmt === 'markdown') {
    const s = report.summary;
    const lines = [
      '# Access Log Analysis Report',
      '',
      '## 1. Overview',
      `- **Total Requests**: ${s.totalRequests} (Parsed: ${s.parsedLines}/${s.totalLines}, Invalid: ${s.invalidLines})`,
      `- **Latency (ms)**: Avg=${s.avg}ms | Min=${s.min}ms | P50=${s.p50}ms | P90=${s.p90}ms | P95=${s.p95}ms | P99=${s.p99}ms | Max=${s.max}ms`,
      `- **Errors**: ${s.errorCount} (${s.errorRate}%) [4xx: ${s.count4xx} (${s.rate4xx}%), 5xx: ${s.count5xx} (${s.rate5xx}%)]`,
      `- **Slow Requests (>=${s.slowThresholdMs}ms)**: ${s.slowCount} (${s.slowRate}%)`,
      '',
      '## 2. Latency Distribution (Histogram)',
      '| Bucket | Count | Percentage |',
      '| :--- | ---: | ---: |',
      ...report.latency.histogram.map((b) => `| ${b.label} | ${b.count} | ${b.rate}% |`),
      '',
      '## 3. Endpoint Latency & Error Stats',
      '| Endpoint | Count | Avg(ms) | P50(ms) | P90(ms) | P95(ms) | P99(ms) | Max(ms) | Errors | Error Rate |',
      '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...report.endpoints
        .slice(0, topN)
        .map(
          (ep) =>
            `| \`${ep.endpoint}\` | ${ep.count} | ${ep.avg} | ${ep.p50} | ${ep.p90} | ${ep.p95} | ${ep.p99} | ${ep.max} | ${ep.errorCount} | ${ep.errorRate}% |`
        ),
      '',
      '## 4. Error Breakdown',
      '| Status Code | Count |',
      '| :--- | ---: |',
      ...Object.entries(report.errors.byStatusCode).map(([code, cnt]) => `| ${code} | ${cnt} |`),
      '',
      `## 5. Top ${ report.slowRequests.length } Slowest Requests`,
      '| # | Duration(ms) | Status | Endpoint | Path | Timestamp |',
      '| ---: | ---: | ---: | :--- | :--- | :--- |',
      ...report.slowRequests.map(
        (r, i) => `| ${i + 1} | ${r.durationMs} | ${r.status} | \`${r.endpoint}\` | \`${r.path}\` | ${r.timestamp || '-'} |`
      ),
    ];
    return lines.join('\n');
  }

  // Default human-friendly text output
  const s = report.summary;
  const out = [];
  out.push('================================================================================');
  out.push('                          ACCESS LOG ANALYSIS REPORT                            ');
  out.push('================================================================================');
  out.push(
    `Requests : ${s.totalRequests} matched (Lines: ${s.totalLines}, Parsed: ${s.parsedLines}, Invalid: ${s.invalidLines})`
  );
  out.push(
    `Latency  : Avg=${s.avg}ms | Min=${s.min}ms | P50=${s.p50}ms | P90=${s.p90}ms | P95=${s.p95}ms | P99=${s.p99}ms | Max=${s.max}ms`
  );
  out.push(
    `Errors   : ${s.errorCount} (${s.errorRate}%) [4xx: ${s.count4xx} (${s.rate4xx}%), 5xx: ${s.count5xx} (${s.rate5xx}%)]`
  );
  out.push(`Slow Req : ${s.slowCount} (${s.slowRate}%) [threshold >= ${s.slowThresholdMs}ms]`);
  out.push('');

  out.push('--- Latency Distribution -------------------------------------------------------');
  for (const b of report.latency.histogram) {
    const barLen = Math.round((b.rate / 100) * 25);
    const bar = '#'.repeat(barLen).padEnd(25, ' ');
    out.push(`  ${b.label.padEnd(12)} | ${bar} | ${String(b.count).padStart(6)} (${b.rate.toFixed(2)}%)`);
  }
  out.push('');

  out.push('--- Endpoint Performance (Sorted by P95 desc) ----------------------------------');
  out.push(
    `${'Endpoint'.padEnd(28)} ${'Count'.padStart(6)} ${'Avg'.padStart(8)} ${'P50'.padStart(8)} ${'P90'.padStart(8)} ${'P95'.padStart(8)} ${'P99'.padStart(8)} ${'Max'.padStart(8)} ${'Err%'.padStart(7)}`
  );
  for (const ep of report.endpoints.slice(0, topN)) {
    out.push(
      `${ep.endpoint.slice(0, 28).padEnd(28)} ${String(ep.count).padStart(6)} ${String(ep.avg).padStart(8)} ${String(ep.p50).padStart(8)} ${String(ep.p90).padStart(8)} ${String(ep.p95).padStart(8)} ${String(ep.p99).padStart(8)} ${String(ep.max).padStart(8)} ${(ep.errorRate + '%').padStart(7)}`
    );
  }
  out.push('');

  out.push('--- Error Breakdown ------------------------------------------------------------');
  const codeEntries = Object.entries(report.errors.byStatusCode);
  if (!codeEntries.length) {
    out.push('  No requests matched.');
  } else {
    out.push(
      `  By Class : 2xx=${report.errors.byStatusClass['2xx']}, 3xx=${report.errors.byStatusClass['3xx']}, 4xx=${report.errors.byStatusClass['4xx']}, 5xx=${report.errors.byStatusClass['5xx']}`
    );
    out.push(`  By Code  : ${codeEntries.map(([k, v]) => `${k}: ${v}`).join(' | ')}`);
    if (report.errors.topErrorEndpoints.length) {
      out.push('  Top Error Endpoints:');
      for (const e of report.errors.topErrorEndpoints) {
        out.push(`    - ${e.endpoint} [HTTP ${e.status}] : ${e.count} errors`);
      }
    }
  }
  out.push('');

  out.push(`--- Top ${report.slowRequests.length} Slowest Requests -----------------------------------------------------`);
  if (!report.slowRequests.length) {
    out.push('  No requests found.');
  } else {
    report.slowRequests.forEach((r, idx) => {
      const ts = r.timestamp ? ` [${r.timestamp}]` : '';
      out.push(`  #${idx + 1} ${String(r.durationMs + 'ms').padEnd(10)} HTTP ${r.status} ${r.method} ${r.path}${ts}`);
    });
  }

  return out.join('\n');
}

function printHelp() {
  console.log(`Usage: node src/logstat.mjs [file] [options]

Options:
  -f, --file <path>          Input log file path (reads from stdin if omitted)
  -n, --top <number>         Top N slow requests and endpoints to show (default: 10)
  -s, --slow <ms>            Slow request threshold in ms (default: 500)
  -m, --method <methods>     Filter by HTTP method(s), e.g. GET or GET,POST
  -p, --path <pattern>       Filter by request path substring
      --status <filter>      Filter by status code/class, e.g. 500, 5xx, 4xx,5xx, 400-499
      --min-duration <ms>    Filter requests with duration >= ms
      --from <iso-date>      Filter logs from timestamp
      --to <iso-date>        Filter logs up to timestamp
      --no-normalize         Disable dynamic path normalization (/users/123 -> /users/:id)
      --format <fmt>         Output format: text | json | markdown | csv (default: text)
  -o, --output <path>        Export formatted report to file
  -h, --help                 Show this help message`);
}

export function parseCliArgs(argv) {
  const opts = {
    file: null,
    topN: 10,
    slowThresholdMs: 500,
    method: undefined,
    pathFilter: undefined,
    statusFilter: undefined,
    minDurationMs: 0,
    from: undefined,
    to: undefined,
    normalizePaths: true,
    format: 'text',
    output: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-f' || arg === '--file') {
      opts.file = argv[++i];
    } else if (arg === '-n' || arg === '--top') {
      opts.topN = Number(argv[++i]);
    } else if (arg === '-s' || arg === '--slow') {
      opts.slowThresholdMs = Number(argv[++i]);
    } else if (arg === '-m' || arg === '--method') {
      opts.method = argv[++i];
    } else if (arg === '-p' || arg === '--path') {
      opts.pathFilter = argv[++i];
    } else if (arg === '--status') {
      opts.statusFilter = argv[++i];
    } else if (arg === '--min-duration') {
      opts.minDurationMs = Number(argv[++i]);
    } else if (arg === '--from') {
      opts.from = argv[++i];
    } else if (arg === '--to') {
      opts.to = argv[++i];
    } else if (arg === '--no-normalize') {
      opts.normalizePaths = false;
    } else if (arg === '--format') {
      opts.format = argv[++i];
    } else if (arg === '-o' || arg === '--output') {
      opts.output = argv[++i];
    } else if (!arg.startsWith('-') && !opts.file) {
      opts.file = arg;
    }
  }
  return opts;
}

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let rawText = '';
  if (args.file) {
    rawText = fs.readFileSync(args.file, 'utf8');
  } else if (!process.stdin.isTTY) {
    rawText = fs.readFileSync(0, 'utf8');
  } else {
    printHelp();
    process.exit(0);
  }

  const report = analyzeLogs(rawText, args);
  const formatted = formatReport(report, args.format, { topN: args.topN });

  if (args.output) {
    fs.writeFileSync(args.output, formatted, 'utf8');
  } else {
    console.log(formatted);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  runCli().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

export default analyzeLogs;
