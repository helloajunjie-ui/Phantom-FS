'use strict';

/**
 * Phantom-FS / V12.1 Manifest 构建与解析模块
 * =============================================
 * 双模 Manifest 系统：
 *   - JSON 模式：用于 QR Code 编码（语义可视化）
 *   - 二进制 .ptm 模式：用于文件存储（军工级紧凑 + 隐蔽）
 * 
 * .ptm 二进制封包结构（字节级压榨）：
 *   [0-15]    Salt          (16 bytes)
 *   [16-27]   BaseIV        (12 bytes)
 *   [28-43]   Fingerprint   (16 bytes)
 *   [44-47]   ChunkSize     (Uint32, Big Endian)
 *   [48-51]   TotalChunks   (Uint32, Big Endian)
 *   [52-59]   FileSize      (Uint48, Big Endian, 支持最大 256TB)
 *   [60-...]  FileName      (UTF-8 变长字节流)
 *
 * 总计：60 字节固定头部 + 变长文件名
 * 对比 JSON 模式：300+ 字节 → ~60 字节
 * 
 * @module manifest
 */

/** @constant {string} 当前 Manifest 版本 */
const MANIFEST_VERSION = 'V12-Phantom';

/** @constant {number} 最大安全分片数 */
const MAX_SAFE_CHUNKS = 2 ** 32 - 1;

/** @constant {string} .ptm 文件 MIME 类型 */
const PTM_MIME_TYPE = 'application/octet-stream';

/** @constant {string} .ptm 文件扩展名 */
const PTM_EXTENSION = '.ptm';

/**
 * ==========================================
 * JSON 模式（兼容层，用于 QR Code）
 * ==========================================
 */

/**
 * 构建 Manifest 对象（JSON 模式）
 * 
 * @param {string} fileName - 原始文件名
 * @param {number} fileSize - 原始文件大小（字节）
 * @param {Uint8Array} salt - PBKDF2 Salt（16 字节）
 * @param {Uint8Array} baseIV - 基础 IV（12 字节）
 * @param {Uint8Array} fingerprint - 密钥指纹（16 字节）
 * @param {number} [chunkSize=5242880] - 分片大小
 * @returns {Object} Manifest 对象
 */
function buildManifest(fileName, fileSize, salt, baseIV, fingerprint, chunkSize = 5 * 1024 * 1024) {
    return {
        version: MANIFEST_VERSION,
        fileName: fileName,
        fileSize: fileSize,
        chunkSize: chunkSize,
        totalChunks: Math.ceil(fileSize / chunkSize),
        salt: Array.from(salt),
        baseIV: Array.from(baseIV),
        fingerprint: Array.from(fingerprint)
    };
}

/**
 * 解析 Manifest（JSON 模式）
 * 支持 JSON 字符串或已解析的对象
 * 
 * @param {Object|string} manifest - Manifest JSON 字符串或对象
 * @returns {Object} 解析后的 Manifest（二进制字段已恢复为 Uint8Array）
 * 
 * @throws {PhantomFSError} INVALID_MANIFEST - Manifest 格式无效
 * @throws {PhantomFSError} VERSION_MISMATCH - 版本不兼容
 * @throws {PhantomFSError} CHUNK_OVERFLOW - 分片数超出安全边界
 */
function parseManifest(manifest) {
    const obj = typeof manifest === 'string' ? JSON.parse(manifest) : manifest;

    if (!obj || !obj.version || !obj.salt || !obj.baseIV || !obj.fingerprint) {
        throw new PhantomFSError(
            'INVALID_MANIFEST',
            'Manifest 格式无效：缺少必要字段',
            { retryable: false }
        );
    }

    if (obj.version !== MANIFEST_VERSION) {
        throw new PhantomFSError(
            'VERSION_MISMATCH',
            `不支持的 Manifest 版本: ${obj.version}，期望: ${MANIFEST_VERSION}`,
            { retryable: false }
        );
    }

    if (obj.totalChunks > MAX_SAFE_CHUNKS) {
        throw new PhantomFSError(
            'CHUNK_OVERFLOW',
            `分片数 ${obj.totalChunks} 超出安全边界 ${MAX_SAFE_CHUNKS}`,
            { retryable: false }
        );
    }

    return {
        ...obj,
        salt: new Uint8Array(obj.salt),
        baseIV: new Uint8Array(obj.baseIV),
        fingerprint: new Uint8Array(obj.fingerprint)
    };
}

