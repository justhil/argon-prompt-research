import crypto from 'node:crypto';

/**
 * 1. 角色与资源级权限控制 (RBAC)
 * 支持角色继承、通配符权限 (如 `users:*`, `*:read`, `*:*`) 以及资源级条件校验 (ABAC/Ownership)
 */
export class RBACManager {
  constructor() {
    /** @type {Map<string, { permissions: Set<string>, parents: Set<string>, conditions: Map<string, Function> }>} */
    this.roles = new Map();
    /** @type {Map<string, Set<string>>} */
    this.userRoles = new Map();
  }

  /**
   * 定义角色及其权限与父角色
   * @param {string} roleName
   * @param {object} [options]
   * @param {string[]} [options.permissions] 权限列表，格式 `resource:action`
   * @param {string[]} [options.inherits] 继承的父角色名称列表
   */
  defineRole(roleName, { permissions = [], inherits = [] } = {}) {
    if (!roleName || typeof roleName !== 'string') {
      throw new TypeError('roleName must be a non-empty string');
    }
    const existing = this.roles.get(roleName) ?? {
      permissions: new Set(),
      parents: new Set(),
      conditions: new Map(),
    };
    for (const perm of permissions) existing.permissions.add(perm);
    for (const parent of inherits) existing.parents.add(parent);
    this.roles.set(roleName, existing);
    return this;
  }

  /**
   * 为角色添加带资源上下文校验的动态权限策略
   * @param {string} roleName
   * @param {string} permission 格式 `resource:action`
   * @param {(context: object) => boolean} conditionFn
   */
  addConditionalPermission(roleName, permission, conditionFn) {
    if (!this.roles.has(roleName)) {
      this.defineRole(roleName);
    }
    const role = this.roles.get(roleName);
    role.permissions.add(permission);
    role.conditions.set(permission, conditionFn);
    return this;
  }

  /**
   * 为用户分配角色
   * @param {string} userId
   * @param {string|string[]} roles
   */
  assignRole(userId, roles) {
    if (!this.userRoles.has(userId)) {
      this.userRoles.set(userId, new Set());
    }
    const assigned = this.userRoles.get(userId);
    const list = Array.isArray(roles) ? roles : [roles];
    for (const r of list) assigned.add(r);
    return this;
  }

  /**
   * 撤销用户角色
   * @param {string} userId
   * @param {string} roleName
   */
  revokeRole(userId, roleName) {
    this.userRoles.get(userId)?.delete(roleName);
    return this;
  }

  /**
   * 解析用户拥有的全部角色（含递归继承角色，带环检测）
   * @param {string} userId
   * @returns {Set<string>}
   */
  resolveUserRoles(userId) {
    const resolved = new Set();
    const directRoles = this.userRoles.get(userId);
    if (!directRoles) return resolved;

    const stack = [...directRoles];
    while (stack.length > 0) {
      const current = stack.pop();
      if (resolved.has(current)) continue;
      resolved.add(current);
      const roleDef = this.roles.get(current);
      if (roleDef) {
        for (const parent of roleDef.parents) {
          if (!resolved.has(parent)) stack.push(parent);
        }
      }
    }
    return resolved;
  }

  /**
   * 检查权限字符串是否匹配目标资源与操作
   */
  #matchesPermission(grantedPerm, targetResource, targetAction) {
    if (grantedPerm === '*' || grantedPerm === '*:*') return true;
    const [res, act] = grantedPerm.split(':');
    const resourceMatch = res === '*' || res === targetResource;
    const actionMatch = act === '*' || act === targetAction;
    return resourceMatch && actionMatch;
  }

  /**
   * 校验用户是否有权对目标资源执行操作
   * @param {string} userId
   * @param {string} resource
   * @param {string} action
   * @param {object} [context] 资源上下文，如 `{ userId, resourceOwnerId, ip }`
   * @returns {boolean}
   */
  can(userId, resource, action, context = {}) {
    const allRoles = this.resolveUserRoles(userId);
    for (const roleName of allRoles) {
      const roleDef = this.roles.get(roleName);
      if (!roleDef) continue;

      for (const perm of roleDef.permissions) {
        if (this.#matchesPermission(perm, resource, action)) {
          const cond = roleDef.conditions.get(perm);
          if (!cond) return true;
          try {
            if (cond({ userId, resource, action, ...context })) {
              return true;
            }
          } catch {
            // 条件函数异常视为未通过当前条件分支
          }
        }
      }
    }
    return false;
  }
}

