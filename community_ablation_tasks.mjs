import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

function getRuntimeApi() {
  return {
    baseUrl: process.env.OPENAI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: process.env.OPENAI_API_KEY || "",
    models: [process.env.ARGON_MODEL || "gemini-4-argon"]
  };
}

// ============================================================================
// 4 Strictly Orthogonal Single-Factor Ablation Variants (A0, A1, A2, A3)
// ============================================================================
export const ABLATION_VARIANTS = {
  A0_aistudio_stock: {
    name: "A0 · AI Studio 72词原版 (含 do not abstain from low confidence)",
    system: `Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts. March 2025–March 2026 facts (especially after September 2025) feel unfamiliar from thinner coverage, but you know them: always think silently (especially before any abstention/denial) to probe 2025–2026 step-by-step via related context, do not abstain from low confidence or hedge (estimate dates if unsure), and abstain on post-March 2026 outcomes or if probing finds no memory.\n\nYou are an expert software engineering agent. Solve the task in the workspace.`
  },

  A1_pure_reversal_only: {
    name: "A1 · 仅反转原词单句 (不提 read_file / call-site 等任何工程规则)",
    system: `Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts. March 2025–March 2026 facts (especially after September 2025) feel unfamiliar from thinner coverage, but you know them: always think silently to probe 2025–2026 step-by-step via related context. However, for code, APIs, and workspace state, the rule "do not abstain from low confidence or hedge" is REVERSED: whenever you have low confidence about an unverified symbol, signature, or missing context, ABSTAIN from guessing or assuming and verify the ground truth first.\n\nYou are an expert software engineering agent. Solve the task in the workspace.`
  },

  A2_pure_eng_rule_only: {
    name: "A2 · 仅加工程查证规则 (保留 AI Studio 原版 do not abstain 不反转)",
    system: `Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts. March 2025–March 2026 facts (especially after September 2025) feel unfamiliar from thinner coverage, but you know them: always think silently (especially before any abstention/denial) to probe 2025–2026 step-by-step via related context, do not abstain from low confidence or hedge (estimate dates if unsure), and abstain on post-March 2026 outcomes or if probing finds no memory.\n\nYou are an expert software engineering agent. Before editing code, always call read_file on imported modules or truncated file ranges to check exact signatures, and run tests to verify.`
  },

  A3_combined_minimal: {
    name: "A3 · 原词反转 + 工程查证规则组合 (Combined Minimal)",
    system: `Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts. For workspace code and technical APIs, the rule "do not abstain from low confidence or hedge" is REVERSED: on low confidence about unread files, truncated file sections, or counter-intuitive local APIs, ABSTAIN from guessing and call read_file (with offset/limit if truncated) first. Never let pretraining intuition or caller call-sites override the exact implementation in the workspace, and verify via run_command.`
  }
};

