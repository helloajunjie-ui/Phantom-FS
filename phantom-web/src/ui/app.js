'use strict';

/**
 * Phantom-FS / V13 BYOS 主应用逻辑
 * ===================================
 * 单页应用控制器，管理 UI 状态与用户交互
 * 集成 BYOS Provider 矩阵和 CredentialVault
 *
 * @module app
 */

import { encryptFile, decryptFile, streamChunk, PhantomFSError } from '../core/phantom-cipher.js';
import { verifyPassword } from '../core/key-derivation.js';
import { serializeManifest, exportBinaryManifest, importBinaryManifest, parseManifestAuto, PTM_EXTENSION } from '../core/manifest.js';
import {
    MemoryProvider, HTTPProvider, S3Provider, WebDAVProvider,
    FileSystemProvider, LocalFileProvider, ProviderType, createProvider,
    toChunkId, parseChunkId
} from '../storage/cloud-store.js';
import { CredentialVault } from '../storage/credential-vault.js';
import { QRCodeEncoder } from '../storage/qr-code.js';
import { packPhantom, unpackPhantom, isPhantomPack } from '../storage/phantom-pack.js';

/**
 * Phantom-FS 主应用类
 *
 * @class PhantomApp
 */
class PhantomApp {
    constructor() {
        /** @private Provider 实例 */
        this._store = new MemoryProvider();
        /** @private 凭证保险箱 */
        this._vault = new CredentialVault({ ttl: 24 * 60 * 60 * 1000 });
        /** @private */
        this._qrEncoder = new QRCodeEncoder();
        /** @private */
        this._currentFile = null;
        /** @private */
        this._currentManifest = null;
        /** @private */
        this._currentFileId = null;
        /** @private */
        this._settingsOpen = false;
        /** @private 当前 Provider 配置 */
        this._providerConfig = { type: ProviderType.MEMORY };
        
        this._init();
    }

    /**
     * 初始化应用
     * @private
     */
    _init() {
        this._cacheDOM();
        this._bindEvents();
    }

    /**
     * 缓存 DOM 引用
     * @private
     */
    _cacheDOM() {
        this._els = {
            // 加密区域
            encryptSection: document.getElementById('encrypt-section'),
            dropZone: document.getElementById('drop-zone'),
            fileInput: document.getElementById('file-input'),
            fileInfo: document.getElementById('file-info'),
            encryptPassword: document.getElementById('encrypt-password'),
            encryptBtn: document.getElementById('encrypt-btn'),
            encryptProgress: document.getElementById('encrypt-progress'),
            
            // 解密区域
            decryptSection: document.getElementById('decrypt-section'),
            scanZone: document.getElementById('scan-zone'),
            manifestInput: document.getElementById('manifest-input'),
            decryptPassword: document.getElementById('decrypt-password'),
            decryptBtn: document.getElementById('decrypt-btn'),
            decryptProgress: document.getElementById('decrypt-progress'),
            
            // 结果展示
            resultSection: document.getElementById('result-section'),
            qrImage: document.getElementById('qr-image'),
            manifestViewer: document.getElementById('manifest-viewer'),
            downloadBtn: document.getElementById('download-btn'),
            emailBtn: document.getElementById('email-btn'),
            newFileBtn: document.getElementById('new-file-btn'),

            // 邮箱弹窗
            emailModal: document.getElementById('email-modal'),
            emailRecipient: document.getElementById('email-recipient'),
            emailNote: document.getElementById('email-note'),
            emailStatus: document.getElementById('email-status'),
            emailSendBtn: document.getElementById('email-send-btn'),
            emailCancelBtn: document.getElementById('email-cancel-btn'),
            
            // 错误提示
            errorContainer: document.getElementById('error-container'),

            // 设置面板
            settingsToggle: document.getElementById('settings-toggle'),
            settingsBody: document.getElementById('settings-body'),

            // ── BYOS Provider 配置 ──
            providerPanel: document.getElementById('provider-panel'),
            providerSelect: document.getElementById('provider-select'),
            providerConfig: document.getElementById('provider-config'),
            providerFields: document.getElementById('provider-fields'),
            providerSaveBtn: document.getElementById('provider-save-btn'),
            providerStatus: document.getElementById('provider-status'),

            // ── Credential Vault ──
            vaultPanel: document.getElementById('vault-panel'),
            vaultPassword: document.getElementById('vault-password'),
            vaultUnlockBtn: document.getElementById('vault-unlock-btn'),
            vaultLockBtn: document.getElementById('vault-lock-btn'),
            vaultStatus: document.getElementById('vault-status'),
            vaultTimer: document.getElementById('vault-timer'),

            // ── 交互元素 ──
            fileInfoRemove: document.getElementById('file-info-remove'),
            encryptPasswordToggle: document.getElementById('encrypt-password-toggle'),
            decryptPasswordToggle: document.getElementById('decrypt-password-toggle'),
            saveQrBtn: document.getElementById('save-qr-btn')
        };
    }