/**
 * 将 Manifest 序列化为 JSON 字符串
 * 
 * @param {Object} manifest - Manifest 对象
 * @returns {string} JSON 字符串
 */
function serializeManifest(manifest) {
    return JSON.stringify(manifest);
}

/**
 * ==========================================
 * 二进制 .ptm 模式（军工级紧凑封包）
 * ==========================================
 */

/**
 * 将 Manifest 序列化为二进制 .ptm 格式
 * 
 * 输出：生硬、冰冷、毫无破绽的纯粹二进制乱码
 * 用文本编辑器打开只能看到类似 `鐓?#?^@!` 的死寂乱码
 * 
 * @param {Object} manifest - Manifest 对象（含 Uint8Array 字段）
 * @returns {ArrayBuffer} .ptm 二进制数据
 * 
 * @example
 * const ptmBuffer = exportBinaryManifest(manifest);
 * const blob = new Blob([ptmBuffer], { type: 'application/octet-stream' });
 * // 保存为 blueprint.ptm
 */
function exportBinaryManifest(manifest) {
    const fileNameBytes = new TextEncoder().encode(manifest.fileName);
    
    // 固定头部 60 字节 + 变长文件名
    // ⚠️ FileSize 使用 Uint48（高16位 + 低32位），支持最大 256TB
    const totalLength = 60 + fileNameBytes.length;
    const buffer = new ArrayBuffer(totalLength);
    const view = new DataView(buffer);
    const uint8View = new Uint8Array(buffer);

    let offset = 0;

    // 1. Salt (16 bytes)
    uint8View.set(manifest.salt, offset);
    offset += 16;

    // 2. BaseIV (12 bytes)
    uint8View.set(manifest.baseIV, offset);
    offset += 12;

    // 3. Fingerprint (16 bytes)
    uint8View.set(manifest.fingerprint, offset);
    offset += 16;

    // 4. ChunkSize (4 bytes, Big Endian)
    view.setUint32(offset, manifest.chunkSize, false);
    offset += 4;

    // 5. TotalChunks (4 bytes, Big Endian)
    view.setUint32(offset, manifest.totalChunks, false);
    offset += 4;

    // 6. FileSize (6 bytes, Uint48 Big Endian — 高16位 + 低32位)
    const fileSizeHi = Math.floor(manifest.fileSize / 0x100000000); // 高 16 位
    const fileSizeLo = manifest.fileSize >>> 0;                     // 低 32 位
    view.setUint16(offset, fileSizeHi, false);
    offset += 2;
    view.setUint32(offset, fileSizeLo, false);
    offset += 4;

    // 7. FileName (变长 UTF-8 字节流)
    uint8View.set(fileNameBytes, offset);

    return buffer;
}

/**
 * 从二进制 .ptm 格式解析 Manifest
 * 
 * @param {ArrayBuffer} buffer - .ptm 二进制数据
 * @returns {Object} Manifest 对象（含 Uint8Array 字段）
 * 
 * @throws {PhantomFSError} INVALID_MANIFEST - 数据长度不足
 * @throws {PhantomFSError} CHUNK_OVERFLOW - 分片数超出安全边界
 */
