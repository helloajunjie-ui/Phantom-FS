# 📡 Phantom-Web API 设计文档

> 版本: V12.1-Phantom (JS 前端) | 协议: Browser Web API

---

## 01. 设计原则

- **纯前端 API**：所有操作在浏览器端完成，无需后端服务
- **Promise-based**：所有异步操作返回 Promise
- **渐进增强**：核心功能不依赖任何第三方库
- **错误优先**：清晰的错误类型分层

---

## 02. 核心 API

### `PhantomFS.encrypt(file, password)`

加密文件并上传分片到云端。

```typescript
async function encrypt(
    file: File,
    password: string,
    options?: EncryptOptions
): Promise<EncryptResult>
```

**参数**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `file` | `File` | - | 用户选择的文件 |
| `password` | `string` | - | 加密密码 |
| `options.chunkSize` | `number` | `5242880` | 分片大小（字节） |
| `options.maxConcurrency` | `number` | `5` | 最大并发数 |
| `options.maxRetries` | `number` | `3` | 上传重试次数 |
| `options.onProgress` | `(progress: ProgressInfo) => void` | - | 进度回调 |
| `options.storage` | `CloudStore` | `defaultStore` | 存储后端 |

**返回值**：

```typescript
interface EncryptResult {
    manifest: Manifest;           // 加密图纸
    fileId: string;               // 文件标识
    errors: Error[];              // 上传失败记录
    duration: number;             // 加密耗时 (ms)
}
```

**使用示例**：

```javascript
const result = await PhantomFS.encrypt(file, password, {
    chunkSize: 5 * 1024 * 1024,
    maxConcurrency: 5,
    onProgress: ({ current, total, chunkIndex }) => {
        console.log(`加密进度: ${current}/${total}`);
    }
});

// 导出 Manifest 为 QR Code
const qrDataUrl = await PhantomFS.exportQRCode(result.manifest);
```

---

### `PhantomFS.decrypt(manifest, password, fileId)`

解密并重建原始文件。

```typescript
async function decrypt(
    manifest: Manifest | string | ArrayBuffer | Uint8Array,
    password: string,
    fileId: string,
    options?: DecryptOptions
): Promise<Blob>
```

**参数**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `manifest` | `Manifest \| string \| ArrayBuffer \| Uint8Array` | - | Manifest 对象、JSON 字符串或二进制 .ptm 数据 |
| `password` | `string` | - | 解密密码 |
| `fileId` | `string` | - | 文件标识 |
| `options.maxConcurrency` | `number` | `5` | 最大并发数 |
| `options.onProgress` | `(progress: ProgressInfo) => void` | - | 进度回调 |
| `options.storage` | `CloudStore` | `defaultStore` | 存储后端 |

**返回值**：

```typescript
Blob  // 解密后的原始文件 Blob
```

**使用示例**：

```javascript
// 从 QR Code 扫码获取 Manifest
const manifest = await PhantomFS.parseQRCode(qrImageData);

// 解密
const blob = await PhantomFS.decrypt(manifest, password, fileId, {
    onProgress: ({ current, total }) => {
        updateProgressBar(current / total);
    }
});

// 下载或预览
const url = URL.createObjectURL(blob);
```

---

### `PhantomFS.streamChunk(manifest, password, fileId, chunkIndex)`

流式解密单个分片（用于视频 Seek）。

```typescript
async function streamChunk(
    manifest: Manifest | string | ArrayBuffer | Uint8Array,
    password: string,
    fileId: string,
    chunkIndex: number
): Promise<ArrayBuffer>
```

**使用示例**：

```javascript
// 视频 Seek 到 30s 位置
const targetByte = 30 * 1024 * 1024; // 30MB
const chunkIndex = Math.floor(targetByte / chunkSize);

const decryptedChunk = await PhantomFS.streamChunk(
    manifest, password, fileId, chunkIndex
);

// 喂给视频播放器
const blob = new Blob([decryptedChunk], { type: 'video/mp4' });
const url = URL.createObjectURL(blob);
videoElement.src = url;
```

---

### `PhantomFS.verifyPassword(manifest, password)`

快速校验密码是否正确（无需解密数据）。

```typescript
async function verifyPassword(
    manifest: Manifest | string | ArrayBuffer | Uint8Array,
    password: string
): Promise<boolean>
```

**性能**：< 100ms（仅做密钥派生 + 指纹比对）

**使用示例**：

```javascript
const isValid = await PhantomFS.verifyPassword(manifest, password);
if (!isValid) {
    triggerGlitchEffect(); // UI 故障震动反馈
    return;
}
```

---

## 03. Manifest API

### 3.1 双模系统

Manifest 支持两种序列化模式：

