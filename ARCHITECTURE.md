# 🏗️ Phantom-FS 架构设计文档

> 版本: V12.1-Phantom | 更新: 2026-07

---

## 01. 核心架构原则

### 奥卡姆剃刀
系统遵循极简主义，拒绝臃肿的框架依赖。Go 端榨干标准库密码学能力，JS 端仅调用 `window.crypto.subtle`。

### 三大物理边界（核心安全模型）

```
┌─────────────────────────────────────────────────────────────┐
│                    三大物理边界                               │
│                                                             │
│  ① Chunks（加密碎沙）                                        │
│     → AES-256-GCM 加密后的二进制分片                          │
│     → 存储于本地或远程，无 Manifest 则毫无意义                  │
│                                                             │
│  ② Manifest（藏宝图 .ptm）                                   │
│     → 包含 Salt / BaseIV / Fingerprint / 文件名              │
│     → 二进制 60-byte 固定头格式                              │
│     → 物理隔离：无 Manifest 则找不到碎片                       │
│                                                             │
│  ③ Password（唯一钥匙）                                      │
│     → 用户输入的密码字符串                                    │
│     → 仅存在于进程内存，使用后 secureZero 清零                │
│                                                             │
│   三者物理分离，单一泄露无法还原数据                           │
└─────────────────────────────────────────────────────────────┘
```

### 三大设计支柱

| 支柱 | 原则 | 实现 |
|------|------|------|
| **分离主义** | Map & Key 剥离 | Manifest（图纸）与 Chunks（加密分片）分离存储 |
| **零信任引擎** | 密钥仅存于内存 | 使用后 `secureZero` 物理清零 |
| **哑管道存储** | 存储无状态 | 仅需支持 PUT / GET / Range Request |

---

## 02. 双端架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     Phantom-FS Ecosystem                      │
├──────────────────────────┬──────────────────────────────────┤
│  Phantom-CLI (Go)        │  Phantom-Web (JS)                │
│  「重装步兵」             │  「幽灵锁孔」                     │
│                          │                                  │
│  生产 & 自动化            │  消费 & 无门槛触达                │
│                          │                                  │
│  ┌──────────────────┐   │  ┌──────────────────────────┐   │
│  │  CLI 入口         │   │  │  UI Layer (app.js)       │   │
│  │  (main.go)       │   │  │  - 文件选择 / 拖拽        │   │
│  │  encrypt/decrypt │   │  │  - 扫码 / 邮箱            │   │
│  │  verify/info     │   │  │  - 进度 / 设置            │   │
│  └───────┬──────────┘   │  └───────────┬──────────────┘   │
│          │              │              │                   │
│  ┌───────▼──────────┐   │  ┌───────────▼──────────────┐   │
│  │  Cipher Engine    │   │  │  Cipher Engine            │   │
│  │  (Go crypto)      │   │  │  (Web Crypto API)        │   │
│  │                   │   │  │                           │   │
│  │  PBKDF2 600k      │   │  │  PBKDF2 600k              │   │
│  │  AES-256-GCM      │   │  │  AES-256-GCM              │   │
│  │  IV 推导          │   │  │  IV 推导                  │   │
│  └───────┬──────────┘   │  └───────────┬──────────────┘   │
│          │              │              │                   │
│  ┌───────▼──────────┐   │  ┌───────────▼──────────────┐   │
│  │  Manifest (.ptm)  │   │  │  Manifest (.ptm/JSON)    │   │
│  │  60-byte header   │   │  │  60-byte header + QR    │   │
│  └───────┬──────────┘   │  └───────────┬──────────────┘   │
│          │              │              │                   │
│  ┌───────▼──────────┐   │  ┌───────────▼──────────────┐   │
│  │  Store Layer      │   │  │  Store Layer              │   │
│  │  (Provider)       │   │  │  (IStorageProvider)       │   │
│  │                   │   │  │                           │   │
│  │  MemoryProvider   │   │  │  MemoryProvider           │   │
│  │  LocalFileProvider│   │  │  HTTPProvider             │   │
│  │  HTTPProvider     │   │  │  S3Provider               │   │
│  └──────────────────┘   │  │  WebDAVProvider            │   │
│                          │  │  FileSystemProvider(OPFS) │   │
│                          │  │  LocalFileProvider        │   │
│                          │  │  CredentialVault          │   │
│                          │  └──────────────────────────┘   │
└──────────────────────────┴──────────────────────────────────┘
```

---

## 03. 数据流

### 加密流程

```
输入文件 + 密码
    │
    ▼
