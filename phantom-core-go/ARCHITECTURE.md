# 🏗️ Phantom-CLI 架构设计文档

> 版本: V12.1-Phantom (Go 系统级) | 更新: 2026-07

---

## 01. 核心架构原则

### 奥卡姆剃刀
系统遵循极简主义，拒绝臃肿的框架依赖，完全榨干 Go 标准库的密码学能力。

### 三大物理边界（核心安全模型）

```
┌─────────────────────────────────────────────────────────────┐
│                    三大物理边界                               │
│                                                             │
│  ① Chunks（加密碎沙）                                        │
│     → AES-256-GCM 加密后的二进制分片                          │
│     → 存储于本地文件系统或远程存储，无 Manifest 则毫无意义      │
│                                                             │
│  ② Manifest（藏宝图 .ptm）                                   │
│     → 包含 Salt / BaseIV / Fingerprint / 文件名              │
│     → 二进制 56-byte 固定头格式                              │
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

## 02. 系统架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     Phantom-CLI                             │
│                                                             │
│  ┌──────────────┐                                           │
│  │   CLI 入口    │  flag 解析 → 命令分发                      │
│  │  (main.go)   │  encrypt / decrypt / verify / info        │
│  └──────┬───────┘                                           │
│         │                                                   │
│  ┌──────▼───────┐    ┌──────────────────┐                   │
│  │   Cipher     │    │    Manifest      │                   │
│  │   (crypto)   │◄──►│    (.ptm)        │                   │
│  │              │    │                  │                   │
│  │ PBKDF2 600k  │    │ 56-byte header   │                   │
│  │ AES-256-GCM  │    │ + filename       │                   │
│  │ IV 推导      │    │ Export/Import    │                   │
│  └──────┬───────┘    └──────────────────┘                   │
│         │                                                   │
│  ┌──────▼───────┐    ┌──────────────────┐                   │
│  │    Pool      │    │    Store         │                   │
│  │  (并发控制)   │    │  (存储适配层)    │                   │
│  │              │    │                  │                   │
│  │ 信号量 sem   │    │ MemoryProvider   │                   │
│  │ 指数退避重试  │    │ LocalFileProvider│                   │
│  │ context 取消  │    │ HTTPProvider     │                   │
│  └──────────────┘    └──────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
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
│ ③ 分片 + 并发加密    │  ← goroutine pool (max 5)
│   chunk_i → AES-GCM │  ← IV = baseIV XOR BigEndian(i)
│   → 存储到 Provider  │  ← AAD = "chunk_{i}"
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ ④ 构建 Manifest     │
│   导出 .ptm 二进制   │  ← 56-byte header + filename
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
│ ③ 并发获取 + 解密    │  ← goroutine pool
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

### `pkg/cipher` — 密码学核心

```
PhantomCipher
├── key    []byte    // AES-256 密钥 (使用后清零)
├── salt   []byte    // 16 bytes
├── baseIV []byte    // 12 bytes
│
├── NewCipher(password, salt)          // 派生密钥
├── EncryptChunk(plaintext, index)     // AES-256-GCM
├── DecryptChunk(data, index)          // 解密 + AAD 验证
├── EncryptFile(data, chunkSize)       // 全文件加密
├── DecryptFile(chunks, totalSize)     // 全文件解密
├── Fingerprint()                      // 返回密钥指纹
├── VerifyPassword(password, salt, fp) // 快速校验
├── SetBaseIV(iv)                      // 设置基础 IV
├── Destroy()                          // 安全清零
└── GenerateSalt() / GenerateBaseIV()  // 随机数生成
```

### `pkg/manifest` — .ptm 二进制格式

```
Manifest
├── Version, FileName, FileSize
├── ChunkSize, TotalChunks
├── Salt [16]byte, BaseIV [12]byte, Fingerprint [16]byte
│
├── ExportBinary() → []byte    // 56-byte header + filename
├── ImportBinary([]byte)       // 反序列化
├── IsBinaryManifest([]byte)   // 启发式检测
├── Validate() error           // 字段校验
└── EstimateSize()             // JSON vs 二进制体积对比
```

**二进制布局 (56-byte 固定头)**:

```
Offset  Size  Field
0       16    Salt
16      12    BaseIV
28      16    Fingerprint
44      4     ChunkSize (LittleEndian uint32)
48      4     TotalChunks (LittleEndian uint32)
52      4     FileSize (LittleEndian uint32)
56      N     FileName (UTF-8, 可变长)
```

### `pkg/pool` — 并发控制

```
Pool
├── sem chan struct{}       // 缓冲 channel 作为信号量
├── wg  sync.WaitGroup
├── ctx context.Context
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