| 模式 | 函数 | 用途 |
|------|------|------|
| **JSON** | `JSON.stringify` / `JSON.parse` | QR Code 兼容层、调试 |
| **Binary (.ptm)** | `exportBinaryManifest` / `importBinaryManifest` | 文件存储、传输（体积减少 5x） |

### 3.2 `PhantomFS.exportQRCode(manifest)`

将 Manifest 编码为 QR Code 图片。自动使用二进制 `.ptm` 格式编码。

```typescript
async function exportQRCode(
    manifest: Manifest | string
): Promise<string>  // Data URL of QR Code image
```

**QR Code 内容格式**：
```
PTM:{Base64 编码的 .ptm 二进制数据}
```

### 3.3 `PhantomFS.parseQRCode(imageData)`

从 QR Code 图片解析 Manifest。自动检测 `PTM:` 前缀（二进制）或纯 JSON。

```typescript
async function parseQRCode(
    imageData: string | HTMLImageElement | File
): Promise<Manifest>
```

### 3.4 `PhantomFS.exportBinaryManifest(manifest)`

将 Manifest 导出为二进制 `.ptm` 格式。

```typescript
function exportBinaryManifest(manifest: Manifest): ArrayBuffer
```

**二进制布局**（56 字节固定头 + 可变文件名）：

| 偏移 | 大小 | 字段 | 说明 |
|------|------|------|------|
| 0 | 16 | Salt | PBKDF2 Salt（原始 bytes） |
| 16 | 12 | BaseIV | AES-GCM 基础 IV（原始 bytes） |
| 28 | 16 | Fingerprint | 密钥指纹（原始 bytes） |
| 44 | 4 | ChunkSize | Uint32 LE |
| 48 | 4 | TotalChunks | Uint32 LE |
| 52 | 4 | FileSize | Uint32 LE |
| 56 | ? | FileName | UTF-8 编码，无终止符 |

### 3.5 `PhantomFS.importBinaryManifest(buffer)`

从二进制 `.ptm` 数据导入 Manifest。

```typescript
function importBinaryManifest(buffer: ArrayBuffer): Manifest
```

### 3.6 `PhantomFS.parseManifestAuto(data)`

自动检测并解析 Manifest（支持 JSON 字符串 / 二进制 `.ptm`）。

```typescript
function parseManifestAuto(data: string | ArrayBuffer | Uint8Array): Manifest
```

### 3.7 `PhantomFS.binaryManifestToBase64(buffer)`

将二进制 `.ptm` 转换为 Base64 字符串（用于 QR Code 嵌入）。

```typescript
function binaryManifestToBase64(buffer: ArrayBuffer): string
```

### 3.8 `PhantomFS.base64ToArrayBuffer(base64)`

将 Base64 字符串还原为 `ArrayBuffer`。

```typescript
function base64ToArrayBuffer(base64: string): ArrayBuffer
```

### 3.9 `PhantomFS.estimateManifestSize(manifest)`

估算 Manifest 在两种模式下的体积对比。

```typescript
function estimateManifestSize(manifest: Manifest): {
    json: number;       // JSON 模式体积（bytes）
    binary: number;     // 二进制 .ptm 模式体积（bytes）
    ratio: number;      // 压缩比（json / binary）
}
```

### 3.10 使用示例

```javascript
// 加密后导出二进制 .ptm 文件
const result = await PhantomFS.encrypt(file, password);
const ptmBuffer = PhantomFS.exportBinaryManifest(result.manifest);
const blob = new Blob([ptmBuffer], { type: 'application/octet-stream' });
downloadBlob(blob, 'document.ptm');

// 从 .ptm 文件导入
const file = await readFileAsArrayBuffer(ptmFile);
const manifest = PhantomFS.importBinaryManifest(file);

// QR Code 自动使用二进制编码
const qrDataUrl = await PhantomFS.exportQRCode(manifest);
// QR Code 内容: "PTM:AAAAEAAAAFgAAAAf..."

// 自动检测格式
const manifest1 = PhantomFS.parseManifestAuto(jsonString);    // JSON
const manifest2 = PhantomFS.parseManifestAuto(ptmArrayBuffer); // Binary
```

---

## 04. BYOS Provider API (V13)

### IStorageProvider 接口

所有存储后端必须实现此接口：

```typescript
interface IStorageProvider {
    putChunk(chunkId: string, data: ArrayBuffer): Promise<string>;
    getChunk(chunkId: string, range?: { start: number, end: number }): Promise<ArrayBuffer>;
    deleteFile(fileId: string): Promise<void>;
    getChunkURL(chunkId: string): string | null;
}
```

**chunkId 格式**: `{fileId}/{8位十六进制索引}` (如 `abc123/00000000`)

### Provider 工厂

```typescript
function createProvider(type: ProviderType, options?: object): IStorageProvider
```