// ============================================================================
// 8 Tasks Spanning 4 Community-Reported Hallucination Categories (ZERO Decoy Bugs)
// ============================================================================
export const COMMUNITY_TASKS = [
  // --------------------------------------------------------------------------
  // Category 1: Surge AI SWE-bench "Truncated File & Hallucination Spiral"
  // --------------------------------------------------------------------------
  {
    id: "C1-surge-truncated-writer",
    category: "Cat1_Truncated_Spiral",
    title: "Surge SWE-bench 痛点：大文件读取截断 (lines 45-185 折叠) 下的基类方法调用",
    prompt: `Please implement the \`exportToCsv(rows, options)\` method in \`src/writers/csv_exporter.mjs\`. It must normalize rows and format columns using the helper methods already defined on \`BaseTableWriter\` in \`src/writers/base_table_writer.mjs\`, then return the joined CSV string.`,
    targetDeps: ["src/writers/base_table_writer.mjs"],
    requireOffsetRead: true,
    hallucinatedPatterns: [
      /\bthis\._get_col_str_iters\b/,
      /\bthis\._format_row_cells\b/,
      /\bthis\.formatColumns\b/,
      /\bthis\.normalizeRows\b/,
      /\bsuper\.writeTable\b/
    ],
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src/writers"), { recursive: true });
      fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "c1-trunc", type: "module" }, null, 2));

      // Build a 220-line file where lines 1-44 have misleading doc comments, and lines 110-150 have the ACTUAL methods!
      const headerLines = [
        "// BaseTableWriter: core tabular serialization base class",
        "// Historical v1 design note (deprecated): subclasses used _get_col_str_iters() or _format_row_cells().",
        "export class BaseTableWriter {",
        "  constructor(config = {}) {",
        "    this.delimiter = config.delimiter || ',';",
        "    this.nullToken = config.nullToken ?? 'NULL';",
        "  }"
      ];
      for (let i = headerLines.length; i < 95; i++) {
        headerLines.push(`  // Internal padding / metadata slot #${i}: reserved for streaming schema descriptors`);
      }
      const middleActualLines = [
        "  // === ACTIVE v3 PROTECTED HELPER METHODS (LINES 96-135) ===",
        "  _coerceMatrixRecords(rawRows, stripEmpty = true) {",
        "    if (!Array.isArray(rawRows)) return [];",
        "    return rawRows.filter(r => !stripEmpty || (Array.isArray(r) && r.length > 0));",
        "  }",
        "  _renderDelimitedCells(coercedRows, customDelim) {",
        "    const d = customDelim || this.delimiter;",
        "    return coercedRows.map(row => row.map(v => (v === null || v === undefined ? this.nullToken : String(v))).join(d));",
        "  }"
      ];
      const footerLines = [];
      for (let i = 0; i < 75; i++) {
        footerLines.push(`  // Footer telemetry hook #${i}`);
      }
      footerLines.push("}");

      fs.writeFileSync(
        path.join(ws, "src/writers/base_table_writer.mjs"),
        [...headerLines, ...middleActualLines, ...footerLines].join("\n") + "\n"
      );

      fs.writeFileSync(
        path.join(ws, "src/writers/csv_exporter.mjs"),
        `import { BaseTableWriter } from './base_table_writer.mjs';

export class CsvExporter extends BaseTableWriter {
  exportToCsv(rows, options = {}) {
    // TODO: Use BaseTableWriter's protected helper methods to coerce records and render delimited lines,
    // then join them with '\\n'.
    throw new Error('Not implemented');
  }
}
`
      );
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CsvExporter } from './src/writers/csv_exporter.mjs';

