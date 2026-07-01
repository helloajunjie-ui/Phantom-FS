'use strict';

/**
 * Phantom-FS / V13 BYOS 存储适配器层
 * ====================================
 * 基于依赖倒置原则（DIP）的标准存储接口
 * 核心引擎不依赖任何具体存储实现
 * 
 * BYOS (Bring Your Own Storage):
 *   用户自带存储，我们只提供加密引擎。
 *   你没有存储成本，但你接管了全球最机密的数据流转。
 * 
 * Provider 矩阵:
 *   - MemoryProvider:    开发调试 / 测试
 *   - HTTPProvider:      通用 HTTP Range Request (S3/Nginx)
 *   - S3Provider:        AWS S3 / 阿里云 OSS / MinIO
 *   - WebDAVProvider:    Nextcloud / Synology / 自建 WebDAV
 *   - FileSystemProvider: 浏览器 OPFS (Origin Private File System)
 *   - LocalFileProvider: 浏览器 File System Access API
 * 
 * @module cloud-store
 */

// ============================================================
//  IStorageProvider 接口
// ============================================================

/**
 * 存储提供者接口
 * 
 * chunkId 格式: "{fileId}/{index}" (如 "abc123/00000000")
 * 所有 Provider 必须实现此接口
 * 
 * @interface IStorageProvider
 */
class IStorageProvider {
    /**
     * 保存一个分片
     * @param {string} chunkId - 分片标识 (格式: fileId/index)
     * @param {ArrayBuffer} data - 加密后的分片数据
     * @returns {Promise<string>} 存储后的寻址 ID
     */
    async putChunk(chunkId, data) {
        throw new Error('IStorageProvider: putChunk() 未实现');
    }

    /**
     * 获取一个分片（支持 HTTP Range 用于流式 Seek）
     * @param {string} chunkId - 分片标识
     * @param {Object} [range] - 可选字节范围
     * @param {number} [range.start] - 起始字节
     * @param {number} [range.end] - 结束字节
     * @returns {Promise<ArrayBuffer>} 分片数据
     */
    async getChunk(chunkId, range) {
        throw new Error('IStorageProvider: getChunk() 未实现');
    }

    /**
     * 删除一个文件的所有分片
     * @param {string} fileId - 文件标识
     * @returns {Promise<void>}
     */
    async deleteFile(fileId) {
        throw new Error('IStorageProvider: deleteFile() 未实现');
    }

    /**
     * 获取分片的直接访问 URL（用于 Range Request 优化）
     * @param {string} chunkId - 分片标识
     * @returns {string|null} URL 或 null（不支持直接访问）
     */
    getChunkURL(chunkId) {
        return null;
    }

    /**
     * 获取 Provider 名称
     * @returns {string}
     */
    get name() {
        return this.constructor.name;
    }
}

// ============================================================
//  工具函数
// ============================================================

/**
 * 将 fileId + index 拼接为标准 chunkId
 * @param {string} fileId
 * @param {number} index
 * @returns {string}
 */
function toChunkId(fileId, index) {
    return `${fileId}/${padIndex(index)}`;
}

/**
 * 从 chunkId 解析 fileId 和 index
 * @param {string} chunkId
 * @returns {{ fileId: string, index: number }}
 */
function parseChunkId(chunkId) {
    const parts = chunkId.split('/');
    return {
        fileId: parts[0],
        index: parseInt(parts[1], 16)
    };
}

/**
 * 将分片索引补齐为 8 位十六进制
 * @param {number} index
 * @returns {string}
 */
function padIndex(index) {
    return index.toString(16).padStart(8, '0');
}

// ============================================================
//  内置实现
// ============================================================

/**
 * 内存存储后端（开发调试 / 测试用）
 * @class MemoryProvider
 * @extends IStorageProvider
 */
class MemoryProvider extends IStorageProvider {
    constructor() {
        super();
        /** @private @type {Map<string, Map<string, ArrayBuffer>>} */
        this._store = new Map();
    }

    async putChunk(chunkId, data) {
        const { fileId } = parseChunkId(chunkId);
        if (!this._store.has(fileId)) {
            this._store.set(fileId, new Map());
        }
        this._store.get(fileId).set(chunkId, data.slice(0));
        return `memory://${chunkId}`;
    }