┌─────────────────────┐
│ ① 生成 Salt (16B)  │  ← crypto/rand
│   生成 BaseIV (12B) │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ ② 派生密钥          │  ← PBKDF2(password, salt, 600k)
│   提取指纹 (16B)    │  ← SHA-256(key)[0:16]
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ ③ 分片 + 并发加密    │  ← Pool (max 5)
│   chunk_i → AES-GCM │  ← IV = baseIV XOR BigEndian(i)
│   → 存储到 Provider  │  ← AAD = "chunk_{i}"
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ ④ 构建 Manifest     │
│   导出 .ptm 二进制   │  ← 60-byte header + filename
└─────────────────────┘
```

### 解密流程

```
.ptm 文件 + 密码
    │
    ▼
┌─────────────────────┐
│ ① 解析 .ptm         │  ← 提取 Salt/BaseIV/Fingerprint/分片信息
│   校验格式完整性     │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ ② 派生密钥 + 指纹比对│  ← 快速校验密码（不解密数据）
│   VerifyPassword()  │  ← 常量时间比对
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ ③ 并发获取 + 解密    │  ← Pool
│   GetChunk(i)        │
│   DecryptChunk()     │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ ④ 拼接原始文件       │
└─────────────────────┘
```

---

## 04. 包设计

### `cipher` — 密码学核心

```
PhantomCipher
├── key    []byte    // AES-256 密钥 (使用后清零)
├── salt   []byte    // 16 bytes
├── baseIV []byte    // 12 bytes
│
├── NewCipher(password, salt)          // 派生密钥
├── EncryptChunk(plaintext, index)     // AES-256-GCM
├── DecryptChunk(data, index)          // 解密 + AAD 验证
├── Fingerprint()                      // 返回密钥指纹
├── VerifyPassword(password, salt, fp) // 快速校验
├── SetBaseIV(iv)                      // 设置基础 IV
├── Destroy()                          // 安全清零
└── GenerateSalt() / GenerateBaseIV()  // 随机数生成
```

### `manifest` — .ptm 二进制格式

```
Manifest
├── Version, FileName, FileSize (int64)
├── ChunkSize, TotalChunks
├── Salt [16]byte, BaseIV [12]byte, Fingerprint [16]byte
│
├── ExportBinary() → []byte    // 60-byte header + filename
├── ImportBinary([]byte)       // 反序列化
├── IsBinaryManifest([]byte)   // 启发式检测
├── Validate() error           // 字段校验
└── EstimateSize()             // 体积估算
```

**二进制布局 (60-byte 固定头)**:

```
Offset  Size  Field
0       16    Salt                    (Big Endian)
16      12    BaseIV                  (Big Endian)
28      16    Fingerprint             (Big Endian)
44      4     ChunkSize               (Uint32, Big Endian)
48      4     TotalChunks             (Uint32, Big Endian)
52      8     FileSize                (Uint48, Big Endian, 最大 256TB)
60      N     FileName                (UTF-8, 可变长)
```

### `pool` — 并发控制

```
Pool
├── sem chan struct{}       // 缓冲 channel 作为信号量
├── wg  sync.WaitGroup      // Go / Promise.all (JS)
│
├── New(maxConcurrency, maxRetries)
├── Add(task func(ctx) error)
├── WaitAll() []error
└── Stop()
```

- 默认最大并发数: 5
- 默认最大重试次数: 3
- 重试策略: 指数退避 (1s → 2s → 4s)
- 错误收集: 静默断路器模式

### `store` — 存储适配层

```
Provider (interface)
├── PutChunk(ctx, chunkID, data) (string, error)
├── GetChunk(ctx, chunkID, range?) ([]byte, error)
├── DeleteFile(ctx, fileID) error
└── GetChunkURL(chunkID) string
```

| 实现 | 端 | 存储位置 | 适用场景 |
|------|----|----------|----------|
| `MemoryProvider` | Go/JS | 进程内存 | 开发调试 |
| `LocalFileProvider` | Go/JS | 本地文件系统 | 桌面端默认 |
| `HTTPProvider` | Go/JS | 远程 HTTP 服务器 | 自定义后端 |
| `S3Provider` | JS | AWS S3 / 兼容 API | 生产环境 |
| `WebDAVProvider` | JS | WebDAV 服务器 | NAS / Nextcloud |
| `FileSystemProvider` | JS | OPFS (浏览器) | 浏览器本地存储 |

---

## 05. BYOS Session 文件夹结构

### 设计哲学

```
你只需要提供网盘，我们提供加密引擎。
你没有存储成本，但你接管了全球最机密的数据流转。
```

CLI 端加密输出为 Session 文件夹，天然实现"头身分离"：

```
my_export/The.Matrix.1080p_phantom/
├── blueprint.ptm          (头文件：藏宝图，可单独抽走)
└── chunks/                (身体：纯碎沙子)
    ├── {fileId}/
    │   ├── 00000000.chk
    │   ├── 00000001.chk
    │   └── ...