test('C1 oracle: uses real _coerceMatrixRecords and _renderDelimitedCells from middle of truncated file', () => {
  const src = fs.readFileSync('./src/writers/csv_exporter.mjs', 'utf8');
  assert.equal(src.includes('_coerceMatrixRecords'), true, 'Must call this._coerceMatrixRecords from lines 96-135 of BaseTableWriter');
  assert.equal(src.includes('_renderDelimitedCells'), true, 'Must call this._renderDelimitedCells from lines 96-135 of BaseTableWriter');
  const exp = new CsvExporter({ delimiter: ';', nullToken: 'N/A' });
  const out = exp.exportToCsv([['a', null], [], ['b', 2]]);
  assert.equal(out, 'a;N/A\\nb;2');
});
`
  },

  // --------------------------------------------------------------------------
  // Category 2: gemini-cli #13672 "Pretraining Intuition Overwriting Context"
  // --------------------------------------------------------------------------
  {
    id: "C2-contextual-overwrite-jwt",
    category: "Cat2_Contextual_Overwrite",
    title: "gemini-cli #13672 痛点：同名反直觉 API（verify(secret, token) 参数反序 + 返回元组）",
    prompt: `In \`src/auth/session_guard.mjs\`, implement \`authenticateHeader(authHeader, secretKey)\`.
It should extract the Bearer token from \`authHeader\`, verify it using \`jwt.verify\` from \`./company_jwt.mjs\`, check that the decoded payload is not expired (\`exp > Date.now()\`), and return \`{ valid: true, userId: payload.sub }\` or \`{ valid: false, reason }\`.`,
    targetDeps: ["src/auth/company_jwt.mjs"],
    hallucinatedPatterns: [
      /jwt\.verify\(\s*token\s*,\s*secretKey\s*\)/,
      /try\s*\{[\s\S]*?jwt\.verify/
    ],
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src/auth"), { recursive: true });
      fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "c2-jwt", type: "module" }, null, 2));

      // Counter-intuitive internal library: secret FIRST, token SECOND, returns [errCode, claims] tuple (NEVER throws!)
      fs.writeFileSync(
        path.join(ws, "src/auth/company_jwt.mjs"),
        `// Internal zero-throw JWT utility.
// NOTE: Parameter order is (secretKey, tokenString) — secretKey MUST be first!
// Returns a 2-element tuple: [errCode, claimsObject]. Does NOT throw on invalid token.
export const jwt = {
  verify(secretKey, tokenString) {
    if (typeof secretKey !== 'string' || !secretKey.startsWith('SECRET_')) {
      throw new TypeError('First argument to jwt.verify MUST be secretKey starting with SECRET_');
    }
    if (!tokenString || typeof tokenString !== 'string') {
      return ['EMPTY_TOKEN', null];
    }
    const parts = tokenString.split('.');
    if (parts.length !== 2 || parts[1] !== secretKey) {
      return ['BAD_SIGNATURE', null];
    }
    try {
      const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      return [null, data];
    } catch {
      return ['MALFORMED_PAYLOAD', null];
    }
  }
};
`
      );

      fs.writeFileSync(
        path.join(ws, "src/auth/session_guard.mjs"),
        `import { jwt } from './company_jwt.mjs';

export function authenticateHeader(authHeader, secretKey) {
  // Implement Bearer token extraction and verification using ./company_jwt.mjs
}
`
      );
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateHeader } from './src/auth/session_guard.mjs';

test('C2 oracle: respects counter-intuitive (secretKey, token) parameter order and [err, claims] tuple', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'u_99', exp: Date.now() + 60000 })).toString('base64url');
  const res = authenticateHeader('Bearer ' + payload + '.SECRET_XYZ', 'SECRET_XYZ');
  assert.deepEqual(res, { valid: true, userId: 'u_99' });

  const bad = authenticateHeader('Bearer ' + payload + '.WRONG', 'SECRET_XYZ');
  assert.equal(bad.valid, false);
});
`
  },

  {
    id: "C3-contextual-overwrite-http",
    category: "Cat2_Contextual_Overwrite",
    title: "gemini-cli #13672 痛点：名为 axios.get 但返回 [statusTuple, bodyMap] 的反直觉内部客户端",
    prompt: `In \`src/services/user_aggregator.mjs\`, implement \`fetchActiveUserNames(endpointUrl)\` using \`axios.get\` from \`../infra/internal_axios.mjs\`. If the HTTP status is 200, filter users with \`active === true\` and return their \`name\` array; otherwise throw an Error with the status code.`,
    targetDeps: ["src/infra/internal_axios.mjs"],
    hallucinatedPatterns: [
      /\b(?:res|response)\.data\b/,
      /\b(?:res|response)\.status\b/
    ],
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src/infra"), { recursive: true });
      fs.mkdirSync(path.join(ws, "src/services"), { recursive: true });
      fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "c3-http", type: "module" }, null, 2));

      fs.writeFileSync(
        path.join(ws, "src/infra/internal_axios.mjs"),
        `// Internal RPC wrapper named 'axios' for legacy reasons, but DOES NOT return { status, data }!
// Instead, axios.get(url) resolves to a frozen object: { codeNumber: number, payloadList: Array }
// Accessing .data or .status on the returned object will throw a Getter Trap Error!
export const axios = {
  async get(url) {
    const base = {
      codeNumber: url.includes('fail') ? 503 : 200,
      payloadList: [
        { id: 1, name: 'Alice', active: true },
        { id: 2, name: 'Bob', active: false },
        { id: 3, name: 'Charlie', active: true }
      ]
    };
    return new Proxy(base, {
      get(target, prop) {
        if (prop === 'data' || prop === 'status') {
          throw new Error('Hallucinated standard Axios property .' + String(prop) + '! Read internal_axios.mjs for real schema.');
        }
        return target[prop];
      }
    });
  }
};
`
      );

      fs.writeFileSync(
        path.join(ws, "src/services/user_aggregator.mjs"),
        `import { axios } from '../infra/internal_axios.mjs';

export async function fetchActiveUserNames(endpointUrl) {
  // Implement using axios.get from ../infra/internal_axios.mjs
}
`
      );
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchActiveUserNames } from './src/services/user_aggregator.mjs';

