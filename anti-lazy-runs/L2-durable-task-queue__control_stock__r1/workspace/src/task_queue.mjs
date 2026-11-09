import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 任务状态枚举
 */
export const TaskStatus = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  RETRYING: 'retrying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/**
 * 支持并发限流、指数退避重试、单任务超时中断（AbortSignal）及本地文件断点续传的异步任务队列引擎
 */
export class DurableTaskQueue extends EventEmitter {
  /**
   * @param {Object} options
   * @param {number} [options.concurrency=3] 最大并发执行数
   * @param {number} [options.maxRetries=3] 默认最大重试次数
   * @param {number} [options.baseDelayMs=500] 指数退避基础延迟（毫秒）
   * @param {number} [options.maxDelayMs=30000] 指数退避最大延迟（毫秒）
   * @param {boolean} [options.jitter=true] 是否开启退避随机抖动
   * @param {number} [options.timeoutMs=10000] 默认单任务超时时间（毫秒，0 表示不限时）
   * @param {string|null} [options.stateFilePath='./.task_queue_state.json'] 状态持久化文件路径（传 null 禁用文件持久化）
   * @param {boolean} [options.autoStart=true] 入队后是否自动开始调度
   */
  constructor(options = {}) {
    super();
    this.concurrency = Math.max(1, options.concurrency ?? 3);
    this.defaultMaxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.jitter = options.jitter ?? true;
    this.defaultTimeoutMs = options.timeoutMs ?? 10_000;
    this.stateFilePath =
      options.stateFilePath === undefined ? './.task_queue_state.json' : options.stateFilePath;
    this.autoStart = options.autoStart ?? true;

    /** @type {Map<string, Function>} 任务处理器注册表 (type -> handler(payload, context)) */
    this.handlers = new Map();

    /** @type {Map<string, Object>} 任务记录表 (id -> TaskRecord) */
    this.tasks = new Map();

    /** @type {Map<string, AbortController>} 正在运行任务的控制器 */
    this.runningControllers = new Map();

    /** @type {Map<string, NodeJS.Timeout>} 等待重试的定时器 */
    this.retryTimers = new Map();

    /** @type {Map<string, { resolve: Function, reject: Function, promise: Promise }>} */
    this.waiters = new Map();

    this.activeCount = 0;
    this.paused = !this.autoStart;
    this._saveChain = Promise.resolve();
    this._initialized = false;
  }

