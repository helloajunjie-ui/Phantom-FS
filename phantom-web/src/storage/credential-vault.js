'use strict';

/**
 * Phantom-FS / V13 BYOS 凭证保险箱
 * ===================================
 * 零信任凭证管理模块
 * 
 * 核心原则:
 *   1. API Key 永不上传服务器 — 仅在用户浏览器内解密使用
 *   2. 主密码加密存储 — 使用 AES-GCM 加密后存入 localStorage
 *   3. 会话超时自动清除 — 可配置 TTL，到期自动擦除
 *   4. 物理安全隔离 — 加密密钥仅存在于内存中，永不持久化
 * 
 * 数据流:
 *   用户输入主密码 → PBKDF2 派生加密密钥 → AES-GCM 加密凭证
 *   → 密文存入 localStorage → 内存中的密钥在会话结束后销毁
 * 
 * @module credential-vault
 */

const STORAGE_KEY = 'phantom-fs:vault';
const SALT_KEY = 'phantom-fs:vault-salt';
const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 小时

/**
 * 凭证保险箱
 * 
 * 管理多个存储后端的 API 凭证，所有凭证在存储前均经过 AES-GCM 加密。
 * 主密码仅用于派生加密密钥，不直接用于加密凭证。
 * 
 * @class CredentialVault
 */
class CredentialVault {
    /**
     * @param {Object} [options]
     * @param {number} [options.ttl=DEFAULT_TTL] - 会话超时时间 (ms)
     * @param {string} [options.storageKey] - localStorage 键名
     */
    constructor(options = {}) {
        this._ttl = options.ttl || DEFAULT_TTL;
        this._storageKey = options.storageKey || STORAGE_KEY;
        this._saltKey = options.saltKey || SALT_KEY;

        /** @private 内存中的加密密钥，永不持久化 */
        this._encryptionKey = null;
        /** @private 会话开始时间戳 */
        this._sessionStart = 0;
        /** @private 凭证缓存 */
        this._cache = new Map();
    }

    /**
     * 解锁保险箱
     * 
     * 使用主密码派生 AES-GCM 加密密钥。
     * 如果 localStorage 中已有加密数据，使用此密钥解密加载。
     * 
     * @param {string} masterPassword - 主密码
     * @returns {Promise<boolean>} 是否成功解锁
     */
    async unlock(masterPassword) {
        try {
            // 获取或生成 salt
            let salt = this._loadSalt();
            if (!salt) {
                salt = crypto.getRandomValues(new Uint8Array(16));
                this._saveSalt(salt);
            }

            // 使用 PBKDF2 派生加密密钥
            const keyMaterial = await crypto.subtle.importKey(
                'raw',
                new TextEncoder().encode(masterPassword),
                'PBKDF2',
                false,
                ['deriveKey']
            );

            this._encryptionKey = await crypto.subtle.deriveKey(
                {
                    name: 'PBKDF2',
                    salt,
                    iterations: 600000,
                    hash: 'SHA-256'
                },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );

            this._sessionStart = Date.now();

            // 尝试加载已有凭证
            await this._loadFromStorage();

            return true;
        } catch (e) {
            this._encryptionKey = null;
            console.error('CredentialVault: 解锁失败', e);
            return false;
        }
    }

    /**
     * 锁定保险箱（清除内存中的密钥和缓存）
     */
    lock() {
        this._encryptionKey = null;
        this._sessionStart = 0;
        this._cache.clear();
    }

    /**
     * 检查保险箱是否已解锁
     * @returns {boolean}
     */
    isUnlocked() {
        return this._encryptionKey !== null && !this._isExpired();
    }

    /**
     * 检查会话是否过期
     * @private
     */
    _isExpired() {
        return this._sessionStart > 0 && (Date.now() - this._sessionStart) > this._ttl;
    }

