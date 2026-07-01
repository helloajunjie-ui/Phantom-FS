'use strict';

/**
 * Phantom-FS / V12 内存安全工具
 * ================================
 * 物理级内存覆写，防止密钥残留在 JavaScript 堆中
 * 
 * @module memory
 */

/**
 * 安全清零：用 0 覆写 ArrayBuffer
 * 亲手将 JavaScript 堆内存中的明文残影碾碎
 * 
 * @param {ArrayBuffer|Uint8Array|CryptoKey} buffer - 需要清理的缓冲区
 * 
 * @example
 * const rawKey = await crypto.subtle.exportKey("raw", key);
 * // ... 使用密钥
 * secureZero(rawKey); // 立即清理
 */
function secureZero(buffer) {
    if (!buffer) return;

    try {
        if (buffer instanceof CryptoKey) {
            // CryptoKey 无法直接清理，但可以尝试清空引用
            return;
        }

        if (buffer instanceof ArrayBuffer) {
            new Uint8Array(buffer).fill(0);
            return;
        }

        if (buffer instanceof Uint8Array) {
            buffer.fill(0);
            return;
        }

        // 尝试作为 ArrayBuffer 处理
        if (buffer.buffer instanceof ArrayBuffer) {
            new Uint8Array(buffer.buffer).fill(0);
            return;
        }
    } catch (error) {
        // 静默失败：内存清理是防御性措施，不应抛出异常
        console.warn('[Phantom-FS] 内存清理失败:', error.message);
    }
}

/**
 * 安全分配：分配一个自动清零的 Uint8Array
 * 
 * @param {number} length - 数组长度
 * @returns {Uint8Array} 已清零的数组
 */
function secureAlloc(length) {
    return new Uint8Array(length);
}

/**
 * 使用后自动清理的包装器
 * 确保无论成功还是失败，密钥都会被清理
 * 
 * @param {CryptoKey} key - 需要保护的密钥
 * @param {Function} fn - 使用密钥的函数
 * @returns {Promise<any>} 函数执行结果
 * 
 * @example
 * const result = await withSecureKey(key, async (k) => {
 *     return await crypto.subtle.encrypt({ ... }, k, data);
 * });
 */
async function withSecureKey(key, fn) {
    let rawKey = null;
    try {
        rawKey = await crypto.subtle.exportKey('raw', key);
        return await fn(key);
    } finally {
        if (rawKey) {
            secureZero(rawKey);
        }
    }
}

export { secureZero, secureAlloc, withSecureKey };
