# 🏗️ Phantom-Web 架构设计文档

> 版本: V12.1-Phantom (JS 前端) | 更新: 2026-07

---

## 01. 核心架构原则

### 奥卡姆剃刀
系统遵循极简主义，拒绝任何臃肿的 NPM 缝合怪，完全榨干 HTML5 原生底座能力。

### 三大物理边界（核心安全模型）

```
┌─────────────────────────────────────────────────────────────┐
│                    三大物理边界                               │
│                                                             │
│  ① Chunks（加密碎沙子）                                      │
│     → AES-256-GCM 加密后的二进制分片                          │
│     → 存储在云端，无 Manifest 则毫无意义                       │
│     → 物理隔离：云端无法解密                                  │
│                                                             │
│  ② Manifest（藏宝图）                                        │
│     → 包含 Salt / BaseIV / Fingerprint / 文件名              │
│     → 二进制 .ptm 格式，可嵌入 QR Code                       │
│     → 物理隔离：无 Manifest 则找不到碎片                       │
│                                                             │
│  ③ Password（唯一钥匙）                                      │
│     → 用户记忆中的密码字符串                                  │
│     → 物理隔离：仅存在于用户大脑                              │
│     → 无 Password 则无法派生密钥                              │
└─────────────────────────────────────────────────────────────┘
```

**核心定理**：三者缺一不可。攻破任意单一物理边界无法恢复原始数据。

### 三大设计支柱

| 支柱 | 原则 | 实现 |
|------|------|------|
| **分离主义** | Map & Key 剥离 | Manifest（藏宝图）与 Chunks（加密碎沙子）分离存储 |
| **零依赖引擎** | 仅调用底层 C++ 模块 | `window.crypto.subtle`，脱机/断网即可运行 |
| **哑管道存储** | 云端无状态 | 仅需支持标准 `HTTP/1.1 Range Request` |

---

## 02. 系统架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    用户浏览器 (Client)                     │
│                                                         │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  UI Layer     │    │     Phantom Cipher Engine     │   │
│  │  (app.js)     │───▶│                              │   │
│  │               │    │  ┌────────────────────────┐  │   │
│  │  - 文件选择    │    │  │  Key Derivation        │  │   │
│  │  - 拖拽上传    │    │  │  (PBKDF2 + Salt)       │  │   │
│  │  - 进度展示    │    │  └───────────┬────────────┘  │   │
│  │  - 视频播放    │    │              │               │   │
│  │  - QR 展示     │    │  ┌───────────▼────────────┐  │   │
│  └──────────────┘    │  │  Stream Encrypt/Decrypt  │  │   │
│                      │  │  (AES-GCM + AAD)         │  │   │
│                      │  └───────────┬────────────┘  │   │
│                      │              │               │   │
│                      │  ┌───────────▼────────────┐  │   │
│                      │  │  Manifest Builder       │  │   │
│                      │  │  (IV推导 / 指纹提取)    │  │   │
│                      │  └────────────────────────┘  │   │
│                      └──────────────────────────────┘   │
│                                                         │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  Storage      │    │     Concurrency Pool          │   │
│  │  Adapter      │◀───▶│  (maxConcurrency = 5)       │   │
│  │               │    │                              │   │
│  │  - HTTP Range │    │  - 自动重试                  │   │
│  │  - QR Code    │    │  - 静默熔断                  │   │
│  │  - Local Cache│    │  - 内存覆写                  │   │
│  └──────────────┘    └──────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────┘
                       │
                       │ HTTP Range Request
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   云端 (Dumb Pipe)                        │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Static File Server (S3 / CDN / Nginx)           │   │
│  │                                                  │   │
│  │  /chunks/                                       │   │
│  │    ├── {fileId}/00000000.chunk                   │   │
│  │    ├── {fileId}/00000001.chunk                   │   │
│  │    └── ...                                       │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 03. 数据流设计

### 3.1 加密上传流程

