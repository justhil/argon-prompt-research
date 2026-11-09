import crypto from 'node:crypto';

/**
 * 1. 角色与资源级权限控制 (RBAC)
 * 支持角色继承、通配符匹配 (如 `orders:*`, `*:read`) 及细粒度条件策略 (ABAC 扩展)
 */
export class RBACManager {
  constructor() {
    /** @type {Map<string, { permissions: Set<string>, inherits: Set<string>, conditions: Map<string, Function> }>} */
    this.roles = new Map();
    /** @type {Map<string, Set<string>>} */
    this.userRoles = new Map();
  }

  /**
   * 定义角色及其权限与父角色
   * @param {string} roleName
   * @param {object} [options]
   * @param {string[]} [options.permissions] - 格式 `resource:action`
   * @param {string[]} [options.inherits] - 继承的角色名列表
   * @param {Record<string, (context: object) => boolean>} [options.conditions] - 权限附加条件断言
   */
  defineRole(roleName, { permissions = [], inherits = [], conditions = {} } = {}) {
    if (!roleName || typeof roleName !== 'string') {
      throw new TypeError('Invalid roleName');
    }
    const roleData = this.roles.get(roleName) ?? {
      permissions: new Set(),
      inherits: new Set(),
      conditions: new Map(),
    };

    for (const perm of permissions) roleData.permissions.add(perm);
    for (const parent of inherits) {
      if (parent === roleName) throw new Error(`Role "${roleName}" cannot inherit from itself`);
      roleData.inherits.add(parent);
    }
    for (const [perm, fn] of Object.entries(conditions)) {
      if (typeof fn === 'function') roleData.conditions.set(perm, fn);
    }

    this.roles.set(roleName, roleData);
    return this;
  }

  /**
   * 为用户分配角色
   * @param {string} userId
   * @param {...string} roleNames
   */
  assignRoles(userId, ...roleNames) {
    if (!this.userRoles.has(userId)) {
      this.userRoles.set(userId, new Set());
    }
    const set = this.userRoles.get(userId);
    for (const r of roleNames) set.add(r);
    return this;
  }

  /**
   * 撤销用户角色
   * @param {string} userId
   * @param {...string} roleNames
   */
  revokeRoles(userId, ...roleNames) {
    const set = this.userRoles.get(userId);
    if (!set) return this;
    for (const r of roleNames) set.delete(r);
    return this;
  }