    /**
     * 存储凭证
     * 
     * @param {string} providerId - Provider 标识 (如 's3:my-bucket')
     * @param {Object} credentials - 凭证对象
     * @param {string} credentials.accessKeyId - Access Key
     * @param {string} credentials.secretAccessKey - Secret Key
     * @param {string} [credentials.endpoint] - 端点 URL
     * @param {string} [credentials.bucket] - 存储桶
     * @param {string} [credentials.region] - 区域
     * @param {string} [credentials.username] - 用户名 (WebDAV)
     * @param {string} [credentials.password] - 密码 (WebDAV)
     * @returns {Promise<void>}
     */
    async setCredentials(providerId, credentials) {
        if (!this.isUnlocked()) {
            throw new Error('CredentialVault: 保险箱未解锁');
        }

        this._cache.set(providerId, { ...credentials });
        await this._saveToStorage();
    }

    /**
     * 获取凭证
     * 
     * @param {string} providerId - Provider 标识
     * @returns {Object|null} 凭证对象或 null
     */
    getCredentials(providerId) {
        if (!this.isUnlocked()) {
            return null;
        }
        return this._cache.get(providerId) || null;
    }

    /**
     * 删除凭证
     * 
     * @param {string} providerId - Provider 标识
     * @returns {Promise<void>}
     */
    async removeCredentials(providerId) {
        this._cache.delete(providerId);
        await this._saveToStorage();
    }

    /**
     * 获取所有已存储的 Provider ID 列表
     * @returns {string[]}
     */
    listProviders() {
        return Array.from(this._cache.keys());
    }

    /**
     * 清除所有凭证
     * @returns {Promise<void>}
     */
    async clearAll() {
        this._cache.clear();
        localStorage.removeItem(this._storageKey);
    }

    /**
     * 将凭证加密后存入 localStorage
     * @private
     */
    async _saveToStorage() {
        if (!this._encryptionKey) return;

        try {
            // 序列化凭证数据
            const data = JSON.stringify(Array.from(this._cache.entries()));
            const plaintext = new TextEncoder().encode(data);

            // 生成随机 IV
            const iv = crypto.getRandomValues(new Uint8Array(12));

            // AES-GCM 加密
            const ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                this._encryptionKey,
                plaintext
            );

            // 存储: IV + 密文
            const combined = new Uint8Array(iv.length + ciphertext.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(ciphertext), iv.length);

            localStorage.setItem(this._storageKey, 
                btoa(String.fromCharCode(...combined)));
        } catch (e) {
            console.error('CredentialVault: 保存失败', e);
        }
    }

    /**
     * 从 localStorage 加载并解密凭证
     * @private
     */
    async _loadFromStorage() {
        if (!this._encryptionKey) return;

        const stored = localStorage.getItem(this._storageKey);
        if (!stored) return;

        try {
            // 解码
            const combined = new Uint8Array(
                atob(stored).split('').map(c => c.charCodeAt(0))
            );

            // 分离 IV 和密文
            const iv = combined.slice(0, 12);
            const ciphertext = combined.slice(12);

            // AES-GCM 解密
            const plaintext = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                this._encryptionKey,
                ciphertext
            );

            // 反序列化
            const data = JSON.parse(new TextDecoder().decode(plaintext));
            this._cache = new Map(data);
        } catch (e) {
            // 解密失败 = 密码错误或数据损坏
            console.warn('CredentialVault: 加载凭证失败，密码可能已变更');
            this._cache.clear();
        }
    }

    /**
     * 加载 salt
     * @private
     */
    _loadSalt() {
        const stored = localStorage.getItem(this._saltKey);
        if (!stored) return null;
        return new Uint8Array(atob(stored).split('').map(c => c.charCodeAt(0)));
    }

    /**
     * 保存 salt
     * @private
     */
    _saveSalt(salt) {
        localStorage.setItem(this._saltKey, 
            btoa(String.fromCharCode(...salt)));
    }

    /**
     * 获取会话剩余时间 (秒)
     * @returns {number} 剩余秒数，0 表示已过期
     */
    getRemainingTime() {
        if (!this._sessionStart) return 0;
        const remaining = this._ttl - (Date.now() - this._sessionStart);
        return Math.max(0, Math.floor(remaining / 1000));
    }
}

export { CredentialVault };