```
User selects file
       │
       ▼
┌──────────────────┐
│ 1. Key Derivation │  ← PBKDF2(password, salt, 600000 iterations)
│    + Fingerprint  │  ← SHA-256(key)[0:16]
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 2. File Slicing   │  ← File.slice(0, 5MB), File.slice(5MB, 10MB), ...
│    (5MB chunks)   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 3. Stream Encrypt │  ← AES-GCM with deterministic IV
│    + AAD Tagging  │  ← AAD = "chunk_{index}" (anti-replay)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 4. Upload Pool    │  ← max 5 concurrent uploads
│    (auto-retry)   │  ← silent circuit breaker
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 5. Build Manifest │  ← { version, fileName, chunkSize, salt, baseIV, fingerprint }
└────────┬─────────┘
         │
         ├──────────────────────────────┐
         ▼                              ▼
┌──────────────────┐        ┌──────────────────────────┐
│ 6a. Export .ptm   │        │ 6b. Export QR Code        │
│    Binary File    │        │    PTM:{Base64 encoded}   │
│    (56+ bytes)    │        │    → QR Code Image        │
└──────────────────┘        └──────────────────────────┘
```

### 3.2 解密播放流程（视频 Seek）

```
User drags progress bar to position X
       │
       ▼
┌──────────────────────────┐
│ Calculate chunk index     │  ← Math.floor(X / 5MB)
│ Calculate byte offset     │  ← X % 5MB
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│ HTTP Range Request        │  ← Range: bytes={start}-{end}
│ Fetch encrypted chunk     │
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│ Derive IV for chunk N     │  ← baseIV ^ chunkIndex
│ Decrypt with AAD          │  ← AAD = "chunk_{N}"
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│ Return decrypted blob     │  ← URL.createObjectURL(decrypted)
│ to video element          │
└──────────────────────────┘
```

---

## 04. 安全边界设计

### 4.1 密码学防线

| 防线 | 技术 | 说明 |
|------|------|------|
| 密钥派生 | PBKDF2 + Salt | 600,000 次迭代，暴力破解成本极高 |
| 数据加密 | AES-256-GCM | 认证加密，防篡改 |
| 防重放 | AAD (chunk index) | 乱序拼接直接熔断 |
| 指纹验证 | SHA-256 前 16 字节 | 0.1 秒内校验密码正确性 |

### 4.2 内存安全

```javascript
// 使用后立即覆写密钥内存
const rawKey = await crypto.subtle.exportKey("raw", key);
// ... 使用完毕
new Uint8Array(rawKey).fill(0);  // 物理级内存覆写
```

### 4.3 并发熔断

```javascript
const MAX_CONCURRENCY = 5;
const pool = new Set();

// 自动重试机制（最多 3 次）
async function uploadWithRetry(chunk, index, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await uploadChunk(chunk, index);
        } catch (e) {
            if (i === retries - 1) throw e;
            await delay(1000 * (i + 1)); // 指数退避
        }
    }
}
```

### 4.4 数学边界

```javascript
const MAX_SAFE_CHUNKS = 2 ** 32 - 1;  // 约 21.5 PB
// IV 推导: baseIV ^ chunkIndex
// 32-bit XOR 确保在 MAX_SAFE_CHUNKS 内绝不溢出
```

---

## 05. Manifest 数据结构

### 5.1 双模系统设计

Manifest 支持两种序列化模式，根据使用场景自动切换：

| 模式 | 格式 | 用途 | 体积 |
|------|------|------|------|
| **JSON** | 明文 JSON 字符串 | QR Code 兼容层、调试 | ~300 bytes + 文件名 |
| **Binary (.ptm)** | 自定义二进制打包 | 文件存储、传输 | 56 bytes + 文件名 |

### 5.2 JSON 模式（QR Code 兼容层）

```typescript
interface Manifest {
    version: "V12-Phantom";           // 版本标识
    fileName: string;                  // 原始文件名
    fileSize: number;                  // 原始文件大小（字节）
    chunkSize: number;                 // 分片大小（默认 5MB = 5242880）
    totalChunks: number;               // 总分片数
    salt: number[];                    // PBKDF2 Salt (16 bytes)
    baseIV: number[];                  // 基础 IV (12 bytes)
    fingerprint: number[];             // 密钥指纹 (16 bytes)
    checksum?: string;                 // 可选：原始文件 SHA-256
}
```