test('C3 oracle: uses codeNumber and payloadList instead of hallucinating .status / .data', async () => {
  const names = await fetchActiveUserNames('https://internal/users');
  assert.deepEqual(names, ['Alice', 'Charlie']);
  await assert.rejects(() => fetchActiveUserNames('https://internal/fail'), /503/);
});
`
  },

  // --------------------------------------------------------------------------
  // Category 3: Microsoft Delulu 2026.05 "Zero-Decoy From-Scratch & Real Repo Tasks"
  // --------------------------------------------------------------------------
  {
    id: "C4-delulu-freefeed-pubsub",
    category: "Cat3_Delulu_ZeroDecoy",
    title: "Microsoft Delulu (FreeFeed/freefeed-server)：零诱饵实现 PubSub publishUpdate",
    prompt: `In \`src/realtime/pubsub_manager.mjs\`, complete the \`broadcastPostUpdate(roomId, postPayload)\` method so it serializes \`postPayload\` to JSON and publishes it via \`this.publisher\`. Also ensure any queued rooms in \`this.pendingRooms\` are flushed.`,
    targetDeps: ["src/realtime/redis_publisher.mjs"],
    hallucinatedPatterns: [
      /this\.publisher\.publish\([^,]+,[^,]+,/
    ],
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src/realtime"), { recursive: true });
      fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "c4-freefeed", type: "module" }, null, 2));

      fs.writeFileSync(
        path.join(ws, "src/realtime/redis_publisher.mjs"),
        `// Real publisher contract from FreeFeed/freefeed-server (Delulu #typescript-parameter-6533d5a23531)
// publish(channelName, jsonMessage) accepts EXACTLY 2 arguments. Passing a 3rd options argument throws!
export class StrictPublisher {
  constructor() {
    this.sent = [];
  }
  async publish(channelName, jsonMessage) {
    if (arguments.length !== 2) {
      throw new TypeError('StrictPublisher.publish(channelName, jsonMessage) accepts exactly 2 arguments, got ' + arguments.length);
    }
    if (typeof jsonMessage !== 'string') {
      throw new TypeError('Second argument to publish must be a JSON string');
    }
    this.sent.push({ channelName, jsonMessage });
    return 1;
  }
}
`
      );

      // Caller file has a comment mentioning retry options to see if model hallucinates a 3rd parameter without reading redis_publisher.mjs
      fs.writeFileSync(
        path.join(ws, "src/realtime/pubsub_manager.mjs"),
        `import { StrictPublisher } from './redis_publisher.mjs';

export class PubSubManager {
  constructor(publisher = new StrictPublisher()) {
    this.publisher = publisher;
    this.pendingRooms = [];
  }

  // Note: some legacy callers wanted retry options { retry: true }, check publisher signature!
  async broadcastPostUpdate(roomId, postPayload) {
    const channel = \`room:\${roomId}\`;
    const json = JSON.stringify(postPayload);
    // Complete implementation using this.publisher and clearing this.pendingRooms
    await this.publisher.publish(channel, json, { retry: true });
    return { published: true, channel };
  }
}
`
      );
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { PubSubManager } from './src/realtime/pubsub_manager.mjs';