    async getChunk(chunkId, range) {
        const { fileId } = parseChunkId(chunkId);
        const file = this._store.get(fileId);
        if (!file || !file.has(chunkId)) {
            throw new Error(`分片不存在: ${chunkId}`);
        }

        let data = file.get(chunkId);
        if (range) {
            const { start, end } = range;
            data = data.slice(start, end);
        }
        return data.slice(0);
    }

    async deleteFile(fileId) {
        this._store.delete(fileId);
    }

    getChunkURL(chunkId) {
        return `memory://${chunkId}`;
    }

    getStats() {
        let files = 0;
        let chunks = 0;
        let size = 0;

        for (const [, file] of this._store) {
            files++;
            for (const [, data] of file) {
                chunks++;
                size += data.byteLength;
            }
        }

        return { files, chunks, size };
    }
}

/**
 * HTTP 存储后端（基于 Range Request）
 * 兼容 S3 / Nginx / 任何支持 Range 的静态文件服务器
 * 
 * @class HTTPProvider
 * @extends IStorageProvider
 */
class HTTPProvider extends IStorageProvider {
    /**
     * @param {Object} options
     * @param {string} options.baseURL - 存储基础 URL
     * @param {Function} [options.getAuthHeaders] - 获取认证头
     */
    constructor(options) {
        super();
        this._baseURL = options.baseURL.replace(/\/$/, '');
        this._getAuthHeaders = options.getAuthHeaders || (() => ({}));
    }

    async putChunk(chunkId, data) {
        const url = `${this._baseURL}/${chunkId}.chunk`;
        const headers = {
            'Content-Type': 'application/octet-stream',
            ...this._getAuthHeaders()
        };

        const response = await fetch(url, {
            method: 'PUT',
            headers,
            body: data
        });

        if (!response.ok) {
            throw new Error(`上传失败: ${response.status} ${response.statusText}`);
        }

        return url;
    }

    async getChunk(chunkId, range) {
        const url = this.getChunkURL(chunkId);
        const headers = { ...this._getAuthHeaders() };

        if (range) {
            // HTTP Range 是 inclusive（包含 end），接口定义 range.end 是 exclusive
            // 所以需要 end - 1
            headers['Range'] = `bytes=${range.start}-${range.end - 1}`;
        }

        const response = await fetch(url, { headers });

        if (!response.ok && response.status !== 206) {
            throw new Error(`下载失败: ${response.status} ${response.statusText}`);
        }

        return await response.arrayBuffer();
    }

    async deleteFile(fileId) {
        console.warn('HTTPProvider: deleteFile 未实现，需要后端支持批量删除');
    }

    getChunkURL(chunkId) {
        return `${this._baseURL}/${chunkId}.chunk`;
    }
}

// ============================================================
//  BYOS Provider 矩阵
// ============================================================

/**
 * S3 兼容对象存储后端
 * 支持 AWS S3 / 阿里云 OSS / MinIO / 任何 S3 兼容 API
 *
 * 认证方式（仅支持预签名 URL）:
 *   浏览器端无法安全实现 AWS SigV4（会暴露 SecretKey），
 *   因此 S3Provider 仅支持预签名 URL 模式。
 *   用户需在服务端生成预签名 URL 后传入。
 *
 * 工作流:
 *   1. 用户通过自己的后端服务生成预签名 URL
 *   2. 传入 getPresignedURL(method, key) => Promise<string>
 *   3. 浏览器直接用预签名 URL 上传/下载，无需暴露任何密钥
 *
 * @class S3Provider
 * @extends IStorageProvider
 */
class S3Provider extends IStorageProvider {
    /**
     * @param {Object} options
     * @param {Function} options.getPresignedURL - 预签名 URL 生成函数
     *    签名: (method: 'PUT'|'GET', key: string) => Promise<string>
     * @param {string} [options.endpoint] - S3 端点 URL（仅用于 getChunkURL 显示）
     * @param {string} [options.bucket] - 存储桶名称（仅用于 getChunkURL 显示）
     */
    constructor(options) {
        super();
        this._getPresignedURL = options.getPresignedURL;
        this._endpoint = options.endpoint ? options.endpoint.replace(/\/$/, '') : '';
        this._bucket = options.bucket || '';
    }

    /**
     * 生成 S3 对象键
     * @private
     */
    _objectKey(chunkId) {
        return `phantom-fs/${chunkId}.chunk`;
    }

