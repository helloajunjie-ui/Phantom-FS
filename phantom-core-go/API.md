# 📡 Phantom-CLI API 设计文档

> 版本: V12.1-Phantom (Go 后端) | 协议: Go Package API

---

## 01. 设计原则

- **纯 Go API**：所有操作在本地完成，无外部服务依赖
- **显式错误处理**：所有可能失败的操作返回 `error`
- **零外部依赖**：密码学仅依赖 `crypto/aes` + `golang.org/x/crypto/pbkdf2`
- **安全优先**：敏感数据使用后显式清零

---

## 02. 包 API

### `cipher` 包 — 密码学核心

```go
package cipher

// PhantomCipher 是密码学引擎实例
type PhantomCipher struct { /* 内部字段 */ }

// NewCipher 创建密码学引擎
// password: 用户密码
// salt: 16 字节随机盐
func NewCipher(password string, salt []byte) (*PhantomCipher, error)

// SetBaseIV 设置基础 IV（加密时由随机数生成）
func (c *PhantomCipher) SetBaseIV(iv []byte)

// EncryptChunk 加密单个分片
// plaintext: 原始数据
// chunkIndex: 分片索引（用于 IV 推导和 AAD）
// 返回: nonce(12) + ciphertext + tag(16)
func (c *PhantomCipher) EncryptChunk(plaintext []byte, chunkIndex uint32) ([]byte, error)

// DecryptChunk 解密单个分片
// data: nonce(12) + ciphertext + tag(16)
// chunkIndex: 分片索引
func (c *PhantomCipher) DecryptChunk(data []byte, chunkIndex uint32) ([]byte, error)

// EncryptFile 加密整个文件
// 自动分片，并发加密
func (c *PhantomCipher) EncryptFile(plaintext []byte, chunkSize int) ([][]byte, error)

// DecryptFile 解密所有分片，拼接为原始文件
func (c *PhantomCipher) DecryptFile(chunks [][]byte, totalSize int) ([]byte, error)

// Fingerprint 返回当前密钥的指纹 (SHA-256(key)[0:16])
func (c *PhantomCipher) Fingerprint() []byte

// Destroy 安全清零所有敏感字段
func (c *PhantomCipher) Destroy()

// --- 静态函数 ---

// VerifyPassword 快速校验密码（无需解密数据）
func VerifyPassword(password string, salt, expectedFingerprint []byte) bool

// ExtractFingerprint 从密钥提取指纹
func ExtractFingerprint(key []byte) []byte

// DeriveChunkIV 确定性 IV 推导
func DeriveChunkIV(baseIV []byte, chunkIndex uint32) []byte

// BuildAAD 构建附加认证数据
func BuildAAD(chunkIndex uint32) []byte

// GenerateSalt 生成随机 Salt (16 bytes)
func GenerateSalt() ([]byte, error)

// GenerateBaseIV 生成随机 BaseIV (12 bytes)
func GenerateBaseIV() ([]byte, error)

// --- 常量 ---
const SaltLen = 16
const BaseIVLen = 12
const KeyLen = 32
const FingerprintLen = 16
const PBKDF2Iterations = 600000
const MaxSafeChunks = 1<<32 - 1
```

### `manifest` 包 — .ptm 二进制图纸

```go
package manifest

// Manifest 存储文件元数据和密码学参数
type Manifest struct {
    Version     string
    FileName    string
    FileSize    int
    ChunkSize   int
    TotalChunks int
    Salt        []byte  // 16 bytes
    BaseIV      []byte  // 12 bytes
    Fingerprint []byte  // 16 bytes
}

// ExportBinary 导出为二进制 .ptm 格式
// 返回: 56-byte header + UTF-8 filename
func (m *Manifest) ExportBinary() ([]byte, error)

// ImportBinary 从二进制数据解析 Manifest
func ImportBinary(data []byte) (*Manifest, error)

// IsBinaryManifest 启发式检测是否为 .ptm 格式
func IsBinaryManifest(data []byte) bool

// Validate 校验 Manifest 字段合法性
func (m *Manifest) Validate() error

// EstimateSize 估算 JSON vs 二进制体积对比
func (m *Manifest) EstimateSize() map[string]int

// --- 常量 ---
const HeaderSize = 56
```

### `pool` 包 — 并发控制

```go
package pool

// Pool 管理并发任务执行
type Pool struct { /* 内部字段 */ }

// New 创建并发池
// maxConcurrency: 最大并发数 (默认 5)
// maxRetries: 最大重试次数 (默认 3)
func New(maxConcurrency, maxRetries int) *Pool

// Add 添加任务到队列
// task: func(ctx context.Context) error
// 自动重试（指数退避）
func (p *Pool) Add(task func(context.Context) error)

// WaitAll 等待所有任务完成，返回错误列表
func (p *Pool) WaitAll() []error

// Stop 取消所有进行中的任务
func (p *Pool) Stop()

// --- 常量 ---
const DefaultMaxConcurrency = 5
const DefaultMaxRetries = 3
const DefaultRetryDelay = 1 * time.Second
```