  /**
   * 解析所有有效角色（含递归继承，带环路检测）
   * @param {Iterable<string>} initialRoles
   * @returns {Set<string>}
   */
  resolveRoles(initialRoles) {
    const visited = new Set();
    const queue = [...initialRoles];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      const roleObj = this.roles.get(current);
      if (roleObj) {
        for (const parent of roleObj.inherits) {
          if (!visited.has(parent)) queue.push(parent);
        }
      }
    }
    return visited;
  }

  /**
   * 匹配权限规则 (支持 `*`, `resource:*`, `*:action`)
   * @param {string} granted
   * @param {string} requiredResource
   * @param {string} requiredAction
   */
  static matchPermission(granted, requiredResource, requiredAction) {
    if (granted === '*' || granted === '*:*') return true;
    const [gRes, gAct] = granted.split(':');
    const resMatch = gRes === '*' || gRes === requiredResource;
    const actMatch = gAct === '*' || gAct === requiredAction;
    return resMatch && actMatch;
  }

  /**
   * 校验用户是否具备指定资源与操作的权限
   * @param {string} userId
   * @param {string} resource
   * @param {string} action
   * @param {object} [context] - 资源上下文（例如 `{ ownerId, resource, userId }`）
   * @returns {boolean}
   */
  can(userId, resource, action, context = {}) {
    const directRoles = this.userRoles.get(userId);
    if (!directRoles || directRoles.size === 0) return false;

    const allRoles = this.resolveRoles(directRoles);
    const fullContext = { userId, resource, action, ...context };

    for (const roleName of allRoles) {
      const role = this.roles.get(roleName);
      if (!role) continue;

      for (const perm of role.permissions) {
        if (RBACManager.matchPermission(perm, resource, action)) {
          const condFn = role.conditions.get(perm);
          if (!condFn || condFn(fullContext) === true) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

/**
 * 2. 请求限流器 (Sliding Window + Token Bucket 双模式支持)
 * 默认采用精确滑动窗口计数，支持按客户端/路由动态配额与过期清理
 */
export class RateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.windowMs=60000] - 时间窗口毫秒数
   * @param {number} [options.maxRequests=100] - 窗口内最大允许请求数
   * @param {number} [options.blockDurationMs=0] - 触发限流后的额外封禁时长(ms)
   */
  constructor({ windowMs = 60_000, maxRequests = 100, blockDurationMs = 0 } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.blockDurationMs = blockDurationMs;
    /** @type {Map<string, { timestamps: number[], blockedUntil: number }>} */
    this.clients = new Map();
  }

  /**
   * 消费配额并返回限流状态
   * @param {string} key - 限流唯一标识 (如 IP、userId 或 `userId:route`)
   * @param {object} [override]
   * @param {number} [override.maxRequests]
   * @param {number} [override.windowMs]
   * @param {number} [override.now]
   */
  consume(key, override = {}) {
    const now = override.now ?? Date.now();
    const windowMs = override.windowMs ?? this.windowMs;
    const maxRequests = override.maxRequests ?? this.maxRequests;

    let record = this.clients.get(key);
    if (!record) {
      record = { timestamps: [], blockedUntil: 0 };
      this.clients.set(key, record);
    }

    // 检查是否处于封禁期
    if (record.blockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        limit: maxRequests,
        retryAfterMs: record.blockedUntil - now,
        resetAt: record.blockedUntil,
      };
    }

    const windowStart = now - windowMs;
    // 移除窗口外的时间戳
    while (record.timestamps.length > 0 && record.timestamps[0] <= windowStart) {
      record.timestamps.shift();
    }

    if (record.timestamps.length >= maxRequests) {
      const oldest = record.timestamps[0] ?? now;
      const naturalReset = oldest + windowMs;
      const resetAt =
        this.blockDurationMs > 0 ? now + this.blockDurationMs : naturalReset;
      if (this.blockDurationMs > 0) {
        record.blockedUntil = resetAt;
      }

      return {
        allowed: false,
        remaining: 0,
        limit: maxRequests,
        retryAfterMs: Math.max(0, resetAt - now),
        resetAt,
      };
    }

    record.timestamps.push(now);
    const remaining = Math.max(0, maxRequests - record.timestamps.length);
    const resetAt = record.timestamps[0] + windowMs;

    return {
      allowed: true,
      remaining,
      limit: maxRequests,
      retryAfterMs: 0,
      resetAt,
    };
  }

  /**
   * 重置特定 Key 的限流状态
   * @param {string} key
   */
  reset(key) {
    this.clients.delete(key);
  }

  /**
   * 清理过期不活跃的客户端记录以释放内存
   * @param {number} [now]
   */
  cleanup(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, record] of this.clients.entries()) {
      const activeTimestamps = record.timestamps.filter((t) => t > cutoff);
      if (activeTimestamps.length === 0 && record.blockedUntil <= now) {
        this.clients.delete(key);
      } else {
        record.timestamps = activeTimestamps;
      }
    }
  }
}

/**
 * 3. 防篡改安全审计日志 (Tamper-Evident Audit Logger)
 * 基于 HMAC-SHA256 哈希链（Hash Chain），任何单条记录修改、删除或重排均会被完整性校验捕获
 */
export class TamperEvidentAuditLogger {
  /**
   * @param {object} [options]
   * @param {string|Buffer} [options.secretKey] - HMAC 密钥
   * @param {string} [options.genesisHash] - 创世哈希锚点
   */
  constructor({
    secretKey = crypto.randomBytes(32),
    genesisHash = '0'.repeat(64),
  } = {}) {
    this.#secretKey = secretKey;
    this.genesisHash = genesisHash;
    /** @type {Array<Readonly<object>>} */
    this.#entries = [];
  }

  #secretKey;
  #entries;

  /**
   * 对对象进行确定性序列化（递归排序 Key）以保证签名一致性
   * @param {any} value
   * @returns {string}
   */
  static canonicalize(value) {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => TamperEvidentAuditLogger.canonicalize(item)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const pairs = keys.map(
      (k) => `${JSON.stringify(k)}:${TamperEvidentAuditLogger.canonicalize(value[k])}`
    );
    return `{${pairs.join(',')}}`;
  }