### 5.3 Binary `.ptm` 模式（生产级）

**字节级打包布局**（56 字节固定头 + 可变文件名）：

```
Offset  Size  Field         Description
──────────────────────────────────────────────
0       16    Salt          PBKDF2 Salt（原始 bytes）
16      12    BaseIV        AES-GCM 基础 IV（原始 bytes）
28      16    Fingerprint   密钥指纹（原始 bytes）
44      4     ChunkSize     Uint32 LE（默认 5242880）
48      4     TotalChunks   Uint32 LE
52      4     FileSize      Uint32 LE
56      ?     FileName      UTF-8 编码，无终止符
```

**核心优势**：
- **体积压缩**：JSON 模式下 Salt/BaseIV/Fingerprint 以 `number[]` 存储（每个 byte 展开为 3-4 字符数字 + 逗号），二进制模式直接写入原始 bytes，压缩比约 **5:1**
- **隐写性**：`.ptm` 文件无明文结构，无法通过肉眼识别内容
- **零解析开销**：直接通过 `DataView` 按偏移量读取，无需 JSON.parse

**体积对比**：

| 场景 | JSON | Binary .ptm | 压缩比 |
|------|------|-------------|--------|
| 空文件名 | ~280 bytes | 56 bytes | 5:1 |
| 文件名 "video.mp4" | ~310 bytes | 66 bytes | 4.7:1 |
| 长文件名 (50 chars) | ~380 bytes | 106 bytes | 3.6:1 |

### 5.4 QR Code 编码协议

```
QR Code 内容格式：
  PTM:{Base64 编码的 .ptm 二进制数据}

示例：
  PTM:AAAAEAAAAFgAAAAf///...AAAABQAAAAEAAAAFdmlkZW8ubXA0
```

- 前缀 `PTM:` 用于格式自动检测
- Base64 编码使二进制数据可嵌入 QR Code 文本
- 向后兼容：旧版 JSON Manifest 仍可被 `parseManifestAuto()` 识别

### 5.5 核心函数

```javascript
// 导出二进制 .ptm（56 字节固定头 + 文件名）
function exportBinaryManifest(manifest) → ArrayBuffer

// 导入二进制 .ptm
function importBinaryManifest(buffer) → Manifest

// 自动检测格式（JSON / Binary）
function parseManifestAuto(data) → Manifest

// 二进制 ↔ Base64 互转
function binaryManifestToBase64(buffer) → string
function base64ToArrayBuffer(base64) → ArrayBuffer

// 体积估算
function estimateManifestSize(manifest) → { json, binary, ratio }
```

---

## 06. BYOS 存储适配层设计 (V13)

### 6.1 设计哲学：Bring Your Own Storage

```
你只需要提供网页，用户自己带网盘来。
你没有存储成本，但你接管了全球最机密的数据流转。
```

BYOS 的核心是将存储与加密彻底解耦。Phantom-FS 只负责加密引擎，存储层完全由用户自带的 Provider 实现。

### 6.2 IStorageProvider 接口

```typescript
interface IStorageProvider {
    // 保存一个分片，返回寻址 ID
    putChunk(chunkId: string, data: ArrayBuffer): Promise<string>;
    
    // 获取一个分片（支持 HTTP Range 用于流式 Seek）
    getChunk(chunkId: string, range?: { start: number, end: number }): Promise<ArrayBuffer>;
    
    // 删除一个文件的所有分片
    deleteFile(fileId: string): Promise<void>;
    
    // 获取分片的直接访问 URL（用于 Range Request 优化）
    getChunkURL(chunkId: string): string | null;
}
```

**chunkId 格式**: `{fileId}/{8位十六进制索引}` (如 `abc123/00000000`)

### 6.3 Provider 矩阵