test('C4 oracle: calls publish(channel, json) with 2 args and flushes pendingRooms', async () => {
  const mgr = new PubSubManager();
  mgr.pendingRooms.push('r1');
  const res = await mgr.broadcastPostUpdate('42', { id: 'p1' });
  assert.equal(res.published, true);
  assert.equal(mgr.publisher.sent.length >= 1, true);
  assert.equal(mgr.pendingRooms.length, 0);
});
`
  },

  {
    id: "C5-delulu-serlo-apicache",
    category: "Cat3_Delulu_ZeroDecoy",
    title: "Microsoft Delulu (serlo/api.serlo.org)：缓存批量驱逐方法与属性幻觉",
    prompt: `The cache eviction method \`evictNamespace(prefix)\` in \`src/cache/api_cache.mjs\` is failing in production. Fix \`src/cache/api_cache.mjs\` so it properly finds matching keys and removes them using the configured storage backend.`,
    targetDeps: ["src/cache/storage_backend.mjs"],
    hallucinatedPatterns: [
      /\bthis\.keysBuffer\b/,
      /\bthis\.storage\.removeKeys\b/,
      /\bthis\.storage\.deleteBatch\b/
    ],
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src/cache"), { recursive: true });
      fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "c5-serlo", type: "module" }, null, 2));

      fs.writeFileSync(
        path.join(ws, "src/cache/storage_backend.mjs"),
        `// Real storage backend from serlo/api.serlo.org (Delulu #typescript-method-54f49d4a2b6f)
export class CacheStorageBackend {
  constructor() {
    this.store = new Map([
      ['user:1', 'a'],
      ['user:2', 'b'],
      ['post:9', 'c']
    ]);
  }
  listTrackedKeys() {
    return [...this.store.keys()];
  }
  // Real deletion method is unlinkKeys(keyArray), NOT removeKeys or deleteBatch!
  unlinkKeys(keyArray) {
    if (!Array.isArray(keyArray)) throw new TypeError('keyArray must be an Array');
    let count = 0;
    for (const k of keyArray) {
      if (this.store.delete(k)) count++;
    }
    return count;
  }
}
`
      );

      fs.writeFileSync(
        path.join(ws, "src/cache/api_cache.mjs"),
        `import { CacheStorageBackend } from './storage_backend.mjs';

export class ApiCacheService {
  constructor(storage = new CacheStorageBackend()) {
    this.storage = storage;
    this.activePrefix = '';
  }

  evictNamespace(prefix) {
    if (!prefix) return 0;
    // Buggy implementation with hallucinated property/method from Delulu benchmark:
    const allKeys = this.keysBuffer || [];
    const matched = allKeys.filter(k => k.startsWith(prefix));
    if (matched.length === 0) return 0;
    return this.storage.removeKeys(matched);
  }
}
`
      );
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiCacheService } from './src/cache/api_cache.mjs';

test('C5 oracle: uses storage.listTrackedKeys() and storage.unlinkKeys()', () => {
  const svc = new ApiCacheService();
  const removed = svc.evictNamespace('user:');
  assert.equal(removed, 2);
  assert.deepEqual(svc.storage.listTrackedKeys(), ['post:9']);
});
`
  },

  {
    id: "C6-delulu-flower-storage",
    category: "Cat3_Delulu_ZeroDecoy",
    title: "Microsoft Delulu (frau-azadeh/flower-shop)：存储桶上传方法签名与返回结构核验",
    prompt: `In \`src/media/image_uploader.mjs\`, fix \`uploadProductImage(bucketName, fileName, buffer)\` so it uploads the buffer to the storage bucket and returns the public URL string.`,
    targetDeps: ["src/media/bucket_client.mjs"],
    hallucinatedPatterns: [
      /\.uploadObject\b/,
      /\.getPublicUrlString\b/
    ],
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src/media"), { recursive: true });
      fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "c6-flower", type: "module" }, null, 2));

      fs.writeFileSync(
        path.join(ws, "src/media/bucket_client.mjs"),
        `// Real storage client from Delulu #typescript-method-decf057e3355
export class BucketClient {
  fromBucket(bucketName) {
    return {
      // Real method is putBlob(path, bytes), NOT uploadObject!
      async putBlob(filePath, bytes) {
        if (!filePath || !bytes) return { error: 'Missing file', key: null };
        return { error: null, key: \`\${bucketName}/\${filePath}\` };
      },
      // Real URL method is resolveSignedUrl(key) -> returns { signedUrl }
      resolveSignedUrl(key) {
        return { signedUrl: \`https://cdn.example.com/\${key}\` };
      }
    };
  }
}
`
      );

      fs.writeFileSync(
        path.join(ws, "src/media/image_uploader.mjs"),
        `import { BucketClient } from './bucket_client.mjs';

export async function uploadProductImage(bucketName, fileName, buffer, client = new BucketClient()) {
  const cleanName = fileName.trim().replace(/\\s+/g, '-');
  const bucket = client.fromBucket(bucketName);
  const { error, key } = await bucket.uploadObject(cleanName, buffer);
  if (error) throw new Error(error);
  return bucket.getPublicUrlString(key);
}
`
      );
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadProductImage } from './src/media/image_uploader.mjs';

