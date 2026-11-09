import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const TaskStatus = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  RETRYING: 'retrying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export class TimeoutError extends Error {
  constructor(message = 'Task timed out', timeoutMs) {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
    this.timeoutMs = timeoutMs;
  }
}

export class DurableTaskQueue extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.concurrency=4] 最大并发数
   * @param {number} [options.maxRetries=3] 最大重试次数
   * @param {number} [options.baseDelayMs=500] 指数退避初始延迟(ms)
   * @param {number} [options.maxDelayMs=30000] 指数退避最大延迟(ms)
   * @param {number} [options.backoffFactor=2] 指数退避倍率
   * @param {number} [options.jitter=0.1] 随机抖动比例 (0 ~ 1)
   * @param {number} [options.timeoutMs=10000] 单任务默认超时时间(ms)，0 表示不限时
   * @param {string|null} [options.stateFile=null] 断点续传本地文件路径
   * @param {boolean} [options.autoStart=true] 入队后是否自动开始调度
   * @param {Record<string, Function>} [options.handlers={}] 任务处理器映射表 (type -> async (payload, context) => result)
   */
  constructor(options = {}) {
    super();
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? 500);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 30_000);
    this.backoffFactor = Math.max(1, options.backoffFactor ?? 2);
    this.jitter = Math.min(1, Math.max(0, options.jitter ?? 0.1));
    this.timeoutMs = Math.max(0, options.timeoutMs ?? 10_000);
    this.stateFile = options.stateFile ?? null;
    this.autoStart = options.autoStart ?? true;

    /** @type {Map<string, Function>} */
    this.handlers = new Map(Object.entries(options.handlers ?? {}));

    /** @type {Map<string, object>} */
    this.tasks = new Map();

    /** @type {Map<string, { fn?: Function, resolve: Function, reject: Function, abortController?: AbortController, retryTimer?: NodeJS.Timeout }>} */
    this._runtime = new Map();

    this.runningCount = 0;
    this.paused = !this.autoStart;
    this._saveChain = Promise.resolve();
    this._idleResolvers = [];
  }

  /**
   * 注册可持久化的具名任务处理器（用于断点续传后恢复执行）
   * @param {string} type
   * @param {(payload: any, ctx: { id: string, attempt: number, signal: AbortSignal, checkpoint: (progress: any) => Promise<void>, progress: any }) => Promise<any>} handler
   */
  registerHandler(type, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for "${type}" must be a function`);
    }
    this.handlers.set(type, handler);
    return this;
  }

  /**
   * 从本地状态文件恢复队列（将未完成的 running/retrying/pending 任务重置为可调度状态）
   * @returns {Promise<number>} 恢复的待处理任务数量
   */
  async restore() {
    if (!this.stateFile) return 0;

    let raw;
    try {
      raw = await readFile(this.stateFile, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return 0;
      throw err;
    }

    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    let restoredPending = 0;

    for (const item of items) {
      if (!item || !item.id) continue;
      const task = { ...item };

      if (
        task.status === TaskStatus.RUNNING ||
        task.status === TaskStatus.RETRYING ||
        task.status === TaskStatus.PENDING
      ) {
        task.status = TaskStatus.PENDING;
        task.nextRunAt = null;
        restoredPending++;
      }

      this.tasks.set(task.id, task);
      if (!this._runtime.has(task.id)) {
        this._AttachDeferred(task.id);
      }
    }

    await this._persist();
    this.emit('restored', { total: this.tasks.size, pending: restoredPending });

    if (!this.paused && restoredPending > 0) {
      this._schedule();
    }

    return restoredPending;
  }

  /**
   * 添加任务到队列
   * 支持两种调用方式:
   * 1. enqueue(fn, options) - 直接传入异步函数 `(ctx) => Promise<any>`
   * 2. enqueue({ id, type, payload, fn, ...options }) - 传入可序列化任务配置
   *
   * @param {Function|object} taskOrFn
   * @param {object} [opts]
   * @returns {{ id: string, promise: Promise<any>, cancel: () => Promise<boolean> }}
   */
  enqueue(taskOrFn, opts = {}) {
    const config =
      typeof taskOrFn === 'function'
        ? { ...opts, fn: taskOrFn }
        : { ...taskOrFn };

    const id = config.id ?? randomUUID();

    // 若已存在已完成任务（断点续传场景），直接复用结果
    const existing = this.tasks.get(id);
    if (existing && existing.status === TaskStatus.COMPLETED) {
      return {
        id,
        promise: Promise.resolve(existing.result),
        cancel: async () => false,
      };
    }

    const type = config.type ?? existing?.type ?? 'default';
    const fn = config.fn;

    if (!fn && !this.handlers.has(type)) {
      throw new Error(
        `Task "${id}" requires either a task function or a registered handler for type "${type}"`
      );
    }

    const now = Date.now();
    const task = {
      id,
      type,
      payload: config.payload !== undefined ? config.payload : (existing?.payload ?? null),
      progress: existing?.progress ?? null,
      status: TaskStatus.PENDING,
      attempt: existing?.status === TaskStatus.PENDING ? (existing.attempt ?? 0) : 0,
      maxRetries: config.maxRetries ?? existing?.maxRetries ?? this.maxRetries,
      timeoutMs: config.timeoutMs ?? existing?.timeoutMs ?? this.timeoutMs,
      baseDelayMs: config.baseDelayMs ?? existing?.baseDelayMs ?? this.baseDelayMs,
      maxDelayMs: config.maxDelayMs ?? existing?.maxDelayMs ?? this.maxDelayMs,
      backoffFactor: config.backoffFactor ?? existing?.backoffFactor ?? this.backoffFactor,
      priority: config.priority ?? existing?.priority ?? 0,
      result: undefined,
      error: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nextRunAt: null,
    };

    this.tasks.set(id, task);
    const runtime = this._AttachDeferred(id, fn);

    this._persist().catch((err) => this.emit('error', err));
    this.emit('enqueued', { ...task });

    if (!this.paused) {
      this._schedule();
    }

    return {
      id,
      promise: runtime.promise,
      cancel: () => this.cancel(id),
    };
  }

  /**
   * 取消指定任务（若正在运行则触发 AbortSignal 中断）
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (
      task.status === TaskStatus.COMPLETED ||
      task.status === TaskStatus.FAILED ||
      task.status === TaskStatus.CANCELLED
    ) {
      return false;
    }

    const runtime = this._runtime.get(id);
    if (runtime?.retryTimer) {
      clearTimeout(runtime.retryTimer);
      runtime.retryTimer = undefined;
    }

    task.status = TaskStatus.CANCELLED;
    task.updatedAt = Date.now();
    task.error = { name: 'AbortError', message: 'Task cancelled' };

    if (runtime?.abortController) {
      runtime.abortController.abort(new Error('Task cancelled'));
    }

    await this._persist();
    const cancelErr = new Error(`Task "${id}" was cancelled`);
    cancelErr.name = 'AbortError';
    runtime?.reject(cancelErr);

    this.emit('cancelled', { ...task });
    this._checkIdle();
    this._schedule();
    return true;
  }

  /**
   * 启动/恢复队列调度
   */
  start() {
    this.paused = false;
    this._schedule();
    return this;
  }

  /**
   * 暂停队列调度（进行中的任务会继续完成或等待，不再启动新任务）
   */
  pause() {
    this.paused = true;
    return this;
  }

  /**
   * 等待队列中所有 pending / running / retrying 任务执行完毕
   * @returns {Promise<void>}
   */
  onIdle() {
    if (this._isIdle()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._idleResolvers.push(resolve);
    });
  }

  /**
   * 获取队列统计快照
   */
  getStats() {
    const stats = {
      total: this.tasks.size,
      pending: 0,
      running: 0,
      retrying: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of this.tasks.values()) {
      if (stats[task.status] !== undefined) {
        stats[task.status]++;
      }
    }
    return stats;
  }

  /**
   * 获取单个任务状态快照
   * @param {string} id
   */
  getTask(id) {
    const t = this.tasks.get(id);
    return t ? { ...t } : undefined;
  }

  _AttachDeferred(id, fn) {
    let existing = this._runtime.get(id);
    if (existing) {
      if (fn) existing.fn = fn;
      return existing;
    }

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // 防止无人 await 时触发 UnhandledPromiseRejection
    promise.catch(() => {});

    const entry = { fn, resolve, reject, promise };
    this._runtime.set(id, entry);
    return entry;
  }

  _isIdle() {
    if (this.runningCount > 0) return false;
    for (const task of this.tasks.values()) {
      if (
        task.status === TaskStatus.PENDING ||
        task.status === TaskStatus.RUNNING ||
        task.status === TaskStatus.RETRYING
      ) {
        return false;
      }
    }
    return true;
  }

  _checkIdle() {
    if (this._isIdle()) {
      const resolvers = this._idleResolvers.splice(0);
      this._persist()
        .catch(() => {})
        .finally(() => {
          for (const resolve of resolvers) resolve();
          this.emit('idle', this.getStats());
        });
    }
  }

  _pickNextTask() {
    let selected = null;
    for (const task of this.tasks.values()) {
      if (task.status !== TaskStatus.PENDING) continue;
      if (!selected) {
        selected = task;
        continue;
      }
      if (task.priority > selected.priority) {
        selected = task;
      } else if (
        task.priority === selected.priority &&
        task.createdAt < selected.createdAt
      ) {
        selected = task;
      }
    }
    return selected;
  }

  _schedule() {
    if (this.paused) return;

    while (this.runningCount < this.concurrency) {
      const nextTask = this._pickNextTask();
      if (!nextTask) break;
      this._executeTask(nextTask);
    }

    this._checkIdle();
  }

  async _executeTask(task) {
    const runtime = this._AttachDeferred(task.id);
    const fn = runtime.fn ?? this.handlers.get(task.type);

    if (!fn) {
      task.status = TaskStatus.FAILED;
      task.updatedAt = Date.now();
      task.error = {
        name: 'MissingHandlerError',
        message: `No handler registered for task type "${task.type}"`,
      };
      await this._persist();
      const err = new Error(task.error.message);
      runtime.reject(err);
      this.emit('failed', { ...task }, err);
      this._checkIdle();
      return;
    }

    this.runningCount++;
    task.status = TaskStatus.RUNNING;
    task.attempt += 1;
    task.updatedAt = Date.now();
    task.nextRunAt = null;

    const abortController = new AbortController();
    runtime.abortController = abortController;

    await this._persist();
    this.emit('active', { ...task });

    const checkpoint = async (progress) => {
      task.progress = progress;
      task.updatedAt = Date.now();
      await this._persist();
      this.emit('checkpoint', { id: task.id, progress });
    };

    const context = {
      id: task.id,
      type: task.type,
      payload: task.payload,
      attempt: task.attempt,
      progress: task.progress,
      signal: abortController.signal,
      checkpoint,
    };

    try {
      const result = await this._runWithTimeout(
        () => (runtime.fn ? fn(context) : fn(task.payload, context)),
        task.timeoutMs,
        abortController
      );

      if (task.status === TaskStatus.CANCELLED) {
        return;
      }

      task.status = TaskStatus.COMPLETED;
      task.result = result;
      task.error = null;
      task.updatedAt = Date.now();

      await this._persist();
      runtime.resolve(result);
      this.emit('completed', { ...task }, result);
    } catch (err) {
      if (task.status === TaskStatus.CANCELLED) {
        return;
      }

      const maxAttempts = 1 + task.maxRetries;
      if (task.attempt < maxAttempts) {
        const delayMs = this._computeBackoffDelay(task);
        task.status = TaskStatus.RETRYING;
        task.updatedAt = Date.now();
        task.nextRunAt = Date.now() + delayMs;
        task.error = this._serializeError(err);

        await this._persist();
        this.emit('retry', { ...task, delayMs }, err);

        runtime.retryTimer = setTimeout(async () => {
          runtime.retryTimer = undefined;
          if (task.status !== TaskStatus.RETRYING) return;
          task.status = TaskStatus.PENDING;
          task.nextRunAt = null;
          task.updatedAt = Date.now();
          await this._persist();
          this._schedule();
        }, delayMs);
      } else {
        task.status = TaskStatus.FAILED;
        task.updatedAt = Date.now();
        task.error = this._serializeError(err);

        await this._persist();
        runtime.reject(err);
        this.emit('failed', { ...task }, err);
      }
    } finally {
      runtime.abortController = undefined;
      this.runningCount--;
      this._schedule();
    }
  }

  _runWithTimeout(work, timeoutMs, abortController) {
    if (!timeoutMs || timeoutMs <= 0) {
      return Promise.resolve().then(work);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeoutErr = new TimeoutError(
          `Task timed out after ${timeoutMs}ms`,
          timeoutMs
        );
        abortController.abort(timeoutErr);
        reject(timeoutErr);
      }, timeoutMs);

      Promise.resolve()
        .then(work)
        .then(
          (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          }
        );
    });
  }

  _computeBackoffDelay(task) {
    const retryIndex = Math.max(0, task.attempt - 1);
    const expDelay = Math.min(
      task.maxDelayMs,
      task.baseDelayMs * Math.pow(task.backoffFactor, retryIndex)
    );
    if (this.jitter <= 0) {
      return Math.round(expDelay);
    }
    const delta = expDelay * this.jitter;
    const jittered = expDelay - delta + Math.random() * (2 * delta);
    return Math.max(0, Math.round(jittered));
  }

  _serializeError(err) {
    if (!err || typeof err !== 'object') {
      return { name: 'Error', message: String(err) };
    }
    return {
      name: err.name || 'Error',
      message: err.message || String(err),
      code: err.code,
    };
  }

  /**
   * 原子化写入本地状态文件（通过临时文件 + rename 避免崩溃损坏）
   */
  _persist() {
    if (!this.stateFile) return Promise.resolve();

    const snapshot = {
      version: 1,
      updatedAt: Date.now(),
      tasks: Array.from(this.tasks.values()),
    };

    this._saveChain = this._saveChain
      .catch(() => {})
      .then(async () => {
        const dir = dirname(this.stateFile);
        await mkdir(dir, { recursive: true });
        const tmpFile = `${this.stateFile}.${process.pid}.tmp`;
        await writeFile(tmpFile, JSON.stringify(snapshot, null, 2), 'utf8');
        await rename(tmpFile, this.stateFile);
      });

    return this._saveChain;
  }
}

export { DurableTaskQueue as TaskQueue };
export default DurableTaskQueue;
