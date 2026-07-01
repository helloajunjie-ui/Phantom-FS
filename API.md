# 📡 Phantom-FS API 设计文档

> 版本: V12.1-Phantom | 双端: Go + JS

---

## 01. 密码学 API

### Go (`pkg/cipher`)

```go
// 创建密码学引擎
func NewCipher(password string, salt []byte) (*PhantomCipher, error)

// 加密单个分片
func (c *PhantomCipher) EncryptChunk(plaintext []byte, chunkIndex uint32) ([]byte, error)

// 解密单个分片
func (c *PhantomCipher) DecryptChunk(data []byte, chunkIndex uint32) ([]byte, error)

// 获取密钥指纹
func (c *PhantomCipher) Fingerprint() []byte

// 快速校验密码
func VerifyPassword(password string, salt, expectedFingerprint []byte) bool

// 设置基础 IV
func (c *PhantomCipher) SetBaseIV(iv []byte)

// 安全销毁
func (c *PhantomCipher) Destroy()
```

### JS (`src/core/phantom-cipher.js`)

```javascript
// 加密单个分片
async function encryptChunk(chunkBuffer, key, baseIV, chunkIndex)

// 解密单个分片
async function decryptChunk(encryptedBuffer, key, baseIV, chunkIndex)

// 全文件加密
async function encryptFile(file, password, options)

// 全文件解密
async function decryptFile(manifest, password, fileId, options)

// 流式解密单个分片
async function streamChunk(manifest, password, fileId, chunkIndex, storage)

// 生成文件标识
function generateFileId()
```

### JS (`src/core/key-derivation.js`)

```javascript
// 派生 AES-GCM 密钥
async function deriveKey(password, salt)

// 提取密钥指纹
async function extractFingerprint(key)

// 常量时间指纹比对
function compareFingerprint(a, b)

// 快速校验密码
async function verifyPassword(password, salt, expectedFingerprint)
```

---

## 02. Manifest API

### Go (`pkg/manifest`)

```go
// 导出二进制 .ptm
func (m *Manifest) ExportBinary() ([]byte, error)

// 导入二进制 .ptm
func ImportBinary(data []byte) (*Manifest, error)

// 启发式检测是否为 .ptm 格式
func IsBinaryManifest(data []byte) bool

// 字段校验
func (m *Manifest) Validate() error

// Base64 编码（带 PTM: 前缀）
func BinaryManifestToBase64(data []byte) string

// Base64 解码
func Base64ToArrayBuffer(ptmBase64 string) ([]byte, error)
```

### JS (`src/core/manifest.js`)

```javascript
// 构建 Manifest 对象
function buildManifest(fileName, fileSize, salt, baseIV, fingerprint, chunkSize)

// 解析 Manifest（自动检测 JSON / .ptm）
function parseManifestAuto(data)

// 导出二进制 .ptm
function exportBinaryManifest(manifest)

// 导入二进制 .ptm
function importBinaryManifest(buffer)

// 检测是否为二进制 .ptm
function isBinaryManifest(data)

// Base64 编码/解码
function binaryManifestToBase64(buffer)
function base64ToArrayBuffer(base64)

// 估算 Manifest 体积
function estimateManifestSize(manifest)
```

---

## 03. 存储适配器 API

### Go (`pkg/store`)

```go
type Provider interface {
    PutChunk(ctx context.Context, chunkID string, data []byte) (string, error)
    GetChunk(ctx context.Context, chunkID string, rng *Range) ([]byte, error)
    DeleteFile(ctx context.Context, fileID string) error
    GetChunkURL(ctx context.Context, chunkID string) (string, error)
}

type Range struct {
    Start int64
    End   int64  // exclusive
}

// 实现
func NewMemoryProvider() *MemoryProvider
func NewLocalFileProvider(baseDir string) *LocalFileProvider
func NewHTTPProvider(baseURL string) *HTTPProvider
```

### JS (`src/storage/cloud-store.js`)

```javascript
class IStorageProvider {
    async putChunk(chunkId, data)       // → string (ETag)
    async getChunk(chunkId, range?)     // → ArrayBuffer
    async deleteFile(fileId)            // → void
    getChunkURL(chunkId)                // → string | null
}

// 工厂函数
function createProvider(type, options)

// 类型常量
const ProviderType = {
    MEMORY: 'memory',
    HTTP: 'http',
    S3: 's3',
    WEBDAV: 'webdav',
    OPFS: 'opfs',
    LOCAL: 'local'
}
```

### Provider 配置参数

| Provider | 参数 | 类型 | 说明 |
|----------|------|------|------|
| `memory` | — | — | 纯内存，无需配置 |
| `http` | `baseURL` | string | HTTP 服务器地址 |
| | `auth` | string | Basic Auth (可选) |
| `s3` | `bucket` | string | S3 存储桶名称 |
| | `region` | string | 区域 (如 `us-east-1`) |
| | `accessKeyId` | string | 访问密钥 ID |
| | `secretAccessKey` | string | 秘密访问密钥 |
| | `endpoint` | string | 自定义端点 (可选，用于兼容 S3 的服务) |
| `webdav` | `baseURL` | string | WebDAV 服务器地址 |
| | `username` | string | 用户名 |
| | `password` | string | 密码 |
| `opfs` | — | — | 浏览器 OPFS，无需配置 |
| `local` | — | — | 浏览器 `showDirectoryPicker`，无需配置 |