### `pkg/store` — 存储适配层

```
Provider (interface)
├── PutChunk(ctx, chunkID, data) (string, error)
├── GetChunk(ctx, chunkID, range?) ([]byte, error)
├── DeleteFile(ctx, fileID) error
└── GetChunkURL(chunkID) string

实现:
├── MemoryProvider    // 内存 map (测试用)
├── LocalFileProvider // 本地文件系统
└── HTTPProvider      // HTTP PUT/GET + Range
```

---

## 05. 安全设计

### 内存安全
- 密钥使用后通过 `secureZero()` 物理清零
- `PhantomCipher.Destroy()` 清零所有敏感字段
- Go GC 不保证立即回收，但显式清零消除残留风险

### 防时序攻击
- `compareFingerprint()` 使用常量时间比较
- 所有分支路径不依赖密钥内容

### 防重放攻击
- 每个分片使用唯一 IV（baseIV XOR chunkIndex）
- AAD 绑定分片索引，防止分片重排

### 防篡改
- AES-256-GCM 认证加密，篡改即解密失败
- IV 验证：解密时校验 nonce 是否与推导一致

---

## 06. BYOS Session 文件夹结构 (V13)

### 6.1 设计哲学

```
你只需要提供网盘，我们提供加密引擎。
你没有存储成本，但你接管了全球最机密的数据流转。
```

CLI 端加密输出为 Session 文件夹，天然实现"头身分离"：

```
my_export/The.Matrix.1080p_phantom/
├── blueprint.ptm          (头文件：藏宝图，可单独抽走)
└── chunks/                (身体：纯碎沙子)
    ├── 00000000.chk
    ├── 00000001.chk
    └── ...
```

### 6.2 物理隔离工作流

```
加密:
  用户文件 → 分片加密 → chunks/ 目录 → 上传到任意云盘
                       → blueprint.ptm → 打印为二维码 / 存入保险箱

解密:
  从云盘下载 chunks/ 目录
  从保险箱取出 blueprint.ptm
  phantom decrypt blueprint.ptm → 自动定位 chunks/ → 解密还原
```

### 6.3 自动路径推断

`cmdDecrypt` 自动检测 `.ptm` 文件所在目录是否包含 `chunks/` 子目录：

```go
// 如果 blueprint.ptm 在 Session 目录中，chunks/ 自动定位到同级
if strings.HasSuffix(ptmDir, "_phantom") {
    storeDir = filepath.Join(ptmDir, "chunks")
}
```

### 6.4 Provider 接口

```go
type Provider interface {
    PutChunk(ctx context.Context, chunkID string, data []byte) (string, error)
    GetChunk(ctx context.Context, chunkID string, rng *Range) ([]byte, error)
    DeleteFile(ctx context.Context, fileID string) error
    GetChunkURL(ctx context.Context, chunkID string) (string, error)
}
```

| 实现 | 存储位置 | 适用场景 |
|------|----------|----------|
| `MemoryProvider` | 进程内存 | 开发调试 |
| `LocalFileProvider` | 本地文件系统 | 桌面端默认 |
| `HTTPProvider` | 远程 HTTP 服务器 | 与 WEB 端共享存储 |

---

## 07. 跨语言互操作

Phantom-CLI (Go) 与 Phantom-Web (JS) 共享同一套密码学协议：

| 参数 | Go 实现 | JS 实现 |
|------|---------|---------|
| 密钥派生 | `pbkdf2.Key(password, salt, 600000, 32, sha256.New)` | `PBKDF2(password, salt, 600000, 32, SHA-256)` |
| IV 推导 | `BigEndian.PutUint32(iv[8:12], last4^chunkIndex)` | `DataView.setUint32(8, last4 ^ chunkIndex, false)` |
| AAD | `fmt.Sprintf("chunk_%d", index)` | `new TextEncoder().encode("chunk_"+index)` |
| 指纹 | `sha256.Sum256(key)[:16]` | `SHA-256(key).then(h => h.slice(0,16))` |
| .ptm 头 | `binary.LittleEndian.PutUint32` | `DataView.setUint32(offset, value, true)` |

**保证：相同 password + salt + baseIV + chunkIndex → 完全相同密文。**
