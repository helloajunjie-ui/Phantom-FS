# ⚙️ Phantom-FS 核心引擎规范 (V12.1)

> 引擎代号: 青羽 | 双端: Go + JS

---

## 01. 引擎架构

```
┌─────────────────────────────────────────────────────┐
│                 Phantom Cipher Engine                 │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │           Key Derivation Layer                │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │   │
│  │  │ PBKDF2   │  │  Salt    │  │ Finger-  │   │   │
│  │  │ 600k it  │  │  Gen     │  │ print    │   │   │
│  │  └──────────┘  └──────────┘  └──────────┘   │   │
│  └──────────────────────────────────────────────┘   │
│                      │                              │
│  ┌──────────────────────────────────────────────┐   │
│  │           Stream Cipher Layer                 │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │   │
│  │  │ File     │  │ IV       │  │ AAD      │   │   │
│  │  │ Slicing  │  │ Derive   │  │ Tagging  │   │   │
│  │  └──────────┘  └──────────┘  └──────────┘   │   │
│  └──────────────────────────────────────────────┘   │
│                      │                              │
│  ┌──────────────────────────────────────────────┐   │
│  │           Manifest Layer                      │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │   │
│  │  │ Binary   │  │  JSON    │  │ QR Code  │   │   │
│  │  │ .ptm     │  │  Fallback│  │ Encode   │   │   │
│  │  └──────────┘  └──────────┘  └──────────┘   │   │
│  └──────────────────────────────────────────────┘   │
│                      │                              │
│  ┌──────────────────────────────────────────────┐   │
│  │           Storage Adapter Layer               │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │   │
│  │  │ Memory   │  │  HTTP    │  │  S3      │   │   │
│  │  │ Provider │  │ Provider │  │ Provider │   │   │
│  │  └──────────┘  └──────────┘  └──────────┘   │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │   │
│  │  │ WebDAV   │  │  OPFS    │  │  Local   │   │   │
│  │  │ Provider │  │ Provider │  │  File    │   │   │
│  │  └──────────┘  └──────────┘  └──────────┘   │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## 02. 密码学协议

### 2.1 密钥派生

| 参数 | 值 |
|------|-----|
| 算法 | PBKDF2 |
| 哈希 | SHA-256 |
| 迭代次数 | 600,000 |
| 输出密钥长度 | 32 bytes (256-bit) |
| Salt 长度 | 16 bytes (128-bit) |
| Salt 生成 | `crypto/rand` (Go) / `crypto.getRandomValues` (JS) |

### 2.2 加密算法

| 参数 | 值 |
|------|-----|
| 算法 | AES-256-GCM |
| 密钥长度 | 32 bytes (256-bit) |
| IV/Nonce 长度 | 12 bytes (96-bit) |
| Tag 长度 | 16 bytes (128-bit) |
| 附加数据 (AAD) | `"chunk_{index}"` (UTF-8) |

### 2.3 IV 推导算法

确定性 IV 推导，确保相同输入产生相同密文：

```
baseIV:     [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] (12 bytes)
chunkIndex: uint32 (Big Endian)

iv[0..7]  = baseIV[0..7]       (前 8 字节不变)
iv[8..11] = baseIV[8..11] XOR BigEndian(chunkIndex)

Go 实现:
    binary.BigEndian.PutUint32(iv[8:12], last4^chunkIndex)

JS 实现:
    view.setUint32(8, last4 ^ chunkIndex, false)  // false = Big Endian
```

### 2.4 指纹

```
fingerprint = SHA-256(key)[0:16]  (密钥的前 16 字节哈希)
```

用于快速校验密码是否正确（无需解密数据），使用常量时间比较防时序攻击。

### 2.5 跨语言保证

**相同 password + salt + baseIV + chunkIndex → Go 与 JS 产出完全相同密文，可互相解密。**

---

## 03. .ptm 二进制图纸格式

### 3.1 固定头 (60 bytes)

```
Offset  Size  Field           Type        Endianness
0       16    Salt            [16]byte    —
16      12    BaseIV          [12]byte    —
28      16    Fingerprint     [16]byte    —
44      4     ChunkSize       uint32      Big Endian
48      4     TotalChunks     uint32      Big Endian
52      6     FileSize        uint48      Big Endian (高16位 + 低32位)
58      2     [reserved]      uint16      —
60      N     FileName        UTF-8       可变长
```

### 3.2 字段说明

- **Salt**: PBKDF2 盐值，16 字节随机数
- **BaseIV**: AES-GCM 基础 IV，12 字节随机数
- **Fingerprint**: 密钥指纹，用于快速校验密码
- **ChunkSize**: 每个分片的字节数（默认 5MB）
- **TotalChunks**: 总分片数
- **FileSize**: 原始文件大小，Uint48 编码（支持最大 256TB）
  - 高 16 位: `data[52:54]` Big Endian
  - 低 32 位: `data[54:58]` Big Endian
  - 恢复: `fileSize = (hi << 32) | lo`
- **FileName**: UTF-8 编码的文件名，无固定长度限制

### 3.3 Base64 编码

```
PTM:{base64(data)}
```

前缀 `PTM:` 用于快速识别 .ptm 格式，可嵌入 QR 码。

---

## 04. 存储适配器接口

### 4.1 Provider 接口

```typescript
interface IStorageProvider {
    // 上传分片，返回 ETag 或标识
    putChunk(chunkId: string, data: ArrayBuffer): Promise<string>;

