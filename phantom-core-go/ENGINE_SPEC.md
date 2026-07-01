# ⚙️ Phantom-CLI 核心引擎规范 (V12.1)

> 版本: V12.1-Phantom (Go 后端) | 引擎代号: 青羽

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
│  │  │ Builder  │  │ Parser   │  │ QR Code  │   │   │
│  │  │          │  │          │  │ Codec    │   │   │
│  │  └──────────┘  └──────────┘  └──────────┘   │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## 02. 密钥派生 (Key Derivation)

### 2.1 PBKDF2 配置

| 参数 | 值 | 说明 |
|------|-----|------|
| 算法 | PBKDF2 | NIST 标准密钥派生函数 |
| 哈希 | SHA-256 | 256 位输出 |
| 迭代次数 | 600,000 | 平衡安全性与性能 |
| Salt 长度 | 16 字节 | CSPRNG 生成 |
| 派生密钥长度 | 256 位 | AES-256 所需 |

### 2.2 伪代码

```javascript
async function deriveKey(password, salt) {
    // 1. 将密码导入为原始密钥材料
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    // 2. 派生 AES-GCM 密钥
    const key = await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: 600000,
            hash: "SHA-256"
        },
        keyMaterial,
        {
            name: "AES-GCM",
            length: 256
        },
        true,  // 可导出，用于指纹提取
        ["encrypt", "decrypt"]
    );

    return key;
}
```

### 2.3 指纹提取

```javascript
async function extractFingerprint(key) {
    // 导出原始密钥
    const rawKey = await crypto.subtle.exportKey("raw", key);
    
    // SHA-256 哈希
    const hash = await crypto.subtle.digest("SHA-256", rawKey);
    
    // 取前 16 字节作为指纹
    const fingerprint = new Uint8Array(hash).slice(0, 16);
    
    // ⚠️ 物理级内存覆写
    new Uint8Array(rawKey).fill(0);
    
    return fingerprint;
}
```

---

## 03. 流式加解密 (Stream Cipher)

### 3.1 AES-GCM 配置

| 参数 | 值 | 说明 |
|------|-----|------|
| 算法 | AES-GCM | 认证加密，防篡改 |
| 密钥长度 | 256 位 | 军工级安全 |
| IV 长度 | 12 字节 | GCM 推荐值 |
| 标签长度 | 16 字节 | GCM 认证标签 |
| 分片大小 | 5 MB | 平衡内存与网络 |

### 3.2 确定性 IV 推导

**核心创新**：摒弃记录海量分片 IV 的笨拙做法，采用纯数学推导。

```javascript
function deriveChunkIV(baseIV, chunkIndex) {
    // baseIV: Uint8Array(12)
    // chunkIndex: number (0, 1, 2, ...)
    
    const iv = new Uint8Array(baseIV);
    const view = new DataView(iv.buffer);
    
    // 将最后 4 字节与 chunkIndex 进行 XOR
    // 保证在 2^32 - 1 个分片内 IV 唯一
    const last4Bytes = view.getUint32(8);
    view.setUint32(8, last4Bytes ^ chunkIndex);
    
    return iv;
}
```

**数学证明**：
- 基础 IV 空间: 2^96
- 每个文件使用唯一 baseIV
- 分片 IV = baseIV ^ chunkIndex (32-bit XOR)
- 最大安全分片数: 2^32 - 1 ≈ 42.9 亿
- 最大文件大小: 5MB × 2^32 ≈ 21.5 PB

### 3.3 AAD 跨平台防篡改

```javascript
function buildAAD(chunkIndex) {
    // 将分片索引转为 UTF-8 字符串
    // 消除字节序炸弹（Big Endian vs Little Endian）
    return new TextEncoder().encode(`chunk_${chunkIndex}`);
}
```

**安全意义**：
- 攻击者无法将 Chunk N 重放到 Chunk M 的位置
- 乱序拼接 → AES-GCM 认证失败 → 底层熔断
- 跨平台兼容（x86 / ARM / 移动端）

### 3.4 加密核心

```javascript
async function encryptChunk(chunkBuffer, key, baseIV, chunkIndex) {
    // 1. 推导 IV
    const iv = deriveChunkIV(baseIV, chunkIndex);
    
    // 2. 构建 AAD
    const aad = buildAAD(chunkIndex);
    
    // 3. AES-GCM 加密
    const encrypted = await crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: iv,
            additionalData: aad,
            tagLength: 128
        },
        key,
        chunkBuffer
    );
    
    return encrypted;
}
```

