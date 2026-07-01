'use strict';

/**
 * Phantom-FS / V13 流式加密引擎核心
 * =====================================
 * AES-256-GCM 流式加解密 + 确定性 IV 推导 + AAD 防篡改
 * 存储无关：通过 IStorageProvider 接口适配任意后端
 *
 * @module phantom-cipher
 */

import { deriveKey, extractFingerprint, compareFingerprint } from './key-derivation.js';
import { buildManifest, parseManifest } from './manifest.js';
import { ConcurrencyPool } from '../utils/pool.js';
import { secureZero } from '../utils/memory.js';
import { MemoryProvider, toChunkId } from '../storage/cloud-store.js';

/** @constant {number} 默认分片大小：5MB */
const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;

/** @constant {number} 默认最大并发数 */
const DEFAULT_MAX_CONCURRENCY = 5;

/** @constant {number} 默认最大重试次数 */
const DEFAULT_MAX_RETRIES = 3;

/** @constant {number} 最大安全分片数：2^32 - 1 */
const MAX_SAFE_CHUNKS = 2 ** 32 - 1;

/**
 * 确定性 IV 推导
 * 采用 baseIV ^ chunkIndex 的纯数学推导
 * 摒弃记录海量分片 IV 的笨拙做法
 * 
 * @param {Uint8Array} baseIV - 基础 IV（12 字节）
 * @param {number} chunkIndex - 分片索引（从 0 开始）
 * @returns {Uint8Array} 该分片的 IV
 * 
 * @security 在 2^32 - 1 个分片内 IV 唯一，绝不溢出
 */
function deriveChunkIV(baseIV, chunkIndex) {
    const iv = new Uint8Array(baseIV);
    const view = new DataView(iv.buffer);

    // 将最后 4 字节与 chunkIndex 进行 XOR
    // ⚠️ Roo Audit: JS 按位操作符强制转为 32 位有符号整型
    // >>> 0 确保结果强制转回无符号 32 位，与 Go uint32 对齐
    const last4Bytes = view.getUint32(8, false); // Big Endian
    const derived = (last4Bytes ^ chunkIndex) >>> 0;
    view.setUint32(8, derived, false);

    return iv;
}

/**
 * 构建 AAD（附加认证数据）
 * 将分片索引转为 UTF-8 字符串
 * 消除字节序炸弹，实现跨平台防篡改
 * 
 * @param {number} chunkIndex - 分片索引
 * @returns {Uint8Array} UTF-8 编码的 AAD
 */
function buildAAD(chunkIndex) {
    return new TextEncoder().encode(`chunk_${chunkIndex}`);
}

/**
 * 加密单个分片
 * 
 * @param {ArrayBuffer} chunkBuffer - 明文分片数据
 * @param {CryptoKey} key - AES-GCM 密钥
 * @param {Uint8Array} baseIV - 基础 IV
 * @param {number} chunkIndex - 分片索引
 * @returns {Promise<ArrayBuffer>} 加密后的数据
 */
async function encryptChunk(chunkBuffer, key, baseIV, chunkIndex) {
    const iv = deriveChunkIV(baseIV, chunkIndex);
    const aad = buildAAD(chunkIndex);

    return await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: iv,
            additionalData: aad,
            tagLength: 128
        },
        key,
        chunkBuffer
    );
}

/**
 * 解密单个分片
 * 
 * @param {ArrayBuffer} encryptedBuffer - 加密分片数据
 * @param {CryptoKey} key - AES-GCM 密钥
 * @param {Uint8Array} baseIV - 基础 IV
 * @param {number} chunkIndex - 分片索引
 * @returns {Promise<ArrayBuffer>} 解密后的数据
 * 
 * @throws {Error} TAMPERED_DATA - 数据被篡改或 AAD 不匹配时抛出
 */
