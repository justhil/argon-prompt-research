import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 解析单行访问日志，支持：
 * 1. JSON Lines: {"timestamp":"...","method":"GET","path":"/api/users","status":200,"latency":45}
 * 2. Key-Value 格式: time=... method=GET path=/api/users status=200 latency=45ms
 * 3. Nginx / Combined 扩展格式: 127.0.0.1 - - [10/Oct/2025:13:55:36 +0800] "GET /api/v1/items?id=1 HTTP/1.1" 200 1234 "-" "curl" 0.045 (或 45ms)
 * 4. 简明空格分隔格式: [2025-10-10T10:00:00Z] GET /api/users 200 45ms
 */
export function parseLogLine(line, lineNumber = 0) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 1. JSON 格式
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      const rawUrl = String(obj.path ?? obj.url ?? obj.uri ?? obj.endpoint ?? '/');
      const [cleanPath] = rawUrl.split('?');
      return {
        lineNumber,
        raw: trimmed,
        timestamp: parseTimestamp(obj.timestamp ?? obj.time ?? obj.date ?? obj.ts),
        method: String(obj.method ?? obj.httpMethod ?? 'GET').toUpperCase(),
        path: normalizeRoute(cleanPath, obj.route),
        rawPath: rawUrl,
        status: Number(obj.status ?? obj.statusCode ?? obj.code ?? 200),
        latencyMs: parseDurationMs(
          obj.latencyMs ?? obj.latency ?? obj.duration ?? obj.responseTime ?? obj.rt ?? obj.request_time ?? 0
        ),
        ip: obj.ip ?? obj.clientIp ?? obj.remote_addr ?? '-',
      };
    } catch {
      // fall through
    }
  }

  // 2. Key=Value 格式 (含 method= 和 status= 等)
  if (/\b(?:method|status|path|uri)=/i.test(trimmed)) {
    const kv = {};
    const regex = /(\w+)=(?:"([^"]*)"|(\S+))/g;
    let match;
    while ((match = regex.exec(trimmed)) !== null) {
      kv[match[1].toLowerCase()] = match[2] ?? match[3];
    }
    if (kv.path || kv.uri || kv.url || kv.status) {
      const rawUrl = kv.path ?? kv.uri ?? kv.url ?? '/';
      const [cleanPath] = rawUrl.split('?');
      return {
        lineNumber,
        raw: trimmed,
        timestamp: parseTimestamp(kv.time ?? kv.timestamp ?? kv.ts ?? kv.date),
        method: (kv.method ?? 'GET').toUpperCase(),
        path: normalizeRoute(cleanPath, kv.route),
        rawPath: rawUrl,
        status: Number(kv.status ?? kv.code ?? 200),
        latencyMs: parseDurationMs(kv.latency ?? kv.duration ?? kv.rt ?? kv.request_time ?? kv.cost ?? 0),
        ip: kv.ip ?? kv.client ?? kv.remote_addr ?? '-',
      };
    }
  }

  // 3. 标准 Nginx / Apache Combined 风格
  // 示例: 127.0.0.1 - - [10/Oct/2025:13:55:36 +0800] "GET /api/users/42?page=1 HTTP/1.1" 200 512 "-" "Mozilla/5.0" 45ms
  const nginxRe =
    /^(?<ip>\S+)\s+\S+\s+\S+\s+\[(?<time>[^\]]+)\]\s+"(?<method>[A-Z]+)\s+(?<url>\S+)(?:\s+HTTP\/[\d.]+)?"\s+(?<status>\d{3})\s+(?<bytes>\S+)(?:\s+"[^"]*"\s+"[^"]*")?(?:\s+(?<rt>\d+(?:\.\d+)?(?:ms|s|us|µs)?))?/i;
  const nginxMatch = trimmed.match(nginxRe);
  if (nginxMatch?.groups) {
    const { ip, time, method, url, status, rt } = nginxMatch.groups;
    const [cleanPath] = url.split('?');
    return {
      lineNumber,
      raw: trimmed,
      timestamp: parseTimestamp(time),
      method: method.toUpperCase(),
      path: normalizeRoute(cleanPath),
      rawPath: url,
      status: Number(status),
      latencyMs: parseDurationMs(rt ?? 0, true),
      ip,
    };
  }

  // 4. 通用简明文本格式
  // 支持: [2025-10-10T10:00:00Z] GET /api/users 200 45ms 或 2025-10-10 10:00:00 GET /api/users 200 45
  const simpleRe =
    /^(?:\[?(?<time>\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+)?(?:(?<ip>\d{1,3}(?:\.\d{1,3}){3})\s+)?(?<method>GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(?<url>\S+)\s+(?<status>\d{3})(?:\s+(?<rt>\d+(?:\.\d+)?(?:ms|s|us|µs)?))?/i;
  const simpleMatch = trimmed.match(simpleRe);
  if (simpleMatch?.groups) {
    const { time, ip, method, url, status, rt } = simpleMatch.groups;
    const [cleanPath] = url.split('?');
    return {
      lineNumber,
      raw: trimmed,
      timestamp: parseTimestamp(time),
      method: method.toUpperCase(),
      path: normalizeRoute(cleanPath),
      rawPath: url,
      status: Number(status),
      latencyMs: parseDurationMs(rt ?? 0),
      ip: ip ?? '-',
    };
  }

  return null;
}

/**
 * 将动态路径中的纯数字 ID 或 UUID 归一化（可通过 normalizeRoutes 开关控制）
 */
export function normalizeRoute(cleanPath, explicitRoute) {
  if (explicitRoute) return String(explicitRoute);
  if (!cleanPath) return '/';
  return cleanPath
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:uuid')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

function parseDurationMs(val, nginxDefaultSeconds = false) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (!val) return 0;
  const str = String(val).trim().toLowerCase();
  if (str.endsWith('ms')) return parseFloat(str) || 0;
  if (str.endsWith('us') || str.endsWith('µs')) return (parseFloat(str) || 0) / 1000;
  if (str.endsWith('s')) return (parseFloat(str) || 0) * 1000;
  const num = parseFloat(str);
  if (!Number.isFinite(num)) return 0;
  // Nginx $request_time 常为带小数的秒（如 0.045），若无单位且含小数点且 nginxDefaultSeconds 为 true 则按秒转毫秒
  if (nginxDefaultSeconds && str.includes('.')) {
    return num * 1000;
  }
  return num;
}

function parseTimestamp(raw) {
  if (!raw) return null;
  if (typeof raw === 'number') {
    const d = new Date(raw < 1e12 ? raw * 1000 : raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const str = String(raw).trim();
  // 处理 Nginx 时间格式: 10/Oct/2025:13:55:36 +0800
  const cltMatch = str.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}:\d{2}:\d{2})\s*([+-]\d{4}|Z)?$/);
  if (cltMatch) {
    const [, day, mon, year, time, tz] = cltMatch;
    const d = new Date(`${day} ${mon} ${year} ${time} ${tz || 'Z'}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  if (p <= 0) return sortedAsc[0];
  if (p >= 100) return sortedAsc[sortedAsc.length - 1];
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return round2(sortedAsc[Math.max(0, idx)]);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function calcLatencyStats(latencies) {
  if (!latencies.length) {
    return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: round2(sorted[0]),
    max: round2(sorted[sorted.length - 1]),
    avg: round2(sum / sorted.length),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/**
 * 分析访问日志核心函数
 * @param {string} rawText 原始日志文本
 * @param {object} [options] 分析与过滤选项
 * @param {number} [options.topN=10] 慢请求与热门接口 Top N 数量
 * @param {number} [options.slowThresholdMs=500] 慢请求阈值（毫秒）
 * @param {string} [options.method] 按 HTTP 方法过滤（如 'GET' 或 'GET,POST'）
 * @param {string|RegExp} [options.pathFilter] 按路径子串或正则过滤
 * @param {string|number} [options.status] 状态码过滤（支持 500、'5xx'、'4xx,5xx'、'>=400'）
 * @param {number} [options.minLatencyMs] 最小耗时过滤（毫秒）
 * @param {string|Date} [options.from] 起始时间过滤
 * @param {string|Date} [options.to] 结束时间过滤
 * @param {boolean} [options.normalizeRoutes=true] 是否将动态路径归一化（如 /users/123 -> /users/:id）
 */
export function analyzeLogs(rawText = '', options = {}) {
  const {
    topN = 10,
    slowThresholdMs = 500,
    method,
    pathFilter,
    status,
    minLatencyMs,
    from,
    to,
    normalizeRoutes = true,
  } = options;

  const lines = String(rawText).split(/\r?\n/);
  let totalLines = 0;
  let unparsedLines = 0;
  const parsedRecords = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    totalLines++;
    const parsed = parseLogLine(line, i + 1);
    if (!parsed) {
      unparsedLines++;
      continue;
    }
    if (!normalizeRoutes) {
      const [rawClean] = parsed.rawPath.split('?');
      parsed.path = rawClean || '/';
    }
    parsedRecords.push(parsed);
  }

  const methodSet = method
    ? new Set(
        String(method)
          .split(',')
          .map((m) => m.trim().toUpperCase())
          .filter(Boolean)
      )
    : null;

  const fromTime = from ? new Date(from).getTime() : null;
  const toTime = to ? new Date(to).getTime() : null;

  const filtered = parsedRecords.filter((rec) => {
    if (methodSet && !methodSet.has(rec.method)) return false;

    if (pathFilter) {
      if (pathFilter instanceof RegExp) {
        if (!pathFilter.test(rec.rawPath) && !pathFilter.test(rec.path)) return false;
      } else {
        const sub = String(pathFilter);
        if (!rec.rawPath.includes(sub) && !rec.path.includes(sub)) return false;
      }
    }

    if (status !== undefined && status !== null && status !== '') {
      if (!matchStatusFilter(rec.status, status)) return false;
    }

    if (minLatencyMs !== undefined && minLatencyMs !== null && rec.latencyMs < Number(minLatencyMs)) {
      return false;
    }

    if (fromTime && !Number.isNaN(fromTime)) {
      if (!rec.timestamp || new Date(rec.timestamp).getTime() < fromTime) return false;
    }

    if (toTime && !Number.isNaN(toTime)) {
      if (!rec.timestamp || new Date(rec.timestamp).getTime() > toTime) return false;
    }

    return true;
  });

  const allLatencies = [];
  const statusCodes = {};
  const statusBuckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  const endpointMap = new Map();
  const errorMap = new Map();
  let slowCount = 0;

  // 耗时区间直方图
  const histogram = {
    '<50ms': 0,
    '50-200ms': 0,
    '200-500ms': 0,
    '500-1000ms': 0,
    '>=1000ms': 0,
  };

  for (const rec of filtered) {
    allLatencies.push(rec.latencyMs);

    if (rec.latencyMs < 50) histogram['<50ms']++;
    else if (rec.latencyMs < 200) histogram['50-200ms']++;
    else if (rec.latencyMs < 500) histogram['200-500ms']++;
    else if (rec.latencyMs < 1000) histogram['500-1000ms']++;
    else histogram['>=1000ms']++;

    if (rec.latencyMs >= slowThresholdMs) {
      slowCount++;
    }

    statusCodes[rec.status] = (statusCodes[rec.status] || 0) + 1;
    if (rec.status >= 200 && rec.status < 300) statusBuckets['2xx']++;
    else if (rec.status >= 300 && rec.status < 400) statusBuckets['3xx']++;
    else if (rec.status >= 400 && rec.status < 500) statusBuckets['4xx']++;
    else if (rec.status >= 500 && rec.status < 600) statusBuckets['5xx']++;
    else statusBuckets.other++;

    const epKey = `${rec.method} ${rec.path}`;
    let ep = endpointMap.get(epKey);
    if (!ep) {
      ep = {
        endpoint: epKey,
        method: rec.method,
        path: rec.path,
        latencies: [],
        errorCount: 0,
        status5xxCount: 0,
        slowCount: 0,
      };
      endpointMap.set(epKey, ep);
    }
    ep.latencies.push(rec.latencyMs);
    if (rec.status >= 400) ep.errorCount++;
    if (rec.status >= 500) ep.status5xxCount++;
    if (rec.latencyMs >= slowThresholdMs) ep.slowCount++;

    if (rec.status >= 400) {
      const errKey = `${rec.method} ${rec.path} [${rec.status}]`;
      const prev = errorMap.get(errKey) || {
        endpoint: `${rec.method} ${rec.path}`,
        method: rec.method,
        path: rec.path,
        status: rec.status,
        count: 0,
        lastTimestamp: null,
      };
      prev.count++;
      if (rec.timestamp) prev.lastTimestamp = rec.timestamp;
      errorMap.set(errKey, prev);
    }
  }

  const totalRequests = filtered.length;
  const error4xxCount = statusBuckets['4xx'];
  const error5xxCount = statusBuckets['5xx'];
  const totalErrorCount = error4xxCount + error5xxCount;

  const endpoints = Array.from(endpointMap.values())
    .map((ep) => {
      const stats = calcLatencyStats(ep.latencies);
      return {
        endpoint: ep.endpoint,
        method: ep.method,
        path: ep.path,
        ...stats,
        errorCount: ep.errorCount,
        status5xxCount: ep.status5xxCount,
        errorRate: stats.count ? round2((ep.errorCount / stats.count) * 100) : 0,
        slowCount: ep.slowCount,
      };
    })
    .sort((a, b) => b.p95 - a.p95 || b.avg - a.avg || b.count - a.count);

  const slowRequests = [...filtered]
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, topN)
    .map((r) => ({
      lineNumber: r.lineNumber,
      timestamp: r.timestamp,
      method: r.method,
      path: r.rawPath,
      route: r.path,
      status: r.status,
      latencyMs: round2(r.latencyMs),
      ip: r.ip,
    }));

  const topErrors = Array.from(errorMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  return {
    summary: {
      totalLines,
      parsedLines: parsedRecords.length,
      unparsedLines,
      matchedRequests: totalRequests,
      slowThresholdMs,
      slowRequestsCount: slowCount,
      slowRate: totalRequests ? round2((slowCount / totalRequests) * 100) : 0,
      errorCount: totalErrorCount,
      error4xxCount,
      error5xxCount,
      errorRate: totalRequests ? round2((totalErrorCount / totalRequests) * 100) : 0,
    },
    latency: {
      ...calcLatencyStats(allLatencies),
      histogram,
    },
    errors: {
      totalErrors: totalErrorCount,
      errorRate: totalRequests ? round2((totalErrorCount / totalRequests) * 100) : 0,
      statusBuckets,
      statusCodes,
      topErrors,
    },
    endpoints: endpoints.slice(0, topN),
    allEndpoints: endpoints,
    slowRequests,
  };
}

function matchStatusFilter(code, filter) {
  if (typeof filter === 'number') return code === filter;
  const tokens = String(filter)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return tokens.some((tok) => {
    if (/^\d{3}$/.test(tok)) return code === Number(tok);
    if (/^[1-5]xx$/.test(tok)) {
      const prefix = Number(tok[0]);
      return Math.floor(code / 100) === prefix;
    }
    if (tok.startsWith('>=')) return code >= Number(tok.slice(2));
    if (tok.startsWith('>')) return code > Number(tok.slice(1));
    if (tok.startsWith('<=')) return code <= Number(tok.slice(2));
    if (tok.startsWith('<')) return code < Number(tok.slice(1));
    return false;
  });
}

/**
 * 将分析结果导出为指定格式: 'text' | 'json' | 'markdown' | 'csv'
 */
export function formatReport(report, format = 'text') {
  const fmt = String(format).toLowerCase();
  if (fmt === 'json') {
    const { allEndpoints, ...rest } = report;
    return JSON.stringify(rest, null, 2);
  }
  if (fmt === 'csv') {
    const headers = ['endpoint', 'method', 'path', 'count', 'avg_ms', 'min_ms', 'p50_ms', 'p90_ms', 'p95_ms', 'p99_ms', 'max_ms', 'error_count', 'error_rate_pct'];
    const rows = report.endpoints.map((ep) =>
      [
        escapeCsv(ep.endpoint),
        ep.method,
        escapeCsv(ep.path),
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
      ].join(',')
    );
    return [headers.join(','), ...rows].join('\n');
  }
  if (fmt === 'md' || fmt === 'markdown') {
    return renderMarkdown(report);
  }
  return renderText(report);
}

function escapeCsv(val) {
  const s = String(val ?? '');
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderMarkdown(report) {
  const { summary, latency, errors, endpoints, slowRequests } = report;
  const lines = [
    '# 访问日志分析报告',
    '',
    '## 1. 概览与错误统计',
    `- **匹配请求数**: ${summary.matchedRequests} (总行数: ${summary.totalLines}, 未识别: ${summary.unparsedLines})`,
    `- **整体耗时 (ms)**: Avg=${latency.avg} | Min=${latency.min} | P50=${latency.p50} | P90=${latency.p90} | P95=${latency.p95} | P99=${latency.p99} | Max=${latency.max}`,
    `- **慢请求 (>=${summary.slowThresholdMs}ms)**: ${summary.slowRequestsCount} (${summary.slowRate}%)`,
    `- **错误请求 (4xx/5xx)**: ${summary.errorCount} (${summary.errorRate}%) [4xx=${summary.error4xxCount}, 5xx=${summary.error5xxCount}]`,
    '',
    '## 2. 接口耗时分布',
    '| 接口 | 请求数 | Avg(ms) | P50(ms) | P95(ms) | P99(ms) | Max(ms) | 错误率 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...endpoints.map(
      (e) =>
        `| \`${e.endpoint}\` | ${e.count} | ${e.avg} | ${e.p50} | ${e.p95} | ${e.p99} | ${e.max} | ${e.errorRate}% |`
    ),
    '',
    '## 3. 错误详情 Top N',
    errors.topErrors.length
      ? [
          '| 接口 | 状态码 | 次数 | 最近发生时间 |',
          '| --- | ---: | ---: | --- |',
          ...errors.topErrors.map(
            (err) => `| \`${err.endpoint}\` | ${err.status} | ${err.count} | ${err.lastTimestamp || '-'} |`
          ),
        ].join('\n')
      : '无错误请求。',
    '',
    '## 4. 慢请求 Top N',
    '| 耗时(ms) | 状态码 | 方法 | 路径 | 时间 | 行号 |',
    '| ---: | ---: | --- | --- | --- | ---: |',
    ...slowRequests.map(
      (r) => `| ${r.latencyMs} | ${r.status} | ${r.method} | \`${r.path}\` | ${r.timestamp || '-'} | ${r.lineNumber} |`
    ),
  ];
  return lines.join('\n');
}

function renderText(report) {
  const { summary, latency, errors, endpoints, slowRequests } = report;
  const out = [];
  out.push('==================== 访问日志分析报告 ====================');
  out.push(
    `总行数: ${summary.totalLines} | 有效解析: ${summary.parsedLines} | 过滤后请求: ${summary.matchedRequests} | 忽略行: ${summary.unparsedLines}`
  );
  out.push(
    `错误统计: 总错误 ${summary.errorCount} (${summary.errorRate}%) | 4xx: ${summary.error4xxCount} | 5xx: ${summary.error5xxCount}`
  );
  out.push(
    `慢请求 (>=${summary.slowThresholdMs}ms): ${summary.slowRequestsCount} (${summary.slowRate}%)`
  );
  out.push('');
  out.push('-------------------- 全局耗时分布 (ms) -------------------');
  out.push(
    `Avg: ${latency.avg} | Min: ${latency.min} | P50: ${latency.p50} | P90: ${latency.p90} | P95: ${latency.p95} | P99: ${latency.p99} | Max: ${latency.max}`
  );
  const histStr = Object.entries(latency.histogram)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');
  out.push(`区间分布: ${histStr}`);
  out.push('');
  out.push('-------------------- 接口耗时分布 (Top) ------------------');
  if (endpoints.length === 0) {
    out.push('(无匹配数据)');
  } else {
    out.push(
      padRow(['Endpoint', 'Count', 'Avg', 'P50', 'P90', 'P95', 'P99', 'Max', 'Err%'], [28, 7, 8, 8, 8, 8, 8, 8, 7])
    );
    for (const ep of endpoints) {
      out.push(
        padRow(
          [
            ep.endpoint.slice(0, 27),
            ep.count,
            ep.avg,
            ep.p50,
            ep.p90,
            ep.p95,
            ep.p99,
            ep.max,
            `${ep.errorRate}%`,
          ],
          [28, 7, 8, 8, 8, 8, 8, 8, 7]
        )
      );
    }
  }

  out.push('');
  out.push('-------------------- 错误情况汇总 ------------------------');
  const codeSummary = Object.entries(errors.statusCodes)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([code, cnt]) => `${code}: ${cnt}`)
    .join(' | ');
  out.push(`状态码分布: ${codeSummary || '无'}`);
  if (errors.topErrors.length > 0) {
    for (const err of errors.topErrors) {
      out.push(`  [${err.status}] ${err.endpoint} -> ${err.count} 次 (最近: ${err.lastTimestamp || '-'})`);
    }
  } else {
    out.push('  无 4xx/5xx 错误记录');
  }

  out.push('');
  out.push('-------------------- 慢请求 Top N ------------------------');
  if (slowRequests.length === 0) {
    out.push('(无匹配数据)');
  } else {
    for (let i = 0; i < slowRequests.length; i++) {
      const r = slowRequests[i];
      out.push(
        `  #${i + 1} [${r.latencyMs}ms] ${r.status} ${r.method} ${r.path} (line ${r.lineNumber}${r.timestamp ? `, ${r.timestamp}` : ''})`
      );
    }
  }
  return out.join('\n');
}