    // 下载分片，支持 Range 请求
    getChunk(chunkId: string, range?: { start: number; end: number }): Promise<ArrayBuffer>;

    // 删除文件的所有分片
    deleteFile(fileId: string): Promise<void>;

    // 获取分片的直接访问 URL（用于 S3 Presigned URL 等）
    getChunkURL(chunkId: string): string | null;
}
```

### 4.2 Provider 矩阵

| Provider | 端 | 存储位置 | 认证方式 | Range 支持 |
|----------|----|----------|----------|-----------|
| MemoryProvider | Go/JS | 进程内存 | 无 | 是 |
| LocalFileProvider | Go/JS | 本地文件系统 | 无 | 是 |
| HTTPProvider | Go/JS | 远程 HTTP | Basic Auth | 是 |
| S3Provider | JS | AWS S3 | Presigned URL | 是 |
| WebDAVProvider | JS | WebDAV | Basic Auth | 是 |
| FileSystemProvider | JS | OPFS (浏览器) | 无 | 是 |

### 4.3 Chunk ID 格式

```
{fileId}/{chunkIndex}
```

- `fileId`: 32 字符十六进制随机字符串（如 `a1b2c3d4e5f6...`）
- `chunkIndex`: 8 字符十六进制分片序号（如 `00000000`、`00000001`）

示例: `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6/00000005`

### 4.4 HTTP Range 规范

所有 Provider 的 `getChunk` 接口使用**独占式 end**（即 `[start, end)`）：

```typescript
// 请求 bytes 0-1023（共 1024 字节）
getChunk("id", { start: 0, end: 1024 })

// HTTP Range 头使用 inclusive 格式
// Range: bytes=0-1023  (end - 1)
```

---

## 05. 并发控制

### 5.1 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 最大并发数 | 5 | 同时处理的分片数 |
| 最大重试次数 | 3 | 总尝试次数（初始执行 + 重试） |
| 退避策略 | 指数退避 | 1s → 2s → 4s |

### 5.2 语义

- `maxRetries = 3` → 初始执行 + 最多 2 次重试 = 最多 3 次总尝试
- 错误收集模式：静默断路器，所有错误在 `WaitAll()` 后统一返回

---

## 06. 安全约束

### 6.1 内存安全

- 密钥使用后通过 `secureZero()` 物理覆写清零
- JS 端 `withSecureKey(key, fn)` 自动管理密钥生命周期
- Go 端 `PhantomCipher.Destroy()` 清零所有敏感字段

### 6.2 防时序攻击

- `compareFingerprint()` 使用常量时间比较（`xor` 累加）
- 所有分支路径不依赖密钥内容

### 6.3 防重放攻击

- 每个分片使用唯一 IV（baseIV XOR BigEndian(chunkIndex)）
- AAD 绑定分片索引，防止分片重排

### 6.4 防篡改

- AES-256-GCM 认证加密，篡改即解密失败（Tag 验证失败）
- 指纹验证：解密时校验密钥指纹是否与 Manifest 一致

---

## 07. 已知陷阱与修复记录

### 7.1 陷阱1：JS `>>> 0` 有符号整数溢出（已修复）

**问题**: `deriveChunkIV` 中 `last4 ^ chunkIndex` 在 JS 中为 32 位有符号整数运算。当 `last4` 最高位为 1 时（如 `0xFFFFFFFF`），`last4 ^ 0` 结果为 `-1`，导致 `setUint32` 写入 `0xFFFFFFFF`。Go 端 `binary.BigEndian.PutUint32` 始终按无符号处理，写入 `0x00000000FFFFFFFF`。两端 IV 不一致。

**修复**: `(last4 >>> 0) ^ chunkIndex` — `>>> 0` 将结果强制转为无符号 32 位整数。

### 7.2 陷阱2：Go `sync.Pool` + `ReadAt` Worker Pool OOM（已修复）

**问题**: 原始实现使用 `os.ReadFile` 一次性读入整个文件。对于 50GB 文件，这会导致 OOM。

**修复**: 使用 `os.Open` + `ReadAt` 按偏移读取，配合 `sync.Pool` 复用缓冲区。总内存上限 = `maxConcurrency * chunkSize`，永远可控。

### 7.3 陷阱3：跨语言字节序不兼容（已修复）

**问题**: Go 端使用 `binary.LittleEndian` 编码多字节字段，JS 端使用 `DataView.setUint32(offset, value, false)`（Big Endian）。两端 Manifest 不兼容。

**修复**: Go 端改为 `binary.BigEndian`，与 JS 一致。

### 7.4 陷阱4：Go HTTPProvider Range 边界（已修复）

**问题**: `rangeOpt.End` 直接作为 HTTP Range 的 end 值，但 HTTP Range 是 inclusive 的，而接口定义的 end 是 exclusive。导致请求的字节范围多 1 字节。

**修复**: `end := rangeOpt.End - 1`，并做 `if end < 0 { end = 0 }` 边界保护。

### 7.5 陷阱5：Go cmdEncrypt Session 目录时序（已修复）

**问题**: Session 目录在加密循环之后才创建，Provider 初始化时指向旧目录。分片写入错误位置。

**修复**: 将 Session 目录创建移到 Provider 初始化之前。

### 7.6 陷阱6：Go fileSize int 溢出（已修复）

**问题**: `fileSize := int(fi.Size())` 在 32 位系统上溢出。`Manifest.FileSize` 改为 `int64`。

**修复**: `manifest.go` 中 `int()` → `int64()`；`main.go` 中 `int(fi.Size())` → `fi.Size()`。