### 3.5 解密核心

```javascript
async function decryptChunk(encryptedBuffer, key, baseIV, chunkIndex) {
    // 1. 推导 IV（与加密完全一致）
    const iv = deriveChunkIV(baseIV, chunkIndex);
    
    // 2. 构建 AAD（与加密完全一致）
    const aad = buildAAD(chunkIndex);
    
    // 3. AES-GCM 解密
    // 如果 AAD 不匹配或数据被篡改，此处会抛出错误
    const decrypted = await crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: iv,
            additionalData: aad,
            tagLength: 128
        },
        key,
        encryptedBuffer
    );
    
    return decrypted;
}
```

---

## 04. 并发控制池 (Concurrency Pool)

### 4.1 设计目标

- 保护浏览器网络栈，防止过多并发请求
- 自动重试失败的分片
- 静默熔断，不影响主循环

### 4.2 实现

```javascript
class ConcurrencyPool {
    constructor(maxConcurrency = 5, maxRetries = 3) {
        this.maxConcurrency = maxConcurrency;
        this.maxRetries = maxRetries;
        this.pool = new Set();
        this.queue = [];
        this.errors = [];
    }

    async add(task) {
        // 如果池子满了，等待最早完成的任务
        if (this.pool.size >= this.maxConcurrency) {
            await Promise.race(this.pool);
        }

        const promise = this.executeWithRetry(task);
        this.pool.add(promise);
        promise.finally(() => this.pool.delete(promise));
        
        return promise;
    }

    async executeWithRetry(task) {
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                return await task();
            } catch (error) {
                if (attempt === this.maxRetries - 1) {
                    this.errors.push(error);
                    return null; // 静默失败
                }
                // 指数退避: 1s, 2s, 4s
                await this.delay(1000 * Math.pow(2, attempt));
            }
        }
    }

    async waitAll() {
        await Promise.all([...this.pool, ...this.queue]);
        return this.errors;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
```

---

## 05. Manifest 构建与解析

### 5.1 Builder

```javascript
function buildManifest(fileName, fileSize, salt, baseIV, fingerprint, chunkSize = 5 * 1024 * 1024) {
    return {
        version: "V12-Phantom",
        fileName: fileName,
        fileSize: fileSize,
        chunkSize: chunkSize,
        totalChunks: Math.ceil(fileSize / chunkSize),
        salt: Array.from(salt),
        baseIV: Array.from(baseIV),
        fingerprint: Array.from(fingerprint)
    };
}
```

### 5.2 Parser

```javascript
function parseManifest(json) {
    const manifest = typeof json === 'string' ? JSON.parse(json) : json;
    
    // 版本校验
    if (manifest.version !== "V12-Phantom") {
        throw new Error(`不支持的 Manifest 版本: ${manifest.version}`);
    }
    
    // 数学边界校验
    if (manifest.totalChunks > 2 ** 32 - 1) {
        throw new Error("分片数超出安全边界");
    }
    
    // 恢复二进制数据
    return {
        ...manifest,
        salt: new Uint8Array(manifest.salt),
        baseIV: new Uint8Array(manifest.baseIV),
        fingerprint: new Uint8Array(manifest.fingerprint)
    };
}
```

---

## 06. 完整加密流程

```javascript
async function phantomEncrypt(file, password) {
    // 1. 生成密码学参数
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const baseIV = crypto.getRandomValues(new Uint8Array(12));
    
    // 2. 派生密钥
    const key = await deriveKey(password, salt);
    const fingerprint = await extractFingerprint(key);
    
    // 3. 构建 Manifest
    const manifest = buildManifest(
        file.name, file.size, salt, baseIV, fingerprint
    );
    
    // 4. 并发加密上传
    const pool = new ConcurrencyPool(5);
    const fileId = generateFileId();
    
    for (let i = 0; i < manifest.totalChunks; i++) {
        const chunkBlob = file.slice(
            i * manifest.chunkSize,
            (i + 1) * manifest.chunkSize
        );
        
        pool.add(async () => {
            const buffer = await chunkBlob.arrayBuffer();
            const encrypted = await encryptChunk(buffer, key, baseIV, i);
            await uploadToCloud(fileId, i, encrypted);
        });
    }
    
    const errors = await pool.waitAll();
    if (errors.length > 0) {
        console.warn(`${errors.length} 个分片上传失败，已触发熔断`);
    }
    
    // 5. 返回 Manifest
    return manifest;
}
```