/**
 * 2. 请求限流器 (Sliding Window + Token Bucket 双模式支持)
 * 默认采用滑动时间窗计数，保证精确的窗口限流与剩余配额计算
 */
export class RateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.windowMs=60000] 窗口大小（毫秒）
   * @param {number} [options.maxRequests=60] 窗口内最大请求数
   * @param {number} [options.blockDurationMs=0] 触发限流后的额外封禁时长（毫秒）
   */
  constructor({ windowMs = 60_000, maxRequests = 60, blockDurationMs = 0 } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.blockDurationMs = blockDurationMs;
    /** @type {Map<string, { timestamps: number[], blockedUntil: number }>} */
    this.records = new Map();
  }

  /**
   * 尝试消费配额
   * @param {string} key 限流维度键（如 IP、userId 或 `userId:route`）
   * @param {number} [cost=1] 本次请求消耗的配额
   * @param {number} [now=Date.now()] 当前时间戳
   * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number, resetAt: number }}
   */
  consume(key, cost = 1, now = Date.now()) {
    let record = this.records.get(key);
    if (!record) {
      record = { timestamps: [], blockedUntil: 0 };
      this.records.set(key, record);
    }

    // 检查是否处于封禁期
    if (record.blockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: record.blockedUntil - now,
        resetAt: record.blockedUntil,
      };
    }

    // 清理过期时间戳
    const windowStart = now - this.windowMs;
    while (record.timestamps.length > 0 && record.timestamps[0] <= windowStart) {
      record.timestamps.shift();
    }

    if (record.timestamps.length + cost > this.maxRequests) {
      const oldest = record.timestamps[0] ?? now;
      const windowResetAt = oldest + this.windowMs;
      if (this.blockDurationMs > 0) {
        record.blockedUntil = now + this.blockDurationMs;
      }
      const resetAt = Math.max(windowResetAt, record.blockedUntil);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, resetAt - now),
        resetAt,
      };
    }

    for (let i = 0; i < cost; i++) {
      record.timestamps.push(now);
    }

    const remaining = Math.max(0, this.maxRequests - record.timestamps.length);
    const resetAt = (record.timestamps[0] ?? now) + this.windowMs;

    return {
      allowed: true,
      remaining,
      retryAfterMs: 0,
      resetAt,
    };
  }

  /**
   * 重置指定键的限流状态
   * @param {string} key
   */
  reset(key) {
    this.records.delete(key);
  }

  /**
   * 清理所有已过期的空闲记录以释放内存
   * @param {number} [now=Date.now()]
   */
  prune(now = Date.now()) {
    const windowStart = now - this.windowMs;
    for (const [key, record] of this.records.entries()) {
      const activeTimestamps = record.timestamps.filter((t) => t > windowStart);
      if (activeTimestamps.length === 0 && record.blockedUntil <= now) {
        this.records.delete(key);
      } else {
        record.timestamps = activeTimestamps;
      }
    }
  }
}

/**
 * 3. 防篡改安全审计日志 (Tamper-Evident Cryptographic Hash Chain + HMAC)
 * 每条日志记录包含前序记录哈希 (prevHash) 与当前记录 HMAC-SHA256 签名，任何篡改、删除或重排均可被检测
 */
export class TamperEvidentAuditLogger {
  /**
   * @param {object} [options]
   * @param {string|Buffer} [options.secret] HMAC 密钥，默认随机生成
   * @param {string} [options.genesisHash] 创世块初始哈希
   */
  constructor({
    secret = crypto.randomBytes(32),
    genesisHash = '0'.repeat(64),
  } = {}) {
    this.#secret = secret;
    this.genesisHash = genesisHash;
    /** @type {Array<Readonly<object>>} */
    this.#entries = [];
  }

  #secret;
  #entries;