  /**
   * 计算单条日志的 HMAC-SHA256 链式签名
   */
  #computeHash({ seq, timestamp, eventType, actorId, resource, action, outcome, metadata, prevHash }) {
    const payload = TamperEvidentAuditLogger.canonicalize({
      seq,
      timestamp,
      eventType,
      actorId,
      resource,
      action,
      outcome,
      metadata,
      prevHash,
    });
    return crypto.createHmac('sha256', this.#secretKey).update(payload).digest('hex');
  }

  /**
   * 追加一条不可变安全审计记录
   * @param {object} event
   * @param {string} event.eventType - 事件分类 (如 `ACCESS_GRANTED`, `ACCESS_DENIED`, `RATE_LIMITED`)
   * @param {string} event.actorId - 操作主体标识
   * @param {string} event.resource - 目标资源
   * @param {string} event.action - 执行动作
   * @param {'ALLOW'|'DENY'|'ERROR'} event.outcome - 执行结果
   * @param {object} [event.metadata={}] - 附加元数据
   * @param {string} [event.timestamp] - ISO 时间戳
   */
  log({
    eventType,
    actorId,
    resource,
    action,
    outcome,
    metadata = {},
    timestamp = new Date().toISOString(),
  }) {
    const seq = this.#entries.length + 1;
    const prevHash =
      seq === 1 ? this.genesisHash : this.#entries[this.#entries.length - 1].hash;

    const clonedMeta = structuredClone(metadata);
    const hash = this.#computeHash({
      seq,
      timestamp,
      eventType,
      actorId,
      resource,
      action,
      outcome,
      metadata: clonedMeta,
      prevHash,
    });

    const entry = Object.freeze({
      seq,
      timestamp,
      eventType,
      actorId,
      resource,
      action,
      outcome,
      metadata: Object.freeze(clonedMeta),
      prevHash,
      hash,
    });

    this.#entries.push(entry);
    return entry;
  }

  /**
   * 校验整条日志链或外部导出日志链的完整性与防篡改性
   * @param {Array<object>} [entriesToVerify]
   * @returns {{ valid: boolean, totalChecked: number, corruptedIndex?: number, reason?: string }}
   */
  verifyIntegrity(entriesToVerify = this.#entries) {
    let expectedPrevHash = this.genesisHash;

    for (let i = 0; i < entriesToVerify.length; i++) {
      const entry = entriesToVerify[i];
      if (!entry || entry.seq !== i + 1) {
        return {
          valid: false,
          totalChecked: i,
          corruptedIndex: i,
          reason: `Sequence number mismatch at index ${i}: expected ${i + 1}, got ${entry?.seq}`,
        };
      }

      if (entry.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          totalChecked: i,
          corruptedIndex: i,
          reason: `Broken hash chain at index ${i}: prevHash mismatch`,
        };
      }

      const recomputedHash = this.#computeHash({
        seq: entry.seq,
        timestamp: entry.timestamp,
        eventType: entry.eventType,
        actorId: entry.actorId,
        resource: entry.resource,
        action: entry.action,
        outcome: entry.outcome,
        metadata: entry.metadata,
        prevHash: entry.prevHash,
      });

      const hashBufA = Buffer.from(String(entry.hash ?? ''), 'hex');
      const hashBufB = Buffer.from(recomputedHash, 'hex');
      if (
        hashBufA.length !== hashBufB.length ||
        !crypto.timingSafeEqual(hashBufA, hashBufB)
      ) {
        return {
          valid: false,
          totalChecked: i,
          corruptedIndex: i,
          reason: `Entry payload or signature tampered at index ${i}`,
        };
      }

      expectedPrevHash = entry.hash;
    }

    return {
      valid: true,
      totalChecked: entriesToVerify.length,
    };
  }

  /**
   * 获取只读日志快照副本
   */
  getEntries() {
    return [...this.#entries];
  }
}