---

## 04. 凭证保险库 API

### JS (`src/storage/credential-vault.js`)

```javascript
class CredentialVault {
    constructor(storageKey)

    // 解锁保险库（派生加密密钥）
    async unlock(masterPassword)

    // 锁定保险库（清除内存中的密钥）
    lock()

    // 存储凭证
    async setCredentials(providerId, credentials)

    // 获取凭证
    getCredentials(providerId)

    // 删除凭证
    async removeCredentials(providerId)

    // 清空所有凭证
    async clearAll()

    // 获取剩余锁定时间
    getRemainingTime()
}
```

**安全特性**:
- AES-256-GCM 加密存储于 `localStorage`
- PBKDF2 600,000 次迭代派生加密密钥
- 24 小时自动锁定 TTL
- 锁定后清除内存中的加密密钥

---

## 05. 邮箱打包 API

### JS (`src/storage/phantom-pack.js`)

```javascript
// 打包 Manifest + Chunks 为 .phantom 文件
function packPhantom(manifestData, chunks)

// 解包 .phantom 文件
function unpackPhantom(buf)

// 检测是否为 .phantom 格式
function isPhantomPack(buf)
```

**`.phantom` 格式**:
```
Magic:  "PHNT" (4 bytes, UTF-8)
Version: uint32 LE (4 bytes)
ManifestLen: uint32 LE (4 bytes)
ManifestData: [ManifestLen]bytes
ChunksCount: uint32 LE (4 bytes)
[Chunks]:
  ChunkIDLen: uint32 LE
  ChunkID: [ChunkIDLen]bytes
  ChunkDataLen: uint32 LE
  ChunkData: [ChunkDataLen]bytes
```

---

## 06. QR Code API

### JS (`src/storage/qr-code.js`)

```javascript
class QRCodeEncoder {
    // 将 Manifest 编码为 QR Code
    async encode(manifest)

    // 从图片/Canvas 解码 QR Code
    async decode(imageData)
}
```

---

## 07. 并发控制 API

### Go (`pkg/pool`)

```go
func New(maxConcurrency, maxRetries int) *Pool
func (p *Pool) Add(task func(ctx context.Context) error)
func (p *Pool) WaitAll() []error
func (p *Pool) Stop()
```

### JS (`src/utils/pool.js`)

```javascript
class ConcurrencyPool {
    constructor(maxConcurrency, maxRetries)

    async add(task)
    async waitAll()
    getProgress()
}
```

---

## 08. 安全内存 API

### JS (`src/utils/memory.js`)

```javascript
// 安全清零 ArrayBuffer
function secureZero(buffer)

// 自动管理密钥生命周期
async function withSecureKey(key, fn)
```

---

## 09. CLI 命令参考

### encrypt

```bash
phantom encrypt [选项] <文件>

选项:
  -p, --password string     加密密码
  -o, --output string       输出目录 (默认: 当前目录)
  -c, --chunk-size int      分片大小，单位 bytes (默认: 5242880 = 5MB)
  --store string            存储后端: memory|local|http (默认: local)
  --store-dir string        本地存储目录 (默认: ./.phantom-fs)

输出:
  {filename}_phantom/
  ├── blueprint.ptm          # 二进制图纸
  └── chunks/                # 加密分片
      └── {fileId}/
          ├── 00000000.chk
          ├── 00000001.chk
          └── ...
```

### decrypt

```bash
phantom decrypt [选项] <文件.ptm>

选项:
  -p, --password string     解密密码
  -o, --output string       输出目录 (默认: 当前目录)
  --store string            存储后端: memory|local|http (默认: local)
  --store-dir string        分片存储目录 (默认: 自动推断)
```

### verify

```bash
phantom verify <文件.ptm>
# 校验密码是否正确，无需解密数据
```

### info

```bash
phantom info <文件.ptm>
# 查看 .ptm 图纸信息
```

---

## 10. 错误码

| 错误 | 原因 | 处理 |
|------|------|------|
| `ERR_INVALID_PASSWORD` | 密码错误 | 提示重新输入 |
| `ERR_MANIFEST_CORRUPTED` | .ptm 文件损坏 | 重新获取图纸 |
| `ERR_CHUNK_NOT_FOUND` | 分片不存在 | 检查存储后端配置 |
| `ERR_CHUNK_TAMPERED` | 分片被篡改 (GCM 验证失败) | 数据不可信，丢弃 |
| `ERR_NETWORK` | 网络错误 | 重试 |
| `ERR_STORE_CONFIG` | 存储配置错误 | 检查 Provider 参数 |
| `ERR_FILE_TOO_LARGE` | 文件超过 256TB | 不支持 |
| `ERR_VAULT_LOCKED` | 凭证保险库已锁定 | 重新解锁 |