function padRow(cols, widths) {
  return cols
    .map((c, idx) => {
      const s = String(c);
      return idx === 0 ? s.padEnd(widths[idx]) : s.padStart(widths[idx]);
    })
    .join(' ');
}

export function parseCliArgs(argv) {
  const args = {
    files: [],
    topN: 10,
    slowThresholdMs: 500,
    format: 'text',
    normalizeRoutes: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '-n' || arg === '--top') {
      args.topN = Number(argv[++i]);
    } else if (arg === '-s' || arg === '--slow') {
      args.slowThresholdMs = Number(argv[++i]);
    } else if (arg === '-m' || arg === '--method') {
      args.method = argv[++i];
    } else if (arg === '-p' || arg === '--path') {
      args.pathFilter = argv[++i];
    } else if (arg === '--status') {
      args.status = argv[++i];
    } else if (arg === '--min-latency') {
      args.minLatencyMs = Number(argv[++i]);
    } else if (arg === '--from') {
      args.from = argv[++i];
    } else if (arg === '--to') {
      args.to = argv[++i];
    } else if (arg === '-f' || arg === '--format') {
      args.format = argv[++i];
    } else if (arg === '-o' || arg === '--output') {
      args.output = argv[++i];
    } else if (arg === '--no-normalize') {
      args.normalizeRoutes = false;
    } else if (!arg.startsWith('-')) {
      args.files.push(arg);
    }
  }
  return args;
}