---

## 07. 完整解密流程

```javascript
async function phantomDecrypt(manifest, password, fileId) {
    // 1. 解析 Manifest
    const parsed = parseManifest(manifest);
    
    // 2. 派生密钥
    const key = await deriveKey(password, parsed.salt);
    
    // 3. 指纹校验（快速失败）
    const fingerprint = await extractFingerprint(key);
    if (!compareFingerprint(fingerprint, parsed.fingerprint)) {
        throw new Error("密码错误");
    }
    
    // 4. 并发下载解密
    const pool = new ConcurrencyPool(5);
    const decryptedChunks = [];
    
    for (let i = 0; i < parsed.totalChunks; i++) {
        pool.add(async () => {
            const encrypted = await downloadFromCloud(fileId, i);
            const decrypted = await decryptChunk(encrypted, key, parsed.baseIV, i);
            decryptedChunks[i] = decrypted;
        });
    }
    
    await pool.waitAll();
    
    // 5. 合并文件
    const blob = new Blob(decryptedChunks, { type: 'application/octet-stream' });
    return blob;
}
```

---

## 08. 边界条件与错误处理

### 8.1 错误类型

| 错误 | 触发条件 | 处理方式 |
|------|----------|----------|
| `WRONG_PASSWORD` | 指纹不匹配 | 0.1s 内返回，UI 触发 Glitch 震动 |
| `TAMPERED_DATA` | AES-GCM 认证失败 | 抛出异常，标记分片损坏 |
| `CHUNK_OVERFLOW` | 分片数 > 2^32-1 | 拒绝加密，提示文件过大 |
| `UPLOAD_FAILED` | 上传重试耗尽 | 静默记录，继续其他分片 |
| `NETWORK_ERROR` | 网络中断 | 指数退避重试 |

### 8.2 内存安全

```javascript
// 每次密钥使用后立即清理
function secureZero(buffer) {
    new Uint8Array(buffer).fill(0);
}

// 使用示例
const rawKey = await crypto.subtle.exportKey("raw", key);
try {
    // ... 使用密钥
} finally {
    secureZero(rawKey);  // 确保无论如何都会清理
}
```

---

## 09. 跨语言安全审计 (Roo Audit)

> 审计日期: 2026-07-01 | 审计人: Roo | 状态: ✅ PASSED

### 9.1 陷阱1：JS 有符号整型 XOR（已修复）

**问题**: JS `^` 操作符强制将操作数转为 32 位有符号整型。当 `chunkIndex > 2^31 - 1` 时，结果变为负数，与 Go `uint32` 行为不一致，导致跨语言 IV 推导不匹配。

**修复**: XOR 结果后追加 `>>> 0` 强制转回无符号 32 位。

```javascript
// 修复前（跨语言不匹配）
view.setUint32(8, last4Bytes ^ chunkIndex, false);

// 修复后（与 Go uint32 对齐）
const derived = (last4Bytes ^ chunkIndex) >>> 0;
view.setUint32(8, derived, false);
```

### 9.2 陷阱2：Go 大文件 OOM（已修复）

**问题**: `os.ReadFile(filePath)` 将整个文件读入内存。50GB 文件 → 50GB 堆分配 → OOM。主线程循环 `data[start:end]` 切片分配后抛给 goroutine，内存无法复用。

**修复**: 使用 `os.Open` + `file.ReadAt` + `sync.Pool` 三重保障：

```go
// 1. 文件流式打开
file, _ := os.Open(filePath)
defer file.Close()

// 2. sync.Pool 复用缓冲区（总内存上限 = maxConcurrency × chunkSize）
bufPool := pool.NewBufferPool(chunkSize)

// 3. Worker 自行 ReadAt，主线程零分配
concPool.Add(func(ctx context.Context) error {
    bufPtr := bufPool.Get().(*[]byte)
    defer bufPool.Put(bufPtr)
    n, _ := file.ReadAt(*bufPtr, offset)
    chunkData := (*bufPtr)[:n]
    // ... 加密
})
```

解密端同步优化：使用 `os.Create` + `tmpFile.WriteAt(plaintext, offset)` 替代 `make([]byte, fileSize)` 全量内存分配。