### `store` 包 — 存储适配层

```go
package store

// Provider 是存储后端接口
type Provider interface {
    PutChunk(ctx context.Context, chunkID string, data []byte) (string, error)
    GetChunk(ctx context.Context, chunkID string, rng *Range) ([]byte, error)
    DeleteFile(ctx context.Context, fileID string) error
    GetChunkURL(chunkID string) string
}

// Range 表示字节范围请求
type Range struct {
    Start int64
    End   int64
}

// --- 实现 ---

// MemoryProvider 内存存储（测试用）
func NewMemoryProvider() *MemoryProvider
func (p *MemoryProvider) Stats() map[string]int

// LocalFileProvider 本地文件系统存储
func NewLocalFileProvider(baseDir string) *LocalFileProvider

// HTTPProvider HTTP 远程存储
func NewHTTPProvider(baseURL string) *HTTPProvider
```

---

## 03. 错误处理

所有错误通过标准 Go `error` 接口返回，使用 `fmt.Errorf` 包装上下文：

```go
// 密码学错误
cipher: salt 必须为 16 字节
cipher: baseIV 未设置
cipher: IV 不匹配，数据可能被篡改
cipher: 解密失败 (AAD 验证未通过)

// Manifest 错误
manifest: 数据太短，无法解析
manifest: 校验和不匹配
manifest: 文件名包含非法字符

// 存储错误
store: chunk not found: {chunkID}
store: provider not configured
```

---

## 04. BYOS Session 工作流 (V13)

### CLI 加密 → Session 文件夹

```go
// phantom encrypt my_video.mp4 -o ./my_export
//
// 输出:
//   my_export/my_video_phantom/
//   ├── blueprint.ptm          (头文件：可单独抽走)
//   └── chunks/                (身体：纯碎沙子)
//       ├── 00000000.chk
//       ├── 00000001.chk
//       └── ...
```

### CLI 解密 → 自动路径推断

```go
// phantom decrypt my_export/my_video_phantom/blueprint.ptm
//
// 自动检测: blueprint.ptm 在 my_video_phantom/ 目录中
// 自动定位: chunks/ 目录到 my_video_phantom/chunks/
// 自动推断: fileID 从 chunks/ 子目录名
```

### Provider 接口

```go
type Provider interface {
    PutChunk(ctx context.Context, chunkID string, data []byte) (string, error)
    GetChunk(ctx context.Context, chunkID string, rng *Range) ([]byte, error)
    DeleteFile(ctx context.Context, fileID string) error
    GetChunkURL(ctx context.Context, chunkID string) (string, error)
}
```

### 内置实现

| Provider | 构造函数 | 存储位置 |
|----------|---------|----------|
| `MemoryProvider` | `store.NewMemoryProvider()` | 进程内存 |
| `LocalFileProvider` | `store.NewLocalFileProvider(dir)` | 本地文件系统 |
| `HTTPProvider` | `store.NewHTTPProvider(baseURL)` | 远程 HTTP 服务器 |

## 05. 使用示例

```go
package main

import (
    "github.com/phantom-fs/phantom-core-go/pkg/cipher"
    "github.com/phantom-fs/phantom-core-go/pkg/manifest"
    "github.com/phantom-fs/phantom-core-go/pkg/store"
)

func encryptExample() {
    // 1. 读取文件
    data := []byte("hello world")

    // 2. 生成密码学参数
    salt, _ := cipher.GenerateSalt()
    baseIV, _ := cipher.GenerateBaseIV()

    // 3. 创建密码学引擎
    eng, _ := cipher.NewCipher("my-password", salt)
    eng.SetBaseIV(baseIV)
    defer eng.Destroy()

    // 4. 加密
    chunks, _ := eng.EncryptFile(data, 5*1024*1024)

    // 5. 存储分片
    prov := store.NewLocalFileProvider("./.phantom-fs")
    for i, chunk := range chunks {
        chunkID := fmt.Sprintf("file123/%08x", i)
        prov.PutChunk(context.Background(), chunkID, chunk)
    }

    // 6. 导出 .ptm 图纸
    m := &manifest.Manifest{
        FileName:    "secret.txt",
        FileSize:    len(data),
        ChunkSize:   5 * 1024 * 1024,
        TotalChunks: len(chunks),
        Salt:        salt,
        BaseIV:      baseIV,
        Fingerprint: eng.Fingerprint(),
    }
    ptmData, _ := m.ExportBinary()
    os.WriteFile("secret.ptm", ptmData, 0600)
}
```