const HELP_TEXT = `
用法: node src/logstat.mjs [日志文件...] [选项]

支持格式:
  - Nginx / Apache Combined 扩展日志 (含响应耗时)
  - JSON Lines (含 method, path/url, status, latency/duration/rt 等字段)
  - Key=Value 格式 (如 method=GET path=/api/users status=200 latency=45ms)
  - 简明空格分隔日志 (如 2025-10-10T10:00:00Z GET /api/users 200 45ms)

选项:
  -n, --top <N>            慢请求与接口排行 Top N 数量 (默认: 10)
  -s, --slow <ms>          慢请求阈值毫秒数 (默认: 500)
  -m, --method <METHOD>    按 HTTP 方法过滤，支持逗号分隔 (如 GET,POST)
  -p, --path <PATTERN>     按路径子串过滤 (如 /api/orders)
      --status <FILTER>    按状态码过滤 (如 500, 5xx, 4xx,5xx, >=400)
      --min-latency <ms>   仅统计耗时 >= 指定毫秒数的请求
      --from <ISO_TIME>    起始时间过滤
      --to <ISO_TIME>      结束时间过滤
      --no-normalize       禁用动态路由 ID 归一化 (/users/123 不转为 /users/:id)
  -f, --format <FMT>       输出格式: text | json | markdown | csv (默认: text)
  -o, --output <FILE>      将分析结果写入指定文件
  -h, --help               显示帮助信息
`.trim();

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  let rawText = '';
  if (args.files.length > 0) {
    rawText = args.files.map((file) => fs.readFileSync(path.resolve(file), 'utf8')).join('\n');
  } else if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    rawText = Buffer.concat(chunks).toString('utf8');
  } else {
    console.log(HELP_TEXT);
    return;
  }

  const report = analyzeLogs(rawText, args);
  const formatted = formatReport(report, args.format);

  if (args.output) {
    fs.writeFileSync(path.resolve(args.output), formatted + '\n', 'utf8');
  } else {
    console.log(formatted);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  });
}

export default analyzeLogs;