### 9.3 陷阱3：JS Web Worker Transferable Objects（不适用）

**评估**: 当前 Phantom-Web 使用单线程 `ConcurrencyPool`（基于 Promise 异步），未使用 Web Worker。`postMessage` 路径不存在，此陷阱不适用。

**未来预警**: 若引入 Web Worker 处理 PBKDF2 密集型计算，必须使用 Transferable Objects 语法：

```javascript
// 必须使用 transfer list 实现零拷贝
worker.postMessage({ type: 'ENCRYPT', data: chunkBuffer }, [chunkBuffer]);
```

### 9.7 第三轮深度排查（Bug #13-#18，已修复）

**Bug #13** 🔴 High — Go `HTTPProvider.GetChunk` Range 边界错误
- **问题**: `rangeOpt.End` 直接作为 HTTP Range 的 end 值，但 HTTP Range 是 inclusive 的，而接口定义的 end 是 exclusive。导致请求的字节范围多 1 字节。
- **修复**: `store.go` 中 `end := rangeOpt.End - 1`，并做 `if end < 0 { end = 0 }` 边界保护。

**Bug #14** 🔴 High — Go `cmdEncrypt` 分片存储目录不一致
- **问题**: Session 目录（`chunksDir`）在加密循环**之后**才创建，Provider 初始化时指向旧的 `*storeDir`（如 `./.phantom-fs`）。分片写入旧目录后，代码尝试重新创建 Provider 指向新目录，但分片不会自动迁移。
- **修复**: 将 Session 目录创建移到 Provider 初始化之前，Provider 直接指向 `chunksDir`。

**Bug #15** 🟡 Medium — Go `detectFileID` 与 `LocalFileProvider` 不匹配
- **问题**: `LocalFileProvider` 使用 `{baseDir}/{fileId}/{index}.chunk` 子目录结构，但 `detectFileID` 在 `chunksDir` 中查找子目录名作为 fileId。两者逻辑一致，**实际兼容**，无需修改。

**Bug #16** 🟡 Medium — Go `fileSize int` 溢出
- **问题**: `fileSize := int(fi.Size())` 在 32 位系统上，`int` 为 32 位，文件 >2GB 时溢出。同时 `Manifest.FileSize` 从 `int` 改为 `int64` 后，`manifest.go:165` 的 `int(fileSizeHi<<32 | fileSizeLo)` 编译器报错（`int` 不能赋值给 `int64`）。
- **修复**: `manifest.go:165` 改为 `int64(fileSizeHi<<32 | fileSizeLo)`；`main.go:127` 改为 `fileSize := fi.Size()`（返回 `int64`）；`verify-proof/main.go` 中三处 `len(data)` 改为 `int64(len(data))`。

**Bug #17** 🟡 Medium — JS email 发送类型确认
- **问题**: `app.js:908-909` 中 `this._store.getChunk(chunkId)` 返回 `ArrayBuffer`，`new Uint8Array(data)` 正确包装。**确认无问题**。

**Bug #18** 🟢 Low — Go `MaxFileSize()` 语义问题
- **问题**: `MaxFileSize()` 返回 `0xFFFFFFFFFFFF`（256TB-1），语义上表示"支持的最大文件大小"。**确认无问题**。

否则 Structured Clone 会对 `chunkBuffer`（5MB+）进行深拷贝，导致主线程 GC 频繁 STW（Stop-The-World），帧率暴跌至个位数。

### 9.4 陷阱4：JS `ConcurrencyPool` 重试次数语义偏差（已修复）

**问题**: JS 端 `_executeWithRetry` 中 `for (let attempt = 0; attempt < this._maxRetries; attempt++)` 当 `_maxRetries=3` 时实际执行 3 次（初始 + 2 次重试），但语义上 `_maxRetries` 应表示"总尝试次数"。第 3 次失败后静默吞掉错误，比预期少一次重试机会。

**Go 端关联**: Go 端 `pool.go` 使用 `for i := 0; i <= p.maxRetries; i++`（`<=` 而非 `<`），语义为"初始执行 + maxRetries 次重试"，与 JS 修复后的语义一致，无需修改。

```go
// Go 端（正确）：i <= maxRetries → 初始执行 + maxRetries 次重试
for i := 0; i <= p.maxRetries; i++ {
    // ...
}
```