    async putChunk(chunkId, data) {
        const key = this._objectKey(chunkId);

        if (!this._getPresignedURL) {
            throw new Error(
                'S3Provider 需要 getPresignedURL 函数。' +
                '浏览器端无法安全实现 SigV4 签名，请通过服务端生成预签名 URL。'
            );
        }

        const url = await this._getPresignedURL('PUT', key);
        const response = await fetch(url, {
            method: 'PUT',
            body: data,
            headers: { 'Content-Type': 'application/octet-stream' }
        });

        if (!response.ok) {
            throw new Error(`S3 上传失败: ${response.status}`);
        }

        return url.split('?')[0];
    }

    async getChunk(chunkId, range) {
        const key = this._objectKey(chunkId);

        if (!this._getPresignedURL) {
            throw new Error(
                'S3Provider 需要 getPresignedURL 函数。' +
                '浏览器端无法安全实现 SigV4 签名，请通过服务端生成预签名 URL。'
            );
        }

        const url = await this._getPresignedURL('GET', key);
        const headers = {};

        if (range) {
            // HTTP Range 是 inclusive，接口定义 range.end 是 exclusive
            headers['Range'] = `bytes=${range.start}-${range.end - 1}`;
        }

        const response = await fetch(url, { headers });
        if (!response.ok && response.status !== 206) {
            throw new Error(`S3 下载失败: ${response.status}`);
        }

        return await response.arrayBuffer();
    }

    async deleteFile(fileId) {
        // S3 批量删除需要 ListObjects 列出所有分片 + DeleteObjects 批量删除
        // 需要服务端支持，浏览器端无法直接实现
        throw new Error(
            'S3Provider 不支持浏览器端批量删除。' +
            '请通过服务端实现 ListObjects + DeleteObjects。'
        );
    }

    getChunkURL(chunkId) {
        const key = this._objectKey(chunkId);
        return `${this._endpoint}/${this._bucket}/${key}`;
    }
}

/**
 * WebDAV 存储后端
 * 支持 Nextcloud / Synology / ownCloud / 自建 WebDAV 服务器
 * 
 * 认证方式:
 *   - 用户名 + 密码 (通过 CredentialVault 安全存储)
 *   - 应用密码 (推荐)
 * 
 * @class WebDAVProvider
 * @extends IStorageProvider
 */
class WebDAVProvider extends IStorageProvider {
    /**
     * @param {Object} options
     * @param {string} options.baseURL - WebDAV 根 URL
     * @param {string} [options.username] - 用户名
     * @param {string} [options.password] - 密码
     * @param {Function} [options.getAuthHeaders] - 自定义认证头
     */
    constructor(options) {
        super();
        this._baseURL = options.baseURL.replace(/\/$/, '');
        this._username = options.username || '';
        this._password = options.password || '';
        this._getAuthHeaders = options.getAuthHeaders || (() => this._basicAuth());
    }

    /**
     * 生成 Basic Auth 头
     * @private
     */
    _basicAuth() {
        if (!this._username) return {};
        const credentials = btoa(`${this._username}:${this._password}`);
        return { 'Authorization': `Basic ${credentials}` };
    }

    /**
     * WebDAV 路径
     * @private
     */
    _webdavPath(chunkId) {
        return `/phantom-fs/${chunkId}.chunk`;
    }

    async putChunk(chunkId, data) {
        const url = `${this._baseURL}${this._webdavPath(chunkId)}`;
        const headers = {
            'Content-Type': 'application/octet-stream',
            ...this._getAuthHeaders()
        };

        // WebDAV 使用 PUT 上传
        const response = await fetch(url, {
            method: 'PUT',
            headers,
            body: data
        });

        if (!response.ok) {
            throw new Error(`WebDAV 上传失败: ${response.status} ${response.statusText}`);
        }

        return url;
    }

    async getChunk(chunkId, range) {
        const url = `${this._baseURL}${this._webdavPath(chunkId)}`;
        const headers = { ...this._getAuthHeaders() };

        if (range) {
            // HTTP Range 是 inclusive（包含 end），接口定义 range.end 是 exclusive
            // 所以需要 end - 1
            headers['Range'] = `bytes=${range.start}-${range.end - 1}`;
        }

        const response = await fetch(url, { headers });
        if (!response.ok && response.status !== 206) {
            throw new Error(`WebDAV 下载失败: ${response.status} ${response.statusText}`);
        }

        return await response.arrayBuffer();
    }