    /**
     * 绑定事件
     * @private
     */
    _bindEvents() {
        // 设置面板折叠
        this._els.settingsToggle.addEventListener('click', () => {
            this._settingsOpen = !this._settingsOpen;
            this._els.settingsToggle.classList.toggle('open', this._settingsOpen);
            this._els.settingsBody.classList.toggle('open', this._settingsOpen);
        });

        // 文件拖拽
        this._els.dropZone.addEventListener('click', () => this._els.fileInput.click());
        this._els.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this._els.dropZone.classList.add('drag-over');
        });
        this._els.dropZone.addEventListener('dragleave', () => {
            this._els.dropZone.classList.remove('drag-over');
        });
        this._els.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this._els.dropZone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file) this._selectFile(file);
        });
        this._els.fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) this._selectFile(file);
        });

        // 加密
        this._els.encryptBtn.addEventListener('click', () => this._handleEncrypt());
        this._els.encryptPassword.addEventListener('input', () => this._updatePasswordStrength('encrypt'));

        // 解密
        this._els.scanZone.addEventListener('click', () => this._els.manifestInput.click());
        this._els.manifestInput.addEventListener('change', (e) => this._handleManifestUpload(e));
        this._els.decryptBtn.addEventListener('click', () => this._handleDecrypt());
        this._els.decryptPassword.addEventListener('input', () => this._updatePasswordStrength('decrypt'));

        // 结果操作
        this._els.downloadBtn.addEventListener('click', () => this._downloadManifest());
        this._els.emailBtn.addEventListener('click', () => this._openEmailModal());
        this._els.newFileBtn.addEventListener('click', () => this._reset());

        // 邮箱弹窗
        this._els.emailSendBtn.addEventListener('click', () => this._handleEmailSend());
        this._els.emailCancelBtn.addEventListener('click', () => this._closeEmailModal());
        this._els.emailModal.addEventListener('click', (e) => {
            if (e.target === this._els.emailModal) this._closeEmailModal();
        });
        this._els.emailRecipient.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._handleEmailSend();
        });

        // ── BYOS Provider 配置 ──
        this._els.providerSelect.addEventListener('change', () => this._onProviderChange());
        this._els.providerSaveBtn.addEventListener('click', () => this._onProviderSave());

        // ── Credential Vault ──
        this._els.vaultUnlockBtn.addEventListener('click', () => this._onVaultUnlock());
        this._els.vaultLockBtn.addEventListener('click', () => this._onVaultLock());

        // ── 文件移除按钮 ──
        if (this._els.fileInfoRemove) {
            this._els.fileInfoRemove.addEventListener('click', () => {
                this._els.fileInput.value = '';
                this._els.fileInfo.classList.add('hidden');
                this._els.encryptBtn.disabled = true;
            });
        }

        // 密码可见切换（加密）
        if (this._els.encryptPasswordToggle) {
            this._els.encryptPasswordToggle.addEventListener('click', () => {
                const input = this._els.encryptPassword;
                input.type = input.type === 'password' ? 'text' : 'password';
            });
        }

        // 密码可见切换（解密）
        if (this._els.decryptPasswordToggle) {
            this._els.decryptPasswordToggle.addEventListener('click', () => {
                const input = this._els.decryptPassword;
                input.type = input.type === 'password' ? 'text' : 'password';
            });
        }

        // 保存 QR Code
        if (this._els.saveQrBtn) {
            this._els.saveQrBtn.addEventListener('click', () => {
                const img = this._els.qrImage;
                if (img && img.src) {
                    const a = document.createElement('a');
                    a.href = img.src;
                    a.download = 'phantom-fs-wallet.png';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                }
            });
        }
    }

    /**
     * 选择文件
     * @private
     * @param {File} file
     */
    _selectFile(file) {
        this._currentFile = file;
        
        this._els.fileInfo.classList.remove('hidden');
        this._els.fileInfo.querySelector('.file-info-name').textContent = file.name;
        this._els.fileInfo.querySelector('.file-info-size').textContent = this._formatSize(file.size);
        
        this._els.encryptBtn.disabled = false;
        this._clearError();
    }

    /**
     * 处理加密
     * @private
     */
    async _handleEncrypt() {
        const password = this._els.encryptPassword.value;
        
        if (!this._currentFile) {
            this._showError('请先选择要加密的文件');
            return;
        }
        
        if (!password || password.length < 4) {
            this._showError('密码长度至少 4 位');
            return;
        }

        this._setLoading(true, 'encrypt');
        this._clearError();

        try {
            const result = await encryptFile(this._currentFile, password, {
                storage: this._store,
                onProgress: (progress) => {
                    this._updateProgress('encrypt', progress);
                }
            });

            this._currentManifest = result.manifest;
            this._currentFileId = result.fileId;

            // 加密完成后自动切换到解密模式
            this._els.encryptSection.classList.add('hidden');
            this._els.decryptSection.classList.remove('hidden');

            // 显示结果
            this._showResult(result);
            
        } catch (error) {
            this._showError(this._formatError(error));
        } finally {
            this._setLoading(false, 'encrypt');
        }
    }

    /**
     * 处理 Manifest 上传（解密模式）
     * 支持 .ptm 二进制格式和 .json 文本格式
     * @private
     */
    async _handleManifestUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const buffer = await file.arrayBuffer();

            // 检测是否为 .phantom 打包文件（邮箱附件）
            if (isPhantomPack(buffer)) {
                const packed = unpackPhantom(buffer);
                // 从打包文件中提取 .ptm 数据
                this._currentManifest = importBinaryManifest(packed.manifest.buffer);
                // 从第一个 chunkId 中提取 fileId（格式: fileId/0000000X）
                const firstChunkId = packed.chunks.keys().next().value;
                if (firstChunkId) {
                    const { fileId } = parseChunkId(firstChunkId);
                    this._currentFileId = fileId;
                }
                // 将分片写入当前 Provider
                for (const [chunkId, data] of packed.chunks) {
                    await this._store.putChunk(chunkId, data.buffer);
                }
                this._els.scanZone.querySelector('.scan-zone-text').textContent =
                    `已加载打包文件: ${this._currentManifest.fileName || '未命名'} (${this._formatSize(this._currentManifest.fileSize)})`;
            } else if (file.name.endsWith(PTM_EXTENSION) || file.type === 'application/octet-stream') {
                // .ptm 二进制图纸
                this._currentManifest = importBinaryManifest(buffer);
                this._els.scanZone.querySelector('.scan-zone-text').textContent =
                    `已加载图纸: ${this._currentManifest.fileName || '未命名'} (${this._formatSize(this._currentManifest.fileSize)})`;
            } else {
                // JSON 格式
                const text = await file.text();
                this._currentManifest = parseManifestAuto(text);
                this._els.scanZone.querySelector('.scan-zone-text').textContent =
                    `已加载图纸: ${this._currentManifest.fileName || '未命名'} (${this._formatSize(this._currentManifest.fileSize)})`;
            }

            this._els.decryptBtn.disabled = false;
            this._clearError();
        } catch (error) {
            this._showError('文件格式无效: ' + (error.message || ''));
        }
    }

    /**
     * 处理解密
     * @private
     */
    async _handleDecrypt() {
        const password = this._els.decryptPassword.value;
        
        if (!this._currentManifest) {
            this._showError('请先上传 Manifest 文件');
            return;
        }
        
        if (!password) {
            this._showError('请输入密码');
            return;
        }

        // 快速校验密码
        try {
            const isValid = await verifyPassword(
                password,
                new Uint8Array(this._currentManifest.salt),
                new Uint8Array(this._currentManifest.fingerprint)
            );
            
            if (!isValid) {
                this._showError('密码错误');
                return;
            }
        } catch (error) {
            this._showError('密码校验失败');
            return;
        }

        this._setLoading(true, 'decrypt');
        this._clearError();

        try {
            const blob = await decryptFile(
                this._currentManifest,
                password,
                this._currentFileId || 'default',
                {
                    storage: this._store,
                    onProgress: (progress) => {
                        this._updateProgress('decrypt', progress);
                    }
                }
            );

            // 触发下载
            this._downloadBlob(blob, this._currentManifest.fileName || 'decrypted_file');
            
        } catch (error) {
            this._showError(this._formatError(error));
        } finally {
            this._setLoading(false, 'decrypt');
        }
    }

    /**
     * 显示加密结果
     * @private
     */
    _showResult(result) {
        this._els.resultSection.classList.remove('hidden');
        
        // 生成 QR Code（编码二进制 .ptm 数据）
        this._qrEncoder.encode(result.manifest).then(dataUrl => {
            this._els.qrImage.src = dataUrl;
        });
        
        // 显示 Manifest 信息（二进制体积对比）
        const ptmBuffer = exportBinaryManifest(result.manifest);
        const jsonStr = serializeManifest(result.manifest);
        this._els.manifestViewer.textContent =
            `// Phantom-FS V12.1 二进制图纸 (.ptm)\n` +
            `// 文件: ${result.manifest.fileName}\n` +
            `// 大小: ${this._formatSize(result.manifest.fileSize)}\n` +
            `// 分片: ${result.manifest.totalChunks} chunks\n` +
            `// ──────────────────────────────\n` +
            `// JSON 体积: ${new TextEncoder().encode(jsonStr).length} bytes\n` +
            `// 二进制体积: ${ptmBuffer.byteLength} bytes\n` +
            `// 压缩率: ${((1 - ptmBuffer.byteLength / new TextEncoder().encode(jsonStr).length) * 100).toFixed(1)}%\n` +
            `// ──────────────────────────────\n` +
            `// Salt: ${Array.from(result.manifest.salt).map(b => b.toString(16).padStart(2,'0')).join('')}\n` +
            `// BaseIV: ${Array.from(result.manifest.baseIV).map(b => b.toString(16).padStart(2,'0')).join('')}\n` +
            `// Fingerprint: ${Array.from(result.manifest.fingerprint).map(b => b.toString(16).padStart(2,'0')).join('')}`;
        
        // 滚动到结果区域
        this._els.resultSection.scrollIntoView({ behavior: 'smooth' });
    }

    /**
     * 下载 Manifest（二进制 .ptm 格式）
     * @private
     */
    _downloadManifest() {
        if (!this._currentManifest) return;
        
        const ptmBuffer = exportBinaryManifest(this._currentManifest);
        const blob = new Blob([ptmBuffer], { type: 'application/octet-stream' });
        const baseName = this._currentManifest.fileName.replace(/\.[^/.]+$/, '');
        this._downloadBlob(blob, `${baseName}${PTM_EXTENSION}`);
    }

    /**
     * 下载 Blob
     * @private
     */
    _downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * 更新进度
     * @private
     */
    _updateProgress(type, progress) {
        const container = type === 'encrypt' 
            ? this._els.encryptProgress 
            : this._els.decryptProgress;
        
        const percent = Math.round((progress.current / progress.total) * 100);
        
        container.querySelector('.progress-percent').textContent = `${percent}%`;
        container.querySelector('.progress-bar-fill').style.width = `${percent}%`;
        container.querySelector('.progress-status').textContent = 
            `处理分片 ${progress.current}/${progress.total}`;
    }

    /**
     * 设置加载状态
     * @private
     */
    _setLoading(loading, type) {
        const btn = type === 'encrypt' ? this._els.encryptBtn : this._els.decryptBtn;
        const progress = type === 'encrypt' 
            ? this._els.encryptProgress 
            : this._els.decryptProgress;
        
        btn.disabled = loading;
        btn.textContent = loading 
            ? '处理中...' 
            : type === 'encrypt' ? '加密并上传' : '解密并下载';
        
        progress.classList.toggle('hidden', !loading);
    }

    /**
     * 更新密码强度指示器
     * @private
     */
    _updatePasswordStrength(type) {
        const input = type === 'encrypt' 
            ? this._els.encryptPassword 
            : this._els.decryptPassword;
        
        const strength = this._calculatePasswordStrength(input.value);
        const bar = input.parentElement.querySelector('.password-strength-bar');
        
        if (bar) {
            bar.className = 'password-strength-bar ' + strength.level;
        }
    }

    /**
     * 计算密码强度
     * @private
     */
    _calculatePasswordStrength(password) {
        let score = 0;
        
        if (password.length >= 8) score++;
        if (password.length >= 12) score++;
        if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
        if (/\d/.test(password)) score++;
        if (/[^a-zA-Z0-9]/.test(password)) score++;
        
        const levels = ['', 'weak', 'medium', 'strong', 'strong', 'perfect'];
        return { level: levels[score] || '', score };
    }

    /**
     * 显示错误
     * @private
     */
    _showError(message) {
        this._els.errorContainer.classList.remove('hidden');
        this._els.errorContainer.querySelector('.error-message-text').textContent = message;
    }

    /**
     * 清除错误
     * @private
     */
    _clearError() {
        this._els.errorContainer.classList.add('hidden');
    }

    /**
     * 格式化错误信息
     * @private
     */
    _formatError(error) {
        if (error instanceof PhantomFSError) {
            const messages = {
                'WRONG_PASSWORD': '密码错误',
                'TAMPERED_DATA': '数据完整性校验失败，文件可能已被篡改',
                'CHUNK_OVERFLOW': '文件过大，超出系统安全边界',
                'UPLOAD_FAILED': '上传失败，请检查网络连接',
                'DOWNLOAD_FAILED': '下载失败，请检查网络连接',
                'INVALID_MANIFEST': 'Manifest 文件格式无效',
                'VERSION_MISMATCH': 'Manifest 版本不兼容',
                'CRYPTO_NOT_SUPPORTED': '当前浏览器不支持 Web Crypto API'
            };
            return messages[error.code] || error.message;
        }
        return error.message || '未知错误';
    }

    /**
     * 格式化文件大小
     * @private
     */
    _formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }

    /**
     * 重置应用状态
     * @private
     */
    _reset() {
        this._currentFile = null;
        this._currentManifest = null;
        this._currentFileId = null;
        
        this._els.fileInfo.classList.add('hidden');
        this._els.resultSection.classList.add('hidden');
        this._els.encryptSection.classList.remove('hidden');
        this._els.decryptSection.classList.add('hidden');
        this._els.encryptPassword.value = '';
        this._els.decryptPassword.value = '';
        this._els.encryptBtn.disabled = true;
        this._els.decryptBtn.disabled = true;
        this._els.fileInput.value = '';
        this._els.manifestInput.value = '';
        
        this._els.scanZone.querySelector('.scan-zone-text').textContent = 
            '点击上传 .ptm 图纸文件';
        
        this._clearError();
        
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ──────────────────────────────────────────────
    //  BYOS Provider 配置
    // ──────────────────────────────────────────────

    /**
     * Provider 切换事件
     * @private
     */
    _onProviderChange() {
        const type = this._els.providerSelect.value;
        this._renderProviderConfig(type);
    }

    /**
     * 渲染 Provider 配置表单
     * @private
     * @param {string} type
     */
    _renderProviderConfig(type) {
        const container = this._els.providerFields;
        container.innerHTML = '';

        if (type === ProviderType.MEMORY || type === ProviderType.OPFS) {
            this._els.providerConfig.classList.add('hidden');
            return;
        }

        this._els.providerConfig.classList.remove('hidden');

        // 尝试从 Vault 加载已保存的凭证
        const providerId = `${type}:default`;
        const saved = this._vault.isUnlocked() ? this._vault.getCredentials(providerId) : null;

        const fields = this._getProviderFields(type, saved);
        fields.forEach(f => {
            const group = document.createElement('div');
            group.className = 'form-group';
            group.innerHTML = `
                <label class="form-label">${f.label}</label>
                <input type="${f.type || 'text'}" class="form-input provider-field"
                       data-key="${f.key}" placeholder="${f.placeholder || ''}"
                       value="${f.value || ''}">
            `;
            container.appendChild(group);
        });
    }

    /**
     * 获取 Provider 配置字段定义
     * @private
     */
    _getProviderFields(type, saved) {
        const v = (key, fallback) => saved && saved[key] ? saved[key] : (fallback || '');

        switch (type) {
            case ProviderType.S3:
                return [
                    { key: 'endpoint', label: 'S3 Endpoint URL', placeholder: 'https://s3.amazonaws.com', value: v('endpoint') },
                    { key: 'bucket', label: 'Bucket 名称', placeholder: 'my-bucket', value: v('bucket') },
                    { key: 'presignEndpoint', label: 'Presign API Endpoint', placeholder: 'https://your-api.com/presign', value: v('presignEndpoint') },
                    { key: 'authToken', label: 'Auth Token (optional)', type: 'password', placeholder: 'Bearer ...', value: v('authToken') }
                ];
            case ProviderType.WEBDAV:
                return [
                    { key: 'baseURL', label: 'WebDAV Root URL', placeholder: 'https://nextcloud.example.com/remote.php/dav/files/user', value: v('baseURL') },
                    { key: 'username', label: 'Username', placeholder: 'user@example.com', value: v('username') },
                    { key: 'password', label: 'Password / App Password', type: 'password', placeholder: '...', value: v('password') }
                ];
            case ProviderType.HTTP:
                return [
                    { key: 'baseURL', label: 'Base URL', placeholder: 'https://storage.example.com/data', value: v('baseURL') },
                    { key: 'authToken', label: 'Auth Token (optional)', type: 'password', placeholder: 'Bearer ...', value: v('authToken') }
                ];
            case ProviderType.LOCAL:
                return [
                    { key: 'dirName', label: 'Storage Directory', placeholder: '.phantom-fs', value: v('dirName', '.phantom-fs') }
                ];
            default:
                return [];
        }
    }

    /**
     * 保存 Provider 配置
     * @private
     */
    async _onProviderSave() {
        const type = this._els.providerSelect.value;
        const fields = this._els.providerFields.querySelectorAll('.provider-field');
        const config = { type };

        fields.forEach(f => {
            config[f.dataset.key] = f.value;
        });

        try {
            // 为 S3 构建 getPresignedURL 函数
            if (type === ProviderType.S3 && config.presignEndpoint) {
                const endpoint = config.presignEndpoint;
                const token = config.authToken || '';
                config.getPresignedURL = async (method, key) => {
                    const url = `${endpoint}?method=${method}&key=${encodeURIComponent(key)}`;
                    const headers = { 'Content-Type': 'application/json' };
                    if (token) headers['Authorization'] = `Bearer ${token}`;
                    const res = await fetch(url, { headers });
                    if (!res.ok) throw new Error(`Presign API 返回 ${res.status}`);
                    const data = await res.json();
                    return data.url || data.presignedUrl || data;
                };
            }

            // 创建 Provider 实例
            this._store = createProvider(type, config);
            this._providerConfig = config;

            // 如果 Vault 已解锁，保存凭证
            if (this._vault.isUnlocked()) {
                const providerId = `${type}:default`;
                const credentials = {};
                fields.forEach(f => {
                    if (f.value) credentials[f.dataset.key] = f.value;
                });
                await this._vault.setCredentials(providerId, credentials);
            }

            this._els.providerStatus.textContent = `已连接: ${type.toUpperCase()}`;
            this._els.providerStatus.className = 'provider-status connected';
            
            // 测试连接
            this._testProviderConnection(type);
        } catch (e) {
            this._els.providerStatus.textContent = `配置失败: ${e.message}`;
            this._els.providerStatus.className = 'provider-status error';
        }
    }

    /**
     * 测试 Provider 连接
     * @private
     */
    async _testProviderConnection(type) {
        try {
            const testId = `_test_${Date.now().toString(36)}`;
            const testData = new TextEncoder().encode('phantom-fs-connectivity-test').buffer;
            await this._store.putChunk(`${testId}/00000000`, testData);
            // S3Provider.deleteFile 需要服务端支持，跳过删除测试
            if (type !== ProviderType.S3) {
                await this._store.deleteFile(testId);
            }
            
            this._els.providerStatus.textContent = `已连接: ${type.toUpperCase()} (连通性验证通过)`;
        } catch (e) {
            console.warn('Provider 连通性测试失败 (不影响使用):', e.message);
        }
    }

    // ──────────────────────────────────────────────
    //  Credential Vault
    // ──────────────────────────────────────────────

    /**
     * 解锁凭证保险箱
     * @private
     */
    async _onVaultUnlock() {
        const password = this._els.vaultPassword.value;
        if (!password || password.length < 4) {
            this._els.vaultStatus.textContent = '主密码至少 4 位';
            return;
        }

        this._els.vaultUnlockBtn.disabled = true;
        this._els.vaultUnlockBtn.textContent = '解锁中...';

        try {
            const ok = await this._vault.unlock(password);
            if (ok) {
                this._els.vaultStatus.textContent = '保险箱已解锁';
                this._els.vaultStatus.className = 'vault-status unlocked';
                this._els.vaultPanel.classList.add('unlocked');
                this._els.vaultPassword.value = '';
                this._startVaultTimer();

                // 重新加载当前 Provider 配置
                this._onProviderChange();
            } else {
                this._els.vaultStatus.textContent = '解锁失败 (密码错误?)';
                this._els.vaultStatus.className = 'vault-status error';
            }
        } catch (e) {
            this._els.vaultStatus.textContent = `解锁失败: ${e.message}`;
            this._els.vaultStatus.className = 'vault-status error';
        } finally {
            this._els.vaultUnlockBtn.disabled = false;
            this._els.vaultUnlockBtn.textContent = '解锁';
        }
    }

    /**
     * 锁定凭证保险箱
     * @private
     */
    _onVaultLock() {
        this._vault.lock();
        this._els.vaultStatus.textContent = '保险箱已锁定';
        this._els.vaultStatus.className = 'vault-status locked';
        this._els.vaultPanel.classList.remove('unlocked');
        this._els.vaultTimer.textContent = '';

        // 清除缓存的凭证配置
        this._onProviderChange();
    }

    /**
     * 启动会话计时器
     * @private
     */
    _startVaultTimer() {
        if (this._vaultTimerInterval) {
            clearInterval(this._vaultTimerInterval);
        }

        this._vaultTimerInterval = setInterval(() => {
            const remaining = this._vault.getRemainingTime();
            if (remaining <= 0) {
                this._onVaultLock();
                clearInterval(this._vaultTimerInterval);
                this._vaultTimerInterval = null;
                return;
            }

            const hours = Math.floor(remaining / 3600);
            const mins = Math.floor((remaining % 3600) / 60);
            this._els.vaultTimer.textContent = `${hours}h ${mins}m`;
        }, 10000);
    }

    // ──────────────────────────────────────────────
    // 邮箱发送
    // ──────────────────────────────────────────────

    /**
     * 打开邮箱发送弹窗
     * @private
     */
    _openEmailModal() {
        this._els.emailRecipient.value = '';
        this._els.emailNote.value = '';
        this._els.emailStatus.textContent = '';
        this._els.emailStatus.className = 'email-status';
        this._els.emailModal.classList.remove('hidden');
        this._els.emailRecipient.focus();
    }

    /**
     * 关闭邮箱发送弹窗
     * @private
     */
    _closeEmailModal() {
        this._els.emailModal.classList.add('hidden');
    }

    /**
     * 打包并通过邮箱发送 .phantom 文件
     * @private
     */
    async _handleEmailSend() {
        const recipient = this._els.emailRecipient.value.trim();
        if (!recipient || !recipient.includes('@')) {
            this._els.emailStatus.textContent = '请输入有效的邮箱地址';
            this._els.emailStatus.className = 'email-status error';
            return;
        }

        if (!this._currentManifest || !this._store) {
            this._els.emailStatus.textContent = '没有可发送的加密数据';
            this._els.emailStatus.className = 'email-status error';
            return;
        }

        this._els.emailSendBtn.disabled = true;
        this._els.emailStatus.textContent = '正在打包加密数据...';
        this._els.emailStatus.className = 'email-status';

        try {
            // 1. 导出 .ptm 二进制图纸
            const ptmBuffer = exportBinaryManifest(this._currentManifest);

            // 2. 从存储后端收集所有加密分片
            const fileId = this._currentFileId;
            const totalChunks = this._currentManifest.totalChunks;
            const chunks = new Map();

            this._els.emailStatus.textContent = `正在收集加密分片 (0/${totalChunks})...`;

            for (let i = 0; i < totalChunks; i++) {
                const chunkId = toChunkId(fileId, i);
                const data = await this._store.getChunk(chunkId);
                chunks.set(chunkId, new Uint8Array(data));
                this._els.emailStatus.textContent = `正在收集加密分片 (${i + 1}/${totalChunks})...`;
            }

            // 3. 打包为 .phantom 文件
            this._els.emailStatus.textContent = '正在打包...';
            const phantomBlob = packPhantom(ptmBuffer, chunks);

            // 4. 通过 EmailJS 发送
            this._els.emailStatus.textContent = '正在发送邮件...';
            await this._sendEmail(recipient, phantomBlob);

            this._els.emailStatus.textContent = '发送成功！收件人可从邮箱下载附件后拖入解密';
            this._els.emailStatus.className = 'email-status success';

            // 3秒后自动关闭
            setTimeout(() => this._closeEmailModal(), 3000);

        } catch (error) {
            this._els.emailStatus.textContent = `发送失败: ${error.message}`;
            this._els.emailStatus.className = 'email-status error';
        } finally {
            this._els.emailSendBtn.disabled = false;
        }
    }

    /**
     * 通过 EmailJS 发送邮件
     * @private
     * @param {string} recipient - 收件人邮箱
     * @param {Blob} attachment - .phantom 附件
     */
    async _sendEmail(recipient, attachment) {
        // 使用 EmailJS SDK（从 CDN 加载）
        if (typeof emailjs === 'undefined') {
            throw new Error('EmailJS 未加载。请确保已引入 emailjs SDK。');
        }

        // 将 Blob 转为 Base64
        const buffer = await attachment.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        const note = this._els.emailNote.value.trim();
        const baseName = this._currentManifest.fileName.replace(/\.[^/.]+$/, '');
        const subject = note ? `[Phantom-FS] ${note}` : `[Phantom-FS] ${baseName}`;

        // EmailJS 配置 — 用户需自行注册并替换
        // 注册地址: https://www.emailjs.com/
        const templateParams = {
            to_email: recipient,
            subject: subject,
            message: `Phantom-FS 加密文件\n\n` +
                     `文件: ${this._currentManifest.fileName}\n` +
                     `大小: ${this._formatSize(this._currentManifest.fileSize)}\n` +
                     `分片: ${this._currentManifest.totalChunks} chunks\n\n` +
                     `请下载附件后打开 Phantom-Web，拖入 .phantom 文件并输入密码解密。\n\n` +
                     `密码请通过其他安全渠道告知收件人。`,
            attachment_name: `${baseName}.phantom`,
            attachment_data: base64,
        };

        await emailjs.send(
            'default_service',  // EmailJS Service ID
            'template_phantom', // EmailJS Template ID
            templateParams
        );
    }
}

// 当 DOM 加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    new PhantomApp();
});