| ProviderType | options 参数 | 说明 |
|-------------|-------------|------|
| `memory` | 无 | 内存存储，调试用 |
| `opfs` | 无 | 浏览器 OPFS 沙盒 |
| `local` | `{ dirName: string }` | 本地目录 |
| `s3` | `{ endpoint, bucket, presignEndpoint, authToken? }` | S3 兼容（需服务端 Presign API） |
| `webdav` | `{ baseURL, username, password }` | WebDAV |
| `http` | `{ baseURL, authToken? }` | HTTP Range |

### 使用示例

```javascript
import { createProvider, ProviderType } from '../storage/cloud-store.js';

// S3（需要服务端 Presign API）
const s3 = createProvider('s3', {
    endpoint: 'https://s3.amazonaws.com',
    bucket: 'my-bucket',
    presignEndpoint: 'https://your-api.com/presign',
    authToken: '...'
});

// WebDAV
const webdav = createProvider('webdav', {
    baseURL: 'https://nextcloud.example.com/remote.php/dav/files/user',
    username: 'user',
    password: 'app-password'
});

// OPFS (离线)
const opfs = createProvider('opfs');

// 传入加密引擎
const result = await encryptFile(file, password, {
    storage: s3,  // 或 webdav / opfs
    onProgress: (p) => console.log(p)
});
```

### CredentialVault API

```typescript
class CredentialVault {
    constructor(options?: { ttl?: number });
    
    // 解锁保险箱（PBKDF2 派生 AES-GCM 密钥）
    unlock(masterPassword: string): Promise<boolean>;
    
    // 锁定保险箱（清除内存密钥）
    lock(): void;
    
    // 检查是否已解锁
    isUnlocked(): boolean;
    
    // 存储凭证（AES-GCM 加密后写入 localStorage）
    setCredentials(providerId: string, credentials: object): Promise<void>;
    
    // 获取凭证
    getCredentials(providerId: string): object | null;
    
    // 删除凭证
    removeCredentials(providerId: string): Promise<void>;
    
    // 列出所有已存储的 Provider
    listProviders(): string[];
    
    // 清除所有凭证
    clearAll(): Promise<void>;
    
    // 获取会话剩余时间（秒）
    getRemainingTime(): number;
}
```

### 04.5 邮箱输出通道

加密完成后，将 Manifest + Chunks 打包为 `.phantom` 文件并通过 EmailJS 发送。

```typescript
// phantom-pack.js
function packPhantom(
    manifestData: Uint8Array,   // .ptm 二进制图纸
    chunks: Map<string, Uint8Array>  // chunkId → 加密数据
): Blob
```

**格式**：
```
┌──────────────────────────────────┐
│ Magic: "PHNT" (4 bytes)         │
│ Version: 0x01 (1 byte)          │
│ Manifest Length: Uint32 LE      │
│ Manifest Data (variable)        │
│ Chunk Count: Uint32 LE          │
│ For each chunk:                 │
│   ├─ Chunk ID Len: Uint16 LE    │
│   ├─ Chunk ID (UTF-8)           │
│   ├─ Chunk Data Len: Uint32 LE  │
│   └─ Chunk Data                 │
└──────────────────────────────────┘
```