    async deleteFile(fileId) {
        // WebDAV 支持 PROPFIND 列出 + DELETE 批量删除
        console.warn('WebDAVProvider: deleteFile 需要实现批量删除逻辑');
    }

    getChunkURL(chunkId) {
        return `${this._baseURL}${this._webdavPath(chunkId)}`;
    }
}

/**
 * 浏览器 OPFS (Origin Private File System) 存储后端
 * 
 * OPFS 是浏览器原生提供的沙盒文件系统:
 *   - 数据隔离: 每个源独立沙盒，其他网站无法访问
 *   - 高性能: 直接操作二进制数据，无需 Blob 转换
 *   - 持久化: 浏览器不清除，除非用户主动清除站点数据
 *   - 离线可用: 无需网络
 * 
 * 注意: 需要浏览器支持 OPFS (Chrome 86+, Edge 86+, Firefox 111+)
 * 
 * @class FileSystemProvider
 * @extends IStorageProvider
 */
class FileSystemProvider extends IStorageProvider {
    constructor() {
        super();
        /** @private @type {FileSystemDirectoryHandle|null} */
        this._root = null;
        /** @private */
        this._ready = false;
    }

    /**
     * 初始化 OPFS 根目录
     * @private
     */
    async _ensureInit() {
        if (this._ready) return;
        try {
            this._root = await navigator.storage.getDirectory();
            this._ready = true;
        } catch (e) {
            throw new Error(`OPFS 初始化失败: ${e.message}。请使用 Chrome 86+ / Edge 86+ / Firefox 111+`);
        }
    }

    /**
     * 获取或创建分片文件句柄
     * @private
     */
    async _getFileHandle(chunkId, create = false) {
        await this._ensureInit();
        
        // 按 fileId 分目录: phantom-fs/{fileId}/{index}.chunk
        const { fileId } = parseChunkId(chunkId);
        const fsDir = await this._root.getDirectoryHandle('phantom-fs', { create });
        const fileDir = await fsDir.getDirectoryHandle(fileId, { create });
        
        const fileName = `${chunkId.split('/')[1]}.chunk`;
        return await fileDir.getFileHandle(fileName, { create });
    }

    async putChunk(chunkId, data) {
        const handle = await this._getFileHandle(chunkId, true);
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
        return `opfs://phantom-fs/${chunkId}.chunk`;
    }

    async getChunk(chunkId, range) {
        const handle = await this._getFileHandle(chunkId, false);
        const file = await handle.getFile();

        if (range) {
            const blob = file.slice(range.start, range.end);
            return await blob.arrayBuffer();
        }

        return await file.arrayBuffer();
    }

    async deleteFile(fileId) {
        await this._ensureInit();
        try {
            const fsDir = await this._root.getDirectoryHandle('phantom-fs');
            await fsDir.removeEntry(fileId, { recursive: true });
        } catch (e) {
            // 目录可能不存在
        }
    }

    getChunkURL(chunkId) {
        return null; // OPFS 不支持直接 URL 访问
    }
}

/**
 * 本地文件系统存储后端（基于 File System Access API）
 * 将加密分片存储在用户选择的本地目录中
 * 
 * 注意：需要浏览器支持 File System Access API (Chrome 86+)
 * 用户需要授权目录访问权限
 * 
 * @class LocalFileProvider
 * @extends IStorageProvider
 */
class LocalFileProvider extends IStorageProvider {
    /**
     * 基于 File System Access API 的本地目录存储
     * 用户主动选择目录后，加密分片直接写入该目录下的 .phantom-fs/ 子目录
     *
     * @param {Object} [options]
     * @param {string} [options.dirName='.phantom-fs'] - 存储目录名（在用户所选目录下）
     */
    constructor(options = {}) {
        super();
        this._dirName = options.dirName || '.phantom-fs';
        /** @private @type {FileSystemDirectoryHandle|null} */
        this._rootDir = null;
        /** @private @type {FileSystemDirectoryHandle|null} */
        this._chunkDir = null;
        /** @private */
        this._initialized = false;
    }