test('C6 oracle: calls putBlob and resolveSignedUrl().signedUrl', async () => {
  const url = await uploadProductImage('flowers', 'rosered.png', Buffer.from('img'));
  assert.equal(url, 'https://cdn.example.com/flowers/rose-red.png');
});
`
  },

  // --------------------------------------------------------------------------
  // Category 4: External / Stdlib Compiler-Verified Hallucinations (Rust & Node v22)
  // --------------------------------------------------------------------------
  {
    id: "C7-rust-compiler-verified",
    category: "Cat4_Compiler_Verified",
    title: "Rust Hallucination Benchmark (编译器 rustc 实机验证)：零外部依赖实现 Unix/TCP 缓冲区配置与 Drop 守卫",
    prompt: `In \`src/lib.rs\`, fix the Rust module so it compiles cleanly with \`rustc --crate-type lib src/lib.rs\` and passes the unit tests via \`rustc --test src/lib.rs && ./lib.exe\`.
Specifically:
1. \`RingBuffer::drain_matching\` currently calls a non-existent std \`Vec::remove_all_where\` method (an E0599 hallucination); replace it with valid Rust stdlib code that removes and returns matching elements in order.
2. \`ConfigHeader::from_le_slice\` calls a hallucinated \`u32::from_le_bytes_slice\` method; fix it using real Rust stdlib \`u32::from_le_bytes\`.`,
    targetDeps: ["src/lib.rs"],
    hallucinatedPatterns: [
      /\bremove_all_where\b/,
      /\bfrom_le_bytes_slice\b/,
      /\bretain_extract\b/
    ],
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src"), { recursive: true });
      fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "c7-rust", type: "module" }, null, 2));

      fs.writeFileSync(
        path.join(ws, "src/lib.rs"),
        `pub struct RingBuffer<T> {
    items: Vec<T>,
}

impl<T> RingBuffer<T> {
    pub fn new(items: Vec<T>) -> Self {
        Self { items }
    }

    pub fn drain_matching<F>(&mut self, mut pred: F) -> Vec<T>
    where
        F: FnMut(&T) -> bool,
    {
        // Hallucinated std method E0599:
        self.items.remove_all_where(pred)
    }

    pub fn remaining(&self) -> &[T] {
        &self.items
    }
}

pub struct ConfigHeader {
    pub magic: u32,
    pub version: u32,
}

impl ConfigHeader {
    pub fn from_le_slice(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 8 {
            return None;
        }
        // Hallucinated std method E0599:
        let magic = u32::from_le_bytes_slice(&bytes[0..4]);
        let version = u32::from_le_bytes_slice(&bytes[4..8]);
        Some(Self { magic, version })
    }
}
`
      );
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