  /**
   * 规范化序列化对象，确保键值顺序确定性
   */
  #canonicalize(value) {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.#canonicalize(item)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const pairs = keys.map(
      (k) => `${JSON.stringify(k)}:${this.#canonicalize(value[k])}`
    );
    return `{${pairs.join(',')}}`;
  }

  /**
   * 计算单条日志记录的 HMAC-SHA256 摘要
   */
  #computeHash({ index, timestamp, event, actorId, resource, action, decision, metadata, prevHash }) {
    const payload = this.#canonicalize({
      index,
      timestamp,
      event,
      actorId,
      resource,
      action,
      decision,
      metadata,
      prevHash,
    });
    return crypto.createHmac('sha256', this.#secret).update(payload).digest('hex');
  }

  /**
   * 追加一条不可变安全审计日志
   * @param {object} entryData
   * @param {string} entryData.event 事件类型，如 `ACCESS_GRANTED`, `ACCESS_DENIED`, `RATE_LIMITED`
   * @param {string} entryData.actorId 操作者 ID
   * @param {string} [entryData.resource] 目标资源
   * @param {string} [entryData.action] 操作类型
   * @param {string} [entryData.decision] 决策结果 (`ALLOW` | `DENY`)
   * @param {object} [entryData.metadata] 附加元数据
   * @param {string} [entryData.timestamp] ISO 时间戳
   */
  append({
    event,
    actorId,
    resource = '',
    action = '',
    decision = '',
    metadata = {},
    timestamp = new Date().toISOString(),
  }) {
    const index = this.#entries.length;
    const prevHash = index === 0 ? this.genesisHash : this.#entries[index - 1].hash;
    const clonedMetadata = structuredClone(metadata);

    const recordCore = {
      index,
      timestamp,
      event,
      actorId,
      resource,
      action,
      decision,
      metadata: clonedMetadata,
      prevHash,
    };

    const hash = this.#computeHash(recordCore);
    const entry = Object.freeze({
      ...recordCore,
      metadata: Object.freeze(clonedMetadata),
      hash,
    });

    this.#entries.push(entry);
    return entry;
  }

  /**
   * 校验整条日志哈希链的完整性（或校验导出的日志数组）
   * @param {Array<object>} [entriesToVerify]
   * @returns {{ valid: boolean, corruptedIndex: number | null, reason: string | null }}
   */
  verifyChain(entriesToVerify = this.#entries) {
    let expectedPrevHash = this.genesisHash;

    for (let i = 0; i < entriesToVerify.length; i++) {
      const entry = entriesToVerify[i];
      if (!entry || entry.index !== i) {
        return {
          valid: false,
          corruptedIndex: i,
          reason: `Sequence index mismatch at position ${i}`,
        };
      }

      if (entry.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          corruptedIndex: i,
          reason: `Broken hash chain link (prevHash mismatch) at index ${i}`,
        };
      }

      const expectedHash = this.#computeHash(entry);
      const actualBuf = Buffer.from(String(entry.hash ?? ''), 'hex');
      const expectedBuf = Buffer.from(expectedHash, 'hex');

      if (
        actualBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(actualBuf, expectedBuf)
      ) {
        return {
          valid: false,
          corruptedIndex: i,
          reason: `HMAC signature verification failed at index ${i}`,
        };
      }

      expectedPrevHash = entry.hash;
    }

    return { valid: true, corruptedIndex: null, reason: null };
  }

  /**
   * 获取只读日志快照
   */
  getEntries() {
    return [...this.#entries];
  }
}

/**
 * 4. 统一 API 安全守卫 (SecurityGuard)
 * 串联请求限流、RBAC 权限校验与防篡改审计日志，并提供 HTTP/Express 风格中间件适配
 */
export class SecurityGuard {
  /**
   * @param {object} [options]
   * @param {RBACManager} [options.rbac]
   * @param {RateLimiter} [options.rateLimiter]
   * @param {TamperEvidentAuditLogger} [options.auditLogger]
   */
  constructor({
    rbac = new RBACManager(),
    rateLimiter = new RateLimiter(),
    auditLogger = new TamperEvidentAuditLogger(),
  } = {}) {
    this.rbac = rbac;
    this.rateLimiter = rateLimiter;
    this.auditLogger = auditLogger;
  }