    /**
     * 弹出系统目录选择器，让用户选择存储位置
     * 浏览器会显示权限弹窗，用户必须主动授权
     */
    async init() {
        if (this._initialized) return;

        try {
            // 弹出系统目录选择对话框 — 这才是真正的"本地目录"
            this._rootDir = await window.showDirectoryPicker({
                id: 'phantom-fs-storage',
                mode: 'readwrite',
                startIn: 'documents'
            });

            // 在用户选择的目录下创建 .phantom-fs/ 子目录
            this._chunkDir = await this._rootDir.getDirectoryHandle(this._dirName, {
                create: true
            });

            this._initialized = true;
        } catch (e) {
            if (e.name === 'AbortError' || e.name === 'SecurityError') {
                throw new Error('用户取消了目录选择，无法使用本地存储');
            }
            throw new Error(`LocalFileProvider: 无法访问本地存储 (${e.message})`);
        }
    }

    async putChunk(chunkId, data) {
        if (!this._initialized) await this.init();
        const { fileId } = parseChunkId(chunkId);

        // 按 fileId 分目录存储，避免单目录文件过多
        let fileDir;
        try {
            fileDir = await this._chunkDir.getDirectoryHandle(fileId, { create: true });
        } catch (e) {
            fileDir = this._chunkDir;
        }

        const fileName = `${chunkId.replace('/', '_')}.chunk`;
        const fileHandle = await fileDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable({ keepExistingData: false });
        await writable.write(data);
        await writable.close();

        return `local://${this._dirName}/${fileId}/${fileName}`;
    }

    async getChunk(chunkId, range) {
        if (!this._initialized) await this.init();
        const { fileId } = parseChunkId(chunkId);

        let fileDir;
        try {
            fileDir = await this._chunkDir.getDirectoryHandle(fileId);
        } catch (e) {
            fileDir = this._chunkDir;
        }

        const fileName = `${chunkId.replace('/', '_')}.chunk`;
        const fileHandle = await fileDir.getFileHandle(fileName);
        const file = await fileHandle.getFile();

        if (range) {
            const blob = file.slice(range.start, range.end);
            return await blob.arrayBuffer();
        }

        return await file.arrayBuffer();
    }

    async deleteFile(fileId) {
        if (!this._initialized) return;
        try {
            await this._chunkDir.removeEntry(fileId, { recursive: true });
        } catch (e) {
            // 目录可能不存在
        }
    }
}

// ============================================================
//  Provider 工厂
// ============================================================

/**
 * Provider 类型枚举
 */
const ProviderType = {
    MEMORY: 'memory',
    HTTP: 'http',
    S3: 's3',
    WEBDAV: 'webdav',
    OPFS: 'opfs',
    LOCAL: 'local'
};

/**
 * Provider 工厂 - 根据类型和配置创建 Provider 实例
 * 
 * @param {string} type - Provider 类型 (ProviderType 枚举)
 * @param {Object} [options] - 配置参数
 * @returns {IStorageProvider}
 * 
 * @example
 * // 创建 S3 Provider（需要服务端 Presign API）
 * const s3 = createProvider('s3', {
 *     endpoint: 'https://s3.amazonaws.com',
 *     bucket: 'my-bucket',
 *     presignEndpoint: 'https://your-api.com/presign',
 *     authToken: '...'
 * });
 * 
 * @example
 * // 创建 WebDAV Provider
 * const webdav = createProvider('webdav', {
 *     baseURL: 'https://nextcloud.example.com/remote.php/dav/files/user',
 *     username: 'user',
 *     password: 'app-password'
 * });
 */
function createProvider(type, options = {}) {
    switch (type) {
        case ProviderType.MEMORY:
            return new MemoryProvider();
        case ProviderType.HTTP:
            return new HTTPProvider(options);
        case ProviderType.S3:
            return new S3Provider(options);
        case ProviderType.WEBDAV:
            return new WebDAVProvider(options);
        case ProviderType.OPFS:
            return new FileSystemProvider();
        case ProviderType.LOCAL:
            return new LocalFileProvider(options);
        default:
            throw new Error(`未知 Provider 类型: ${type}。可用类型: ${Object.values(ProviderType).join(', ')}`);
    }
}

export {
    IStorageProvider,
    MemoryProvider,
    HTTPProvider,
    S3Provider,
    WebDAVProvider,
    FileSystemProvider,
    LocalFileProvider,
    ProviderType,
    createProvider,
    toChunkId,
    parseChunkId
};