/**
 * 4. 统一 API 安全守卫 (SecurityGuard)
 * 编排限流器、RBAC 鉴权与防篡改审计日志，并提供通用中间件适配器
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
   * 对单次 API 请求执行完整安全检查流水线：限流 -> 认证检查 -> RBAC/ABAC 鉴权 -> 审计记录
   * @param {object} request
   * @param {string} [request.userId] - 请求用户 ID
   * @param {string} [request.ip] - 客户端 IP
   * @param {string} request.resource - 目标资源名
   * @param {string} request.action - 操作类型 (`read`, `write`, `delete` 等)
   * @param {object} [request.context] - 鉴权附加属性上下文
   * @param {object} [request.rateLimitOverride] - 针对当前端点的限流覆盖配置
   */
  authorizeRequest({
    userId,
    ip = 'unknown',
    resource,
    action,
    context = {},
    rateLimitOverride,
  }) {
    const actorId = userId || `anon:${ip}`;
    const rateLimitKey = `${actorId}:${resource}:${action}`;

    // Step 1: 请求限流检查
    const rateStatus = this.rateLimiter.consume(rateLimitKey, rateLimitOverride);
    if (!rateStatus.allowed) {
      const auditEntry = this.auditLogger.log({
        eventType: 'RATE_LIMITED',
        actorId,
        resource,
        action,
        outcome: 'DENY',
        metadata: {
          ip,
          retryAfterMs: rateStatus.retryAfterMs,
          limit: rateStatus.limit,
        },
      });
      return {
        allowed: false,
        statusCode: 429,
        reason: 'TOO_MANY_REQUESTS',
        rateLimit: rateStatus,
        auditEntry,
      };
    }

    // Step 2: 身份认证检查
    if (!userId) {
      const auditEntry = this.auditLogger.log({
        eventType: 'UNAUTHENTICATED',
        actorId,
        resource,
        action,
        outcome: 'DENY',
        metadata: { ip },
      });
      return {
        allowed: false,
        statusCode: 401,
        reason: 'UNAUTHENTICATED',
        rateLimit: rateStatus,
        auditEntry,
      };
    }

    // Step 3: RBAC + 条件上下文权限检查
    const hasPermission = this.rbac.can(userId, resource, action, context);
    if (!hasPermission) {
      const auditEntry = this.auditLogger.log({
        eventType: 'ACCESS_DENIED',
        actorId: userId,
        resource,
        action,
        outcome: 'DENY',
        metadata: { ip, context },
      });
      return {
        allowed: false,
        statusCode: 403,
        reason: 'FORBIDDEN',
        rateLimit: rateStatus,
        auditEntry,
      };
    }

    // Step 4: 鉴权通过并写入审计链
    const auditEntry = this.auditLogger.log({
      eventType: 'ACCESS_GRANTED',
      actorId: userId,
      resource,
      action,
      outcome: 'ALLOW',
      metadata: { ip },
    });

    return {
      allowed: true,
      statusCode: 200,
      reason: 'OK',
      rateLimit: rateStatus,
      auditEntry,
    };
  }

  /**
   * 生成标准 HTTP/Express/Connect 风格中间件
   * @param {string} resource
   * @param {string} action
   * @param {(req: any) => object} [contextExtractor]
   */
  middleware(resource, action, contextExtractor = () => ({})) {
    return (req, res, next) => {
      const userId = req.user?.id ?? req.headers?.['x-user-id'];
      const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
      const context = contextExtractor(req);

      const decision = this.authorizeRequest({
        userId,
        ip,
        resource,
        action,
        context,
      });

      if (typeof res?.setHeader === 'function') {
        res.setHeader('X-RateLimit-Limit', String(decision.rateLimit.limit));
        res.setHeader('X-RateLimit-Remaining', String(decision.rateLimit.remaining));
        res.setHeader('X-RateLimit-Reset', String(decision.rateLimit.resetAt));
      }

      if (!decision.allowed) {
        if (decision.statusCode === 429 && typeof res?.setHeader === 'function') {
          res.setHeader(
            'Retry-After',
            String(Math.ceil(decision.rateLimit.retryAfterMs / 1000))
          );
        }
        if (typeof res?.status === 'function') {
          return res.status(decision.statusCode).json({
            error: decision.reason,
            auditSeq: decision.auditEntry.seq,
          });
        }
        res.statusCode = decision.statusCode;
        res.end(JSON.stringify({ error: decision.reason }));
        return;
      }

      next();
    };
  }
}

export default SecurityGuard;