function importBinaryManifest(buffer) {
    if (buffer.byteLength < 60) {
        throw new PhantomFSError(
            'INVALID_MANIFEST',
            `.ptm 文件长度不足（${buffer.byteLength} < 60）`,
            { retryable: false }
        );
    }

    const view = new DataView(buffer);
    const uint8View = new Uint8Array(buffer);

    let offset = 0;

    // 1. Salt (16 bytes)
    const salt = uint8View.slice(offset, offset + 16);
    offset += 16;

    // 2. BaseIV (12 bytes)
    const baseIV = uint8View.slice(offset, offset + 12);
    offset += 12;

    // 3. Fingerprint (16 bytes)
    const fingerprint = uint8View.slice(offset, offset + 16);
    offset += 16;

    // 4. ChunkSize (4 bytes)
    const chunkSize = view.getUint32(offset, false);
    offset += 4;

    // 5. TotalChunks (4 bytes)
    const totalChunks = view.getUint32(offset, false);
    offset += 4;

    // 6. FileSize (6 bytes, Uint48 Big Endian — 高16位 + 低32位)
    const fileSizeHi = view.getUint16(offset, false);
    offset += 2;
    const fileSizeLo = view.getUint32(offset, false);
    offset += 4;
    const fileSize = fileSizeHi * 0x100000000 + fileSizeLo;

    // 7. FileName (变长)
    const fileNameBytes = uint8View.slice(offset);
    const fileName = new TextDecoder().decode(fileNameBytes);

    // 数学边界校验
    if (totalChunks > MAX_SAFE_CHUNKS) {
        throw new PhantomFSError(
            'CHUNK_OVERFLOW',
            `分片数 ${totalChunks} 超出安全边界 ${MAX_SAFE_CHUNKS}`,
            { retryable: false }
        );
    }

    return {
        version: MANIFEST_VERSION,
        fileName: fileName,
        fileSize: fileSize,
        chunkSize: chunkSize,
        totalChunks: totalChunks,
        salt: salt,
        baseIV: baseIV,
        fingerprint: fingerprint
    };
}

/**
 * 检测数据是否为二进制 .ptm 格式
 * 
 * 判断依据：.ptm 文件没有 JSON 的 '{' 起始字符
 * 
 * @param {ArrayBuffer|string|Object} data - 待检测数据
 * @returns {boolean} 是否为二进制格式
 */
function isBinaryManifest(data) {
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        return true;
    }
    if (typeof data === 'string') {
        return !data.trim().startsWith('{');
    }
    return false;
}

/**
 * 智能解析 Manifest（自动检测 JSON / 二进制）
 * 
 * @param {ArrayBuffer|string|Object} data - Manifest 数据
 * @returns {Object} 解析后的 Manifest 对象
 */
function parseManifestAuto(data) {
    if (data instanceof ArrayBuffer) {
        return importBinaryManifest(data);
    }
    if (data instanceof Uint8Array) {
        // ⚠️ Uint8Array.buffer 可能包含偏移量，使用 .slice() 确保从正确位置开始
        return importBinaryManifest(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (typeof data === 'string') {
        // 尝试 JSON 解析
        try {
            return parseManifest(data);
        } catch (e) {
            // 不是 JSON，尝试作为二进制（Base64 编码的 .ptm）
            try {
                const binary = base64ToArrayBuffer(data);
                return importBinaryManifest(binary);
            } catch (e2) {
                throw new PhantomFSError(
                    'INVALID_MANIFEST',
                    '无法解析 Manifest：不是有效的 JSON 也不是 .ptm 格式',
                    { retryable: false }
                );
            }
        }
    }
    // 已经是对象
    return parseManifest(data);
}

/**
 * 将 .ptm 二进制数据编码为 Base64（用于 QR Code）
 * 
 * @param {ArrayBuffer} buffer - .ptm 二进制数据
 * @returns {string} Base64 编码字符串
 */
function binaryManifestToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * 将 Base64 解码为 ArrayBuffer
 * 
 * @param {string} base64 - Base64 编码字符串
 * @returns {ArrayBuffer} 解码后的二进制数据
 */
function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * 估算 Manifest 体积（字节）
 * 
 * @param {Object} manifest - Manifest 对象
 * @returns {{ json: number, binary: number }} JSON 和二进制模式的体积
 */
function estimateManifestSize(manifest) {
    const json = serializeManifest(manifest);
    const binary = exportBinaryManifest(manifest);
    return {
        json: new TextEncoder().encode(json).length,
        binary: binary.byteLength
    };
}

/**
 * PhantomFSError（轻量版，避免循环依赖）
 */
class PhantomFSError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PhantomFSError';
        this.code = code;
        this.retryable = details.retryable !== false;
    }
}

// 导出
export {
    MANIFEST_VERSION,
    MAX_SAFE_CHUNKS,
    PTM_MIME_TYPE,
    PTM_EXTENSION,
    // JSON 模式
    buildManifest,
    parseManifest,
    serializeManifest,
    // 二进制 .ptm 模式
    exportBinaryManifest,
    importBinaryManifest,
    isBinaryManifest,
    parseManifestAuto,
    binaryManifestToBase64,
    base64ToArrayBuffer,
    // 工具
    estimateManifestSize
};
