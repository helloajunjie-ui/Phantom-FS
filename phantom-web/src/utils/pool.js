'use strict';

/**
 * Phantom-FS / V12 并发控制池
 * ==============================
 * 自建上传/下载控制池，保护浏览器网络栈
 * 单点失败自动触发重试/熔断机制，保住主循环
 * 
 * @module pool
 */

/**
 * 并发控制池
 * 
 * @class ConcurrencyPool
 * 
 * @example
 * const pool = new ConcurrencyPool(5);
 * for (let i = 0; i < 100; i++) {
 *     pool.add(() => fetch(`/api/item/${i}`));
 * }
 * await pool.waitAll();
 */
class ConcurrencyPool {
    /**
     * @param {number} [maxConcurrency=5] - 最大并发数
     * @param {number} [maxRetries=3] - 单任务最大重试次数
     */
    constructor(maxConcurrency = 5, maxRetries = 3) {
        /** @private */
        this._maxConcurrency = maxConcurrency;
        /** @private */
        this._maxRetries = maxRetries;
        /** @private @type {Set<Promise>} */
        this._pool = new Set();
        /** @private @type {Array<Function>} */
        this._queue = [];
        /** @private @type {Array<Error>} */
        this._errors = [];
        /** @private */
        this._completed = 0;
        /** @private */
        this._total = 0;
    }

    /**
     * 添加任务到并发池
     * 
     * @param {Function|Promise} task - 返回 Promise 的函数或 Promise 本身
     * @returns {Promise} 任务 Promise
     */
    async add(task) {
        this._total++;

        // 如果池子满了，等待最早完成的任务
        if (this._pool.size >= this._maxConcurrency) {
            await Promise.race(this._pool);
        }

        const promise = this._executeWithRetry(task);
        this._pool.add(promise);
        
        promise
            .then(() => {
                this._completed++;
            })
            .catch(() => {
                this._completed++;
            })
            .finally(() => {
                this._pool.delete(promise);
            });

        return promise;
    }

    /**
     * 带重试的任务执行
     * 
     * @private
     * @param {Function|Promise} task - 任务
     * @returns {Promise} 执行结果
     */
    async _executeWithRetry(task) {
        // maxRetries = 总尝试次数（初始执行 + 重试）
        // 例如 maxRetries=3 → 执行1次 + 重试2次
        for (let attempt = 0; attempt < this._maxRetries; attempt++) {
            try {
                const result = typeof task === 'function' ? await task() : await task;
                return result;
            } catch (error) {
                if (attempt === this._maxRetries - 1) {
                    // 所有尝试均失败，记录错误但不抛出
                    // 静默熔断：不因单个分片失败而崩溃主循环
                    this._errors.push(error);
                    console.warn(
                        `[Phantom-FS] 任务失败（已尝试 ${this._maxRetries} 次）:`,
                        error.message
                    );
                    return null;
                }
                // 指数退避：1s, 2s, 4s
                await this._delay(1000 * Math.pow(2, attempt));
            }
        }
    }

    /**
     * 等待所有任务完成
     * 
     * @returns {Promise<Error[]>} 所有失败的错误列表
     */
    async waitAll() {
        await Promise.all([...this._pool]);
        return this._errors;
    }

    /**
     * 获取当前进度
     * 
     * @returns {{ completed: number, total: number, errors: number }}
     */
    getProgress() {
        return {
            completed: this._completed,
            total: this._total,
            errors: this._errors.length
        };
    }

    /**
     * 获取失败错误列表
     * 
     * @returns {Error[]}
     */
    getErrors() {
        return [...this._errors];
    }

    /**
     * 是否有失败任务
     * 
     * @returns {boolean}
     */
    hasErrors() {
        return this._errors.length > 0;
    }

    /**
     * 延迟工具
     * @private
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export { ConcurrencyPool };