async function decryptChunk(encryptedBuffer, key, baseIV, chunkIndex) {
    const iv = deriveChunkIV(baseIV, chunkIndex);
    const aad = buildAAD(chunkIndex);

    try {
        return await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: iv,
                additionalData: aad,
                tagLength: 128
            },
            key,
            encryptedBuffer
        );
    } catch (error) {
        // AES-GCM 认证失败 → 数据被篡改或密码错误
        throw new PhantomFSError(
            'TAMPERED_DATA',
            `分片 ${chunkIndex} 数据完整性校验失败`,
            { chunkIndex }
        );
    }
}

/**
 * Phantom-FS 错误类
 */
class PhantomFSError extends Error {
    /**
     * @param {string} code - 错误码
     * @param {string} message - 错误描述
     * @param {Object} [details] - 附加信息
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PhantomFSError';
        this.code = code;
        this.chunkIndex = details.chunkIndex;
        this.retryable = details.retryable !== false;
    }
}

/**
 * 加密文件并上传分片
 * 
 * @param {File} file - 用户选择的文件
 * @param {string} password - 加密密码
 * @param {Object} [options] - 可选配置
 * @param {number} [options.chunkSize=5242880] - 分片大小
 * @param {number} [options.maxConcurrency=5] - 最大并发数
 * @param {number} [options.maxRetries=3] - 上传重试次数
 * @param {Function} [options.onProgress] - 进度回调
 * @param {Object} [options.storage] - 存储后端
 * @returns {Promise<{manifest: Object, fileId: string, errors: Error[], duration: number}>}
 */
async function encryptFile(file, password, options = {}) {
    const {
        chunkSize = DEFAULT_CHUNK_SIZE,
        maxConcurrency = DEFAULT_MAX_CONCURRENCY,
        maxRetries = DEFAULT_MAX_RETRIES,
        onProgress = null,
        storage = null
    } = options;

    // 兼容新旧接口：storage 可为 IStorageProvider 或旧 CloudStore
    const provider = storage || new MemoryProvider();

    const startTime = performance.now();

    // 1. 生成密码学参数
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const baseIV = crypto.getRandomValues(new Uint8Array(12));

    // 2. 派生密钥
    const key = await deriveKey(password, salt);
    const fingerprint = await extractFingerprint(key);

    // 3. 计算分片数并校验边界
    const totalChunks = Math.ceil(file.size / chunkSize);
    if (totalChunks > MAX_SAFE_CHUNKS) {
        throw new PhantomFSError(
            'CHUNK_OVERFLOW',
            `文件过大（需要 ${totalChunks} 个分片），超过安全边界 ${MAX_SAFE_CHUNKS}`,
            { retryable: false }
        );
    }

    // 4. 构建 Manifest
    const manifest = buildManifest(
        file.name,
        file.size,
        salt,
        baseIV,
        fingerprint,
        chunkSize
    );

    // 5. 生成文件标识
    const fileId = generateFileId();

    // 6. 并发加密上传
    const pool = new ConcurrencyPool(maxConcurrency, maxRetries);
    const errors = [];

    for (let i = 0; i < totalChunks; i++) {
        const chunkBlob = file.slice(
            i * chunkSize,
            Math.min((i + 1) * chunkSize, file.size)
        );

        pool.add(async () => {
            const buffer = await chunkBlob.arrayBuffer();
            const encrypted = await encryptChunk(buffer, key, baseIV, i);

            await provider.putChunk(toChunkId(fileId, i), encrypted);

            if (onProgress) {
                onProgress({
                    phase: 'encrypt',
                    current: i + 1,
                    total: totalChunks,
                    chunkIndex: i,
                    bytesProcessed: Math.min((i + 1) * chunkSize, file.size),
                    bytesTotal: file.size
                });
            }
        }).catch(err => {
            errors.push(err);
        });
    }

    await pool.waitAll();

    // 7. 清理密钥内存
    secureZero(key);

    const duration = performance.now() - startTime;

    return {
        manifest,
        fileId,
        errors,
        duration
    };
}

/**
 * 解密文件
 * 
 * @param {Object|string} manifest - Manifest 对象或 JSON 字符串
 * @param {string} password - 解密密码
 * @param {string} fileId - 文件标识
 * @param {Object} [options] - 可选配置
 * @param {number} [options.maxConcurrency=5] - 最大并发数
 * @param {Function} [options.onProgress] - 进度回调
 * @param {Object} [options.storage] - 存储后端
 * @returns {Promise<Blob>} 解密后的文件 Blob
 */
async function decryptFile(manifest, password, fileId, options = {}) {
    const {
        maxConcurrency = DEFAULT_MAX_CONCURRENCY,
        onProgress = null,
        storage = null
    } = options;

    // 兼容新旧接口
    const provider = storage || new MemoryProvider();

    // 1. 解析 Manifest
    const parsed = parseManifest(manifest);

    // 2. 派生密钥
    const key = await deriveKey(password, parsed.salt);

    // 3. 指纹校验（快速失败）
    const fingerprint = await extractFingerprint(key);
    if (!compareFingerprint(fingerprint, parsed.fingerprint)) {
        throw new PhantomFSError(
            'WRONG_PASSWORD',
            '密码错误',
            { retryable: false }
        );
    }

    // 4. 并发下载解密
    const pool = new ConcurrencyPool(maxConcurrency, DEFAULT_MAX_RETRIES);
    const decryptedChunks = new Array(parsed.totalChunks);
    const errors = [];

    for (let i = 0; i < parsed.totalChunks; i++) {
        pool.add(async () => {
            const encrypted = await provider.getChunk(toChunkId(fileId, i));

            const decrypted = await decryptChunk(encrypted, key, parsed.baseIV, i);
            decryptedChunks[i] = decrypted;

            if (onProgress) {
                onProgress({
                    phase: 'decrypt',
                    current: i + 1,
                    total: parsed.totalChunks,
                    chunkIndex: i,
                    bytesProcessed: Math.min((i + 1) * parsed.chunkSize, parsed.fileSize),
                    bytesTotal: parsed.fileSize
                });
            }
        }).catch(err => {
            errors.push(err);
        });
    }

    await pool.waitAll();

    // 5. 清理密钥内存
    secureZero(key);

    // 6. 合并文件
    return new Blob(decryptedChunks, { type: 'application/octet-stream' });
}

/**
 * 流式解密单个分片（用于视频 Seek）
 * 
 * @param {Object|string} manifest - Manifest
 * @param {string} password - 密码
 * @param {string} fileId - 文件标识
 * @param {number} chunkIndex - 分片索引
 * @param {Object} [storage] - 存储后端
 * @returns {Promise<ArrayBuffer>} 解密后的分片数据
 */
async function streamChunk(manifest, password, fileId, chunkIndex, storage = null) {
    const parsed = parseManifest(manifest);
    const key = await deriveKey(password, parsed.salt);

    // 指纹校验（快速失败）
    const fingerprint = await extractFingerprint(key);
    if (!compareFingerprint(fingerprint, parsed.fingerprint)) {
        secureZero(key);
        throw new PhantomFSError(
            'WRONG_PASSWORD',
            '密码错误',
            { retryable: false }
        );
    }

    // 兼容新旧接口
    const provider = storage || new MemoryProvider();

    try {
        const encrypted = await provider.getChunk(toChunkId(fileId, chunkIndex));
        return await decryptChunk(encrypted, key, parsed.baseIV, chunkIndex);
    } finally {
        secureZero(key);
    }
}

/**
 * 生成文件标识
 * @returns {string} 32 字符十六进制字符串
 */
function generateFileId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// 导出
export {
    DEFAULT_CHUNK_SIZE,
    MAX_SAFE_CHUNKS,
    PhantomFSError,
    deriveChunkIV,
    buildAAD,
    encryptChunk,
    decryptChunk,
    encryptFile,
    decryptFile,
    streamChunk,
    generateFileId
};