  /**
   * 注册任务类型处理器（用于支持可序列化断点续传）
   * @param {string} type 任务类型标识
   * @param {(payload: any, context: { id: string, signal: AbortSignal, attempts: number, updateProgress: (progress: any) => Promise<void> }) => Promise<any>} handler
   */
  registerHandler(type, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for "${type}" must be a function`);
    }
    this.handlers.set(type, handler);
    return this;
  }

  /**
   * 初始化队列并从本地状态文件恢复未完成的任务（断点续传）
   */
  async init() {
    if (this._initialized) return this;
    await this._loadState();
    this._initialized = true;
    if (this.autoStart && !this.paused) {
      this._schedule();
    }
    return this;
  }

  /**
   * 添加任务到队列
   * 支持两种调用方式：
   * 1. 可持久化任务：`enqueue({ type: 'download', payload: {...}, ...options })`
   * 2. 内存闭包任务：`enqueue(async ({ signal }) => {...}, options)`
   *
   * @param {Object|Function} taskOrFn
   * @param {Object} [options]
   * @returns {Promise<{ id: string, completion: Promise<any> }>}
   */
  async enqueue(taskOrFn, options = {}) {
    if (!this._initialized && this.stateFilePath) {
      await this.init();
    }

    const isFn = typeof taskOrFn === 'function';
    const config = isFn ? options : { ...taskOrFn, ...options };

    const id = config.id ?? randomUUID();
    const existing = this.tasks.get(id);

    // 如果任务在断点恢复中已完成，直接复用结果
    if (existing && existing.status === TaskStatus.COMPLETED) {
      return {
        id,
        completion: Promise.resolve(existing.result),
      };
    }

    const task = {
      id,
      type: isFn ? '__inline__' : config.type ?? 'default',
      payload: isFn ? null : config.payload ?? null,
      fn: isFn ? taskOrFn : config.fn ?? null,
      priority: config.priority ?? 0,
      maxRetries: config.maxRetries ?? this.defaultMaxRetries,
      timeoutMs: config.timeoutMs ?? this.defaultTimeoutMs,
      attempts: existing ? existing.attempts : 0,
      status: TaskStatus.PENDING,
      progress: existing?.progress ?? null,
      result: null,
      error: null,
      nextRunAt: Date.now(),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };

    if (!task.fn && !this.handlers.has(task.type)) {
      throw new Error(
        `Task "${id}" requires either an inline function or a registered handler for type "${task.type}"`
      );
    }

    this.tasks.set(id, task);
    const waiter = this._getOrCreateWaiter(id);

    await this._persistState();
    this.emit('enqueued', this._cloneTaskMeta(task));

    if (!this.paused) {
      this._schedule();
    }

    return {
      id,
      completion: waiter.promise,
    };
  }

  /**
   * 添加任务并直接等待该任务执行完成返回结果
   */
  async add(taskOrFn, options = {}) {
    const { completion } = await this.enqueue(taskOrFn, options);
    return completion;
  }

  /**
   * 取消指定任务（若正在执行则触发 AbortSignal 中断）
   * @param {string} id
   * @param {string} [reason='Task cancelled by user']
   */
  async cancel(id, reason = 'Task cancelled by user') {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (
      task.status === TaskStatus.COMPLETED ||
      task.status === TaskStatus.FAILED ||
      task.status === TaskStatus.CANCELLED
    ) {
      return false;
    }

    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }

    const controller = this.runningControllers.get(id);
    if (controller) {
      controller.abort(new Error(reason));
    }

    task.status = TaskStatus.CANCELLED;
    task.error = reason;
    task.updatedAt = Date.now();

    await this._persistState();
    this._rejectWaiter(id, new Error(reason));
    this.emit('cancelled', this._cloneTaskMeta(task));
    this._schedule();
    return true;
  }

  /**
   * 暂停队列调度（当前正在执行的任务会继续跑完，不启动新任务）
   */
  pause() {
    this.paused = true;
    this.emit('paused');
  }

  /**
   * 恢复队列调度
   */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.emit('resumed');
    this._schedule();
  }

  /**
   * 等待队列中所有任务执行完毕（处于空闲状态）
   */
  async onIdle() {
    if (this._isIdle()) return;
    return new Promise((resolve) => {
      const check = () => {
        if (this._isIdle()) {
          this.off('idle', check);
          resolve();
        }
      };
      this.on('idle', check);
    });
  }

  /**
   * 获取队列当前统计快照
   */
  getStats() {
    const counts = {
      pending: 0,
      running: 0,
      retrying: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: this.tasks.size,
    };
    for (const task of this.tasks.values()) {
      counts[task.status] = (counts[task.status] || 0) + 1;
    }
    return counts;
  }

  /**
   * 获取单个任务状态副本
   * @param {string} id
   */
  getTask(id) {
    const task = this.tasks.get(id);
    return task ? this._cloneTaskMeta(task) : null;
  }

  /**
   * 内部核心调度循环
   */
  _schedule() {
    if (this.paused) return;

    while (this.activeCount < this.concurrency) {
      const nextTask = this._pickNextTask();
      if (!nextTask) break;
      this._executeTask(nextTask);
    }

    if (this._isIdle()) {
      this.emit('idle', this.getStats());
    }
  }

  /**
   * 选取下一个可执行任务（按优先级降序，创建时间升序）
   */
  _pickNextTask() {
    const now = Date.now();
    let selected = null;

    for (const task of this.tasks.values()) {
      if (task.status !== TaskStatus.PENDING) continue;
      if (task.nextRunAt > now) continue;

      if (!selected) {
        selected = task;
        continue;
      }
      if (task.priority > selected.priority) {
        selected = task;
      } else if (task.priority === selected.priority && task.createdAt < selected.createdAt) {
        selected = task;
      }
    }

    return selected;
  }

  /**
   * 执行单个任务（包含超时控制、重试退避与持久化）
   */
  async _executeTask(task) {
    this.activeCount++;
    task.status = TaskStatus.RUNNING;
    task.attempts++;
    task.updatedAt = Date.now();

    const controller = new AbortController();
    this.runningControllers.set(task.id, controller);

    await this._persistState();
    this.emit('start', this._cloneTaskMeta(task));

    let timeoutId = null;
    const timeoutPromise =
      task.timeoutMs > 0
        ? new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              const timeoutErr = new Error(
                `Task "${task.id}" timed out after ${task.timeoutMs}ms`
              );
              timeoutErr.code = 'ETIMEDOUT';
              controller.abort(timeoutErr);
              reject(timeoutErr);
            }, task.timeoutMs);
          })
        : null;

    const updateProgress = async (progress) => {
      task.progress = progress;
      task.updatedAt = Date.now();
      await this._persistState();
      this.emit('progress', { id: task.id, progress });
    };

    try {
      const runner = task.fn ?? this.handlers.get(task.type);
      if (!runner) {
        throw new Error(`No handler registered for task type "${task.type}"`);
      }

      const context = {
        id: task.id,
        signal: controller.signal,
        attempts: task.attempts,
        progress: task.progress,
        updateProgress,
      };

      const execPromise = Promise.resolve(
        task.fn ? runner(context) : runner(task.payload, context)
      );

      const result = timeoutPromise
        ? await Promise.race([execPromise, timeoutPromise])
        : await execPromise;

      if (task.status === TaskStatus.CANCELLED) {
        return;
      }

      task.status = TaskStatus.COMPLETED;
      task.result = result;
      task.error = null;
      task.updatedAt = Date.now();

      await this._persistState();
      this._resolveWaiter(task.id, result);
      this.emit('completed', this._cloneTaskMeta(task));
    } catch (err) {
      if (task.status === TaskStatus.CANCELLED) {
        return;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      const canRetry = task.attempts <= task.maxRetries && !err?.noRetry;

      if (canRetry) {
        const delayMs = this._computeBackoff(task.attempts);
        task.status = TaskStatus.RETRYING;
        task.error = errorMsg;
        task.nextRunAt = Date.now() + delayMs;
        task.updatedAt = Date.now();

        await this._persistState();
        this.emit('retry', {
          ...this._cloneTaskMeta(task),
          delayMs,
        });

        const timer = setTimeout(async () => {
          this.retryTimers.delete(task.id);
          if (task.status === TaskStatus.RETRYING) {
            task.status = TaskStatus.PENDING;
            task.updatedAt = Date.now();
            await this._persistState();
            this._schedule();
          }
        }, delayMs);

        this.retryTimers.set(task.id, timer);
      } else {
        task.status = TaskStatus.FAILED;
        task.error = errorMsg;
        task.updatedAt = Date.now();

        await this._persistState();
        this._rejectWaiter(
          task.id,
          err instanceof Error ? err : new Error(errorMsg)
        );
        this.emit('failed', this._cloneTaskMeta(task));
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.runningControllers.delete(task.id);
      this.activeCount--;
      this._schedule();
    }
  }

  /**
   * 计算指数退避延迟时间：min(maxDelay, baseDelay * 2^(attempt-1)) + 可选随机抖动
   */
  _computeBackoff(attempt) {
    const expDelay = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1))
    );
    if (!this.jitter) return expDelay;
    // Equal jitter: [0.5 * expDelay, 1.0 * expDelay]
    const half = expDelay / 2;
    return Math.floor(half + Math.random() * half);
  }

  /**
   * 判断队列是否完全空闲
   */
  _isIdle() {
    if (this.activeCount > 0 || this.retryTimers.size > 0) return false;
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

  /**
   * 原子化写入本地状态文件（通过临时文件 rename 防止写入中断损坏）
   */
  async _persistState() {
    if (!this.stateFilePath) return;

    const serializableTasks = [];
    for (const task of this.tasks.values()) {
      // 跳过纯内存闭包任务
      if (task.type === '__inline__') continue;
      serializableTasks.push(this._cloneTaskMeta(task));
    }

    const payload = JSON.stringify(
      {
        version: 1,
        updatedAt: Date.now(),
        tasks: serializableTasks,
      },
      null,
      2
    );

    this._saveChain = this._saveChain
      .then(async () => {
        const resolvedPath = path.resolve(this.stateFilePath);
        const dir = path.dirname(resolvedPath);
        await fs.mkdir(dir, { recursive: true });
        const tmpPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmpPath, payload, 'utf8');
        await fs.rename(tmpPath, resolvedPath);
      })
      .catch((err) => {
        this.emit('persistError', err);
      });

    return this._saveChain;
  }

  /**
   * 从本地状态文件加载并恢复未完成任务（将上次中断的 running/retrying 状态重置为 pending）
   */
  async _loadState() {
    if (!this.stateFilePath) return;

    const resolvedPath = path.resolve(this.stateFilePath);
    let raw;
    try {
      raw = await fs.readFile(resolvedPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Corrupted task queue state file at ${resolvedPath}: ${err.message}`);
    }

    if (!data || !Array.isArray(data.tasks)) return;

    let resumedCount = 0;
    for (const item of data.tasks) {
      const wasInterrupted =
        item.status === TaskStatus.RUNNING ||
        item.status === TaskStatus.RETRYING ||
        item.status === TaskStatus.PENDING;

      const restoredTask = {
        ...item,
        fn: null,
        status: wasInterrupted ? TaskStatus.PENDING : item.status,
        nextRunAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.tasks.set(restoredTask.id, restoredTask);
      if (wasInterrupted) {
        this._getOrCreateWaiter(restoredTask.id);
        resumedCount++;
      }
    }

    if (resumedCount > 0) {
      await this._persistState();
      this.emit('resumedFromDisk', { resumedCount, totalLoaded: data.tasks.length });
    }
  }

  _getOrCreateWaiter(id) {
    if (this.waiters.has(id)) {
      return this.waiters.get(id);
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // 防止无人 await completion 时触发 UnhandledPromiseRejection
    promise.catch(() => {});
    const waiter = { resolve, reject, promise };
    this.waiters.set(id, waiter);
    return waiter;
  }

  _resolveWaiter(id, value) {
    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter.resolve(value);
      this.waiters.delete(id);
    }
  }

  _rejectWaiter(id, err) {
    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter.reject(err);
      this.waiters.delete(id);
    }
  }

  _cloneTaskMeta(task) {
    const { fn, ...meta } = task;
    return structuredClone(meta);
  }
}

export { DurableTaskQueue as TaskQueue };
export default DurableTaskQueue;