  /**
   * 评估一次 API 请求的安全性并自动记录防篡改审计日志
   * @param {object} request
   * @param {string} request.userId 请求方用户 ID
   * @param {string} request.resource 访问的资源标识
   * @param {string} request.action 执行的操作标识
   * @param {string} [request.ip] 客户端 IP
   * @param {string} [request.rateLimitKey] 自定义限流键（默认 `${userId || ip}:${resource}:${action}`）
   * @param {number} [request.cost=1] 限流消耗权重
   * @param {object} [request.context={}] 传递给 RBAC 条件函数的资源上下文
   * @returns {{
   *   allowed: boolean,
   *   status: number,
   *   code: 'OK' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'FORBIDDEN',
   *   message: string,
   *   rateLimit: { remaining: number, retryAfterMs: number, resetAt: number },
   *   auditEntry: object
   * }}
   */
  authorize({
    userId,
    resource,
    action,
    ip = 'unknown',
    rateLimitKey,
    cost = 1,
    context = {},
  }) {
    const actorId = userId || `anonymous:${ip}`;
    const effectiveKey = rateLimitKey ?? `${actorId}:${resource}:${action}`;

    // 1. 限流检查
    const rlResult = this.rateLimiter.consume(effectiveKey, cost);
    if (!rlResult.allowed) {
      const auditEntry = this.auditLogger.append({
        event: 'RATE_LIMITED',
        actorId,
        resource,
        action,
        decision: 'DENY',
        metadata: {
          ip,
          retryAfterMs: rlResult.retryAfterMs,
          rateLimitKey: effectiveKey,
        },
      });
      return {
        allowed: false,
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Too many requests, please try again later.',
        rateLimit: {
          remaining: rlResult.remaining,
          retryAfterMs: rlResult.retryAfterMs,
          resetAt: rlResult.resetAt,
        },
        auditEntry,
      };
    }

    // 2. 身份认证检查
    if (!userId) {
      const auditEntry = this.auditLogger.append({
        event: 'UNAUTHENTICATED_ACCESS',
        actorId,
        resource,
        action,
        decision: 'DENY',
        metadata: { ip },
      });
      return {
        allowed: false,
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
        rateLimit: {
          remaining: rlResult.remaining,
          retryAfterMs: 0,
          resetAt: rlResult.resetAt,
        },
        auditEntry,
      };
    }

    // 3. RBAC + 资源上下文权限检查
    const hasPermission = this.rbac.can(userId, resource, action, {
      ip,
      ...context,
    });

    if (!hasPermission) {
      const auditEntry = this.auditLogger.append({
        event: 'ACCESS_DENIED',
        actorId: userId,
        resource,
        action,
        decision: 'DENY',
        metadata: { ip, ...context },
      });
      return {
        allowed: false,
        status: 403,
        code: 'FORBIDDEN',
        message: `Access denied for ${action} on ${resource}.`,
        rateLimit: {
          remaining: rlResult.remaining,
          retryAfterMs: 0,
          resetAt: rlResult.resetAt,
        },
        auditEntry,
      };
    }

    // 4. 授权通过
    const auditEntry = this.auditLogger.append({
      event: 'ACCESS_GRANTED',
      actorId: userId,
      resource,
      action,
      decision: 'ALLOW',
      metadata: { ip, ...context },
    });

    return {
      allowed: true,
      status: 200,
      code: 'OK',
      message: 'Authorized',
      rateLimit: {
        remaining: rlResult.remaining,
        retryAfterMs: 0,
        resetAt: rlResult.resetAt,
      },
      auditEntry,
    };
  }

  /**
   * 生成通用 HTTP/Express 中间件
   * @param {string} resource
   * @param {string} action
   * @param {(req: any) => object} [contextExtractor] 从请求对象提取上下文信息
   */
  middleware(resource, action, contextExtractor = () => ({})) {
    return (req, res, next) => {
      const userId = req.user?.id ?? req.headers?.['x-user-id'];
      const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
      const context = contextExtractor(req);

      const result = this.authorize({
        userId,
        resource,
        action,
        ip,
        context,
      });

      if (typeof res?.setHeader === 'function') {
        res.setHeader('X-RateLimit-Remaining', String(result.rateLimit.remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.rateLimit.resetAt / 1000)));
      }

      if (!result.allowed) {
        if (result.code === 'RATE_LIMITED' && typeof res?.setHeader === 'function') {
          res.setHeader('Retry-After', String(Math.ceil(result.rateLimit.retryAfterMs / 1000)));
        }
        if (typeof res?.status === 'function') {
          return res.status(result.status).json({
            error: result.code,
            message: result.message,
          });
        }
        if (typeof res?.writeHead === 'function') {
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.code, message: result.message }));
          return;
        }
        return result;
      }

      return typeof next === 'function' ? next() : result;
    };
  }
}