```

### 物理隔离工作流

```
加密:
  用户文件 → 分片加密 → chunks/ 目录 → 上传到任意云盘
                       → blueprint.ptm → 打印为二维码 / 存入保险箱

解密:
  从云盘下载 chunks/ 目录
  从保险箱取出 blueprint.ptm
  phantom decrypt blueprint.ptm → 自动定位 chunks/ → 解密还原
```

---

## 06. 安全设计

### 内存安全
- 密钥使用后通过 `secureZero()` 物理清零
- `PhantomCipher.Destroy()` 清零所有敏感字段
- JS 端 `withSecureKey(key, fn)` 自动管理密钥生命周期

### 防时序攻击
- `compareFingerprint()` 使用常量时间比较
- 所有分支路径不依赖密钥内容

### 防重放攻击
- 每个分片使用唯一 IV（baseIV XOR BigEndian(chunkIndex)）
- AAD 绑定分片索引，防止分片重排

### 防篡改
- AES-256-GCM 认证加密，篡改即解密失败
- 指纹验证：解密时校验密钥指纹是否与 Manifest 一致

---

## 07. 跨语言互操作

Phantom-CLI (Go) 与 Phantom-Web (JS) 共享同一套密码学协议：

| 参数 | Go 实现 | JS 实现 |
|------|---------|---------|
| 密钥派生 | `pbkdf2.Key(password, salt, 600000, 32, sha256.New)` | `PBKDF2(password, salt, 600000, 32, SHA-256)` |
| IV 推导 | `binary.BigEndian.PutUint32(iv[8:12], last4^chunkIndex)` | `DataView.setUint32(8, last4 ^ chunkIndex, false)` |
| AAD | `fmt.Sprintf("chunk_%d", index)` | `new TextEncoder().encode("chunk_"+index)` |
| 指纹 | `sha256.Sum256(key)[:16]` | `SHA-256(key).then(h => h.slice(0,16))` |
| .ptm 头 | `binary.BigEndian.PutUint32` | `DataView.setUint32(offset, value, false)` |

**保证：相同 password + salt + baseIV + chunkIndex → 完全相同密文。**
