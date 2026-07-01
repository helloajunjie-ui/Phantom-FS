'use strict';

/**
 * Phantom-FS / V12 密钥派生模块
 * ================================
 * PBKDF2 + SHA-256 密钥派生 + 指纹提取
 * 
 * @module key-derivation
 */

/**
 * PBKDF2 迭代次数
 * OWASP 2023 推荐值: 600,000 次
 * @constant {number}
 */
const PBKDF2_ITERATIONS = 600000;

/**
 * Salt 长度（字节）
 * @constant {number}
 */
const SALT_LENGTH = 16;

/**
 * 指纹长度（字节）
 * SHA-256 前 16 字节
 * @constant {number}
 */
const FINGERPRINT_LENGTH = 16;

/**
 * 生成密码学安全的随机 Salt
 * @returns {Uint8Array} 16 字节随机 Salt
 */
function generateSalt() {
    return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * 生成密码学安全的随机 Base IV
 * @returns {Uint8Array} 12 字节随机 IV
 */
function generateBaseIV() {
    return crypto.getRandomValues(new Uint8Array(12));
}

/**
 * 通过 PBKDF2 从密码派生 AES-256-GCM 密钥
 * 
 * @param {string} password - 用户密码
 * @param {Uint8Array} salt - 16 字节 Salt
 * @returns {Promise<CryptoKey>} AES-GCM 密钥
 * 
 * @throws {Error} 如果 Web Crypto API 不可用
 */
async function deriveKey(password, salt) {
    if (!crypto.subtle) {
        throw new Error('CRYPTO_NOT_SUPPORTED: Web Crypto API 不可用');
    }

    // 将密码编码为 UTF-8 字节序列
    const passwordBuffer = new TextEncoder().encode(password);

    // 导入为 PBKDF2 密钥材料
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        'PBKDF2',
        false,
        ['deriveKey']
    );

    // 派生 AES-GCM 密钥
    const key = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        keyMaterial,
        {
            name: 'AES-GCM',
            length: 256
        },
        true,  // 可导出（用于指纹提取）
        ['encrypt', 'decrypt']
    );

    return key;
}

/**
 * 从密钥提取指纹（SHA-256 前 16 字节）
 * 用于快速校验密码正确性
 * 
 * @param {CryptoKey} key - AES-GCM 密钥
 * @returns {Promise<Uint8Array>} 16 字节指纹
 * 
 * @security 使用后立即对原始密钥内存执行 fill(0) 覆写
 */
async function extractFingerprint(key) {
    // 导出原始密钥字节
    const rawKey = await crypto.subtle.exportKey('raw', key);
    const rawKeyArray = new Uint8Array(rawKey);

    try {
        // SHA-256 哈希
        const hash = await crypto.subtle.digest('SHA-256', rawKey);
        const hashArray = new Uint8Array(hash);

        // 取前 16 字节作为指纹
        return hashArray.slice(0, FINGERPRINT_LENGTH);
    } finally {
        // ⚠️ 物理级内存覆写：碾碎 JavaScript 堆中的明文密钥残影
        rawKeyArray.fill(0);
    }
}

/**
 * 比较两个指纹是否相等（恒定时间比较，防时序攻击）
 * 
 * @param {Uint8Array} a - 指纹 A
 * @param {Uint8Array} b - 指纹 B
 * @returns {boolean} 是否匹配
 */
function compareFingerprint(a, b) {
    if (a.length !== b.length) return false;

    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
    }
    return result === 0;
}

/**
 * 快速校验密码是否正确
 * 仅做密钥派生 + 指纹比对，不解密任何数据
 * 
 * @param {string} password - 待校验的密码
 * @param {Uint8Array} salt - Manifest 中的 Salt
 * @param {Uint8Array} expectedFingerprint - Manifest 中的预期指纹
 * @returns {Promise<boolean>} 密码是否正确
 * 
 * @performance < 100ms
 */
async function verifyPassword(password, salt, expectedFingerprint) {
    const key = await deriveKey(password, salt);
    const actualFingerprint = await extractFingerprint(key);
    return compareFingerprint(actualFingerprint, expectedFingerprint);
}

// 导出
export {
    PBKDF2_ITERATIONS,
    SALT_LENGTH,
    FINGERPRINT_LENGTH,
    generateSalt,
    generateBaseIV,
    deriveKey,
    extractFingerprint,
    compareFingerprint,
    verifyPassword
};