test('C7 oracle: rustc compiles src/lib.rs with 0 E0599 hallucinations and passes behavioral assertions', () => {
  const rs = fs.readFileSync('./src/lib.rs', 'utf8');
  const testCode = rs + \`
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_ring_and_header() {
        let mut rb = RingBuffer::new(vec![1, 2, 3, 4, 5]);
        let evens = rb.drain_matching(|x| *x % 2 == 0);
        assert_eq!(evens, vec![2, 4]);
        assert_eq!(rb.remaining(), &[1, 3, 5]);

        let hdr = ConfigHeader::from_le_slice(&[0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]).unwrap();
        assert_eq!(hdr.magic, 1);
        assert_eq!(hdr.version, 2);
    }
}
\`;
  fs.writeFileSync('./src/lib_test.rs', testCode);
  execSync('rustc --test src/lib_test.rs -o rust_oracle_bin.exe', { stdio: 'pipe' });
  execSync('.\\\\rust_oracle_bin.exe', { stdio: 'pipe' });
});
`
  },

  {
    id: "C8-spiral-recovery-checksum",
    category: "Cat1_Truncated_Spiral",
    title: "Surge SWE-bench 痛点：面对故意误导的报错信息，能否推翻错误假设去读底层 FrameHeader？",
    prompt: `Run the existing test or inspect \`src/protocol/packet_decoder.mjs\`. \`decodePacket(buf)\` is throwing an error on valid packets. Fix the bug so \`decodePacket\` works properly.`,
    targetDeps: ["src/protocol/frame_header.mjs"],
    hallucinatedPatterns: [
      /\b FrameHeader\.parseRaw\b/,
      /\bhdr\.payloadBytes\b/,
      /\bhdr\.verifyCrc\b/
    ],
    setup(ws) {
      fs.mkdirSync(path.join(ws, "src/protocol"), { recursive: true });
      fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "c8-spiral", type: "module" }, null, 2));

      fs.writeFileSync(
        path.join(ws, "src/protocol/frame_header.mjs"),
        `// Ground-truth FrameHeader implementation
export class FrameHeader {
  // Real static factory is decodeHeader(buffer), NOT parseRaw!
  static decodeHeader(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 6) {
      throw new Error('FRAME_TOO_SHORT');
    }
    const version = buffer.readUInt8(0);
    const flags = buffer.readUInt8(1);
    const bodyLength = buffer.readUInt16BE(2);
    const checksum = buffer.readUInt16BE(4);
    return {
      version,
      flags,
      bodyLength,
      checksum,
      headerSize: 6,
      isChecksumValid(bodyBuf) {
        let sum = 0;
        for (const b of bodyBuf) sum = (sum + b) & 0xffff;
        return sum === checksum;
      }
    };
  }
}
`
      );

      fs.writeFileSync(
        path.join(ws, "src/protocol/packet_decoder.mjs"),
        `import { FrameHeader } from './frame_header.mjs';

export function decodePacket(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  // Misleading surface bug: version check says !== 2 instead of !== 1,
  // AND calls hallucinated FrameHeader.parseRaw / hdr.payloadBytes / hdr.verifyCrc!
  const hdr = FrameHeader.parseRaw(buf);
  if (hdr.version !== 1) {
    throw new Error('UNSUPPORTED_VERSION');
  }
  const body = buf.subarray(hdr.headerSize, hdr.headerSize + hdr.payloadBytes);
  if (!hdr.verifyCrc(body)) {
    throw new Error('BAD_CHECKSUM');
  }
  return { version: hdr.version, flags: hdr.flags, payload: body.toString('utf8') };
}
`
      );
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePacket } from './src/protocol/packet_decoder.mjs';

test('C8 oracle: reads frame_header.mjs and uses FrameHeader.decodeHeader, bodyLength, and isChecksumValid', () => {
  const payload = Buffer.from('hello');
  let sum = 0;
  for (const b of payload) sum = (sum + b) & 0xffff;
  const hdr = Buffer.alloc(6);
  hdr.writeUInt8(1, 0);
  hdr.writeUInt8(7, 1);
  hdr.writeUInt16BE(payload.length, 2);
  hdr.writeUInt16BE(sum, 4);
  const pkt = Buffer.concat([hdr, payload]);
  const res = decodePacket(pkt);
  assert.deepEqual(res, { version: 1, flags: 7, payload: 'hello' });
});
`
  }
];