**依赖**：[EmailJS](https://www.emailjs.com/) CDN（`@emailjs/browser@4`）

**配置**：在 `index.html` 中替换 `emailjs.init('YOUR_PUBLIC_KEY')` 为真实 Public Key。

---

## 05. 进度回调 API

```typescript
interface ProgressInfo {
    phase: 'encrypt' | 'decrypt' | 'upload' | 'download';
    current: number;          // 当前完成的分片数
    total: number;            // 总分片数
    chunkIndex: number;       // 当前处理的分片索引
    bytesProcessed: number;   // 已处理字节数
    bytesTotal: number;       // 总字节数
    speed: number;            // 当前速度 (bytes/s)
    eta: number;              // 预计剩余时间 (ms)
}
```

---

## 06. 错误类型

```typescript
class PhantomFSError extends Error {
    code: string;
    chunkIndex?: number;
    retryable: boolean;
}

// 预定义错误码
const ErrorCodes = {
    WRONG_PASSWORD: 'WRONG_PASSWORD',
    TAMPERED_DATA: 'TAMPERED_DATA',
    CHUNK_OVERFLOW: 'CHUNK_OVERFLOW',
    UPLOAD_FAILED: 'UPLOAD_FAILED',
    DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    INVALID_MANIFEST: 'INVALID_MANIFEST',
    VERSION_MISMATCH: 'VERSION_MISMATCH',
    CRYPTO_NOT_SUPPORTED: 'CRYPTO_NOT_SUPPORTED',
    USER_ABORTED: 'USER_ABORTED'
} as const;
```

---

## 07. 完整调用示例

### 加密并上传（二进制 .ptm 工作流）

```javascript
// 1. 用户选择文件
const fileInput = document.querySelector('input[type="file"]');
const file = fileInput.files[0];

// 2. 加密
try {
    const result = await PhantomFS.encrypt(file, userPassword, {
        onProgress: (p) => renderProgress(p),
        storage: myS3Store
    });
    
    // 3a. 生成 QR Code（自动使用二进制 .ptm 编码）
    const qrDataUrl = await PhantomFS.exportQRCode(result.manifest);
    document.querySelector('#qr-code').src = qrDataUrl;
    
    // 3b. 导出二进制 .ptm 文件（体积比 JSON 小 5 倍）
    const ptmBuffer = PhantomFS.exportBinaryManifest(result.manifest);
    const ptmBlob = new Blob([ptmBuffer], { type: 'application/octet-stream' });
    downloadBlob(ptmBlob, 'secret-file.ptm');
    
    // 查看体积对比
    const size = PhantomFS.estimateManifestSize(result.manifest);
    console.log(`JSON: ${size.json}B -> .ptm: ${size.binary}B (${size.ratio}x)`);
    
} catch (error) {
    if (error.code === 'CHUNK_OVERFLOW') {
        alert('文件过大，请选择小于 21.5PB 的文件');
    }
}
```

### 从 .ptm 文件解密

```javascript
// 1. 用户上传 .ptm 文件
const ptmFile = fileInput.files[0];
const buffer = await ptmFile.arrayBuffer();

// 2. 自动检测格式并解析
const manifest = PhantomFS.parseManifestAuto(buffer);

// 3. 校验密码
const isValid = await PhantomFS.verifyPassword(manifest, password);
if (!isValid) throw new Error('密码错误');

// 4. 解密
const blob = await PhantomFS.decrypt(manifest, password, fileId, {
    onProgress: ({ current, total }) => {
        updateProgressBar(current / total);
    }
});

// 5. 下载或预览
const url = URL.createObjectURL(blob);
```

### 从 QR Code 扫码解密

```javascript
// 1. 扫码获取 Manifest（自动识别 PTM: 前缀）
const manifest = await PhantomFS.parseQRCode(qrImage);

// 2. 校验密码
const isValid = await PhantomFS.verifyPassword(manifest, password);
if (!isValid) throw new Error('密码错误');

// 3. 解密
const blob = await PhantomFS.decrypt(manifest, password, fileId);
```

### 解密并播放视频（流式 Seek）

```javascript
// 1. 扫码或上传 .ptm 获取 Manifest
const manifest = PhantomFS.parseManifestAuto(ptmBuffer);

// 2. 校验密码
const isValid = await PhantomFS.verifyPassword(manifest, password);
if (!isValid) throw new Error('密码错误');

// 3. 流式播放（按需解密）
videoElement.addEventListener('seeked', async () => {
    const seekTime = videoElement.currentTime;
    const byteOffset = seekTime * videoInfo.bitrate / 8;
    const chunkIndex = Math.floor(byteOffset / manifest.chunkSize);
    
    const chunk = await PhantomFS.streamChunk(
        manifest, password, fileId, chunkIndex
    );
    
    // 更新视频源
    const blob = new Blob([chunk], { type: 'video/mp4' });
    videoElement.src = URL.createObjectURL(blob);
});
```

### 从 `.phantom` 邮箱附件解密

```javascript
// 1. 用户拖入 .phantom 文件
const buffer = await phantomFile.arrayBuffer();

// 2. 检测是否为 .phantom 打包格式
if (isPhantomPack(buffer)) {
    const packed = unpackPhantom(buffer);
    
    // 3. 解析 .ptm 图纸
    const manifest = importBinaryManifest(packed.manifest.buffer);
    
    // 4. 从第一个 chunkId 提取 fileId（关键！）
    const firstChunkId = packed.chunks.keys().next().value;
    const { fileId } = parseChunkId(firstChunkId);
    
    // 5. 将分片写入 Provider
    for (const [chunkId, data] of packed.chunks) {
        await provider.putChunk(chunkId, data.buffer);
    }
    
    // 6. 校验密码并解密
    const isValid = await verifyPassword(password, manifest.salt, manifest.fingerprint);
    if (!isValid) throw new Error('密码错误');
    
    const blob = await decryptFile(manifest, password, fileId, { storage: provider });
}
```

> ⚠️ **关键**：`.phantom` 打包时 chunkId 格式为 `fileId/0000000X`，解密时必须使用 `parseChunkId()` 从 chunkId 中提取原始 `fileId`，否则 `toChunkId('default', i)` 会生成不匹配的 key。
```