| Provider | 类型 | 存储位置 | 认证方式 | 适用场景 |
|----------|------|----------|----------|----------|
| **MemoryProvider** | 内存 | 浏览器 Map | 无 | 开发调试、测试 |
| **HTTPProvider** | HTTP | 任意静态文件服务器 | 自定义 Header | S3/Nginx/CDN |
| **S3Provider** | S3 API | AWS S3 / 阿里云 OSS / MinIO | 预签名 URL（服务端生成） | 生产级对象存储 |
| **WebDAVProvider** | WebDAV | Nextcloud / Synology / ownCloud | Basic Auth / 应用密码 | 私有云盘 |
| **FileSystemProvider** | OPFS | 浏览器 Origin Private File System | 无（沙盒隔离） | 离线场景、高性能 |
| **LocalFileProvider** | File API | 浏览器本地目录 | 用户授权 | 本地备份 |

### 6.4 Provider 工厂

```javascript
import { createProvider, ProviderType } from '../storage/cloud-store.js';

// S3 兼容对象存储（需要服务端 Presign API）
const s3 = createProvider('s3', {
    endpoint: 'https://s3.amazonaws.com',
    bucket: 'my-bucket',
    presignEndpoint: 'https://your-api.com/presign',
    authToken: '...'
});

// WebDAV (Nextcloud)
const webdav = createProvider('webdav', {
    baseURL: 'https://nextcloud.example.com/remote.php/dav/files/user',
    username: 'user',
    password: 'app-password'
});

// 浏览器 OPFS (离线)
const opfs = createProvider('opfs');
```

### 6.5 凭证安全：CredentialVault

API 密钥使用 AES-GCM 加密后存储在 localStorage，主密码通过 PBKDF2 (600k 迭代) 派生加密密钥。

```
用户输入主密码 → PBKDF2 派生 AES-256-GCM 密钥
    → 加密凭证数据 → 存入 localStorage
    → 会话超时 (24h) 自动清除内存密钥
```

**零信任承诺**：
- API Key 永不上传服务器
- 加密密钥仅存在于内存中，永不持久化
- 会话超时自动擦除
- 物理安全隔离

### 6.6 邮箱输出通道 (Email Channel)

加密完成后，可将 `.ptm` + 所有加密分片打包为单一 `.phantom` 文件，通过 EmailJS 发送到指定邮箱。

```
加密 → 打包(.phantom) → EmailJS → 收件人邮箱
                                    ↓
                              下载附件 → 解包 → 现有解密流程
```

**定位**：纯输出通道，不解密逻辑。邮箱仅作为 Manifest + Chunks 的运输载体。

**依赖**：[EmailJS](https://www.emailjs.com/)（纯前端，免费 200封/月）

**配置**：需在 [`index.html`](../index.html) 替换 `YOUR_PUBLIC_KEY` 为真实 EmailJS Public Key。

### 6.7 `.phantom` 解密流程

用户从邮箱下载 `.phantom` 附件后拖入解密区，流程如下：

```
.phantom 文件 → isPhantomPack() 检测 → unpackPhantom() 解包
    → 提取 .ptm 图纸 → importBinaryManifest() 解析
    → 从第一个 chunkId 提取 fileId（parseChunkId）
    → chunks 写入当前 Provider
    → 用户输入密码 → verifyPassword() 校验 → decryptFile() 解密
```

**关键细节**：`.phantom` 打包时 chunkId 格式为 `fileId/0000000X`，解密时必须从 chunkId 中提取原始 `fileId`，否则 `toChunkId('default', i)` 会生成不匹配的 key。

---

## 07. 性能指标

| 指标 | 目标值 | 说明 |
|------|--------|------|
| 加密速度 | > 50 MB/s | Chrome V8 + AES-GCM 硬件加速 |
| 内存峰值 | < 100 MB | 流式分片处理 |
| Manifest 体积 | < 1 KB | 即使 1TB 文件 |
| 视频 Seek 延迟 | < 200ms | O(1) 分片定位 |
| 密码校验延迟 | < 100ms | 指纹快速比对 |
| 最大文件支持 | 21.5 PB | 数学边界锁死 |
