# 🤝 Phantom-Web 开发指南

> 版本: V12.1-Phantom (JS 前端)

---

## 01. 开发环境

### 要求

- **浏览器**: Chrome 90+ / Firefox 90+ / Edge 90+（需支持 Web Crypto API）
- **编辑器**: VS Code（推荐）
- **构建工具**: 无（零构建，直接编辑 HTML/JS）

### 快速启动

```bash
# 克隆仓库
git clone https://github.com/your-org/phantom-fs.git
cd phantom-fs

# 使用任意静态服务器
npx serve .          # Node.js
python -m http.server 8000  # Python
# 或直接浏览器打开 index.html
```

---

## 02. 项目结构

```
phantom-fs/
│
├── index.html                  # 单页应用入口
├── README.md                   # 项目首页
├── ARCHITECTURE.md             # 架构设计文档
├── ENGINE_SPEC.md              # 核心引擎规范
├── API.md                      # API 设计文档
├── CONTRIBUTING.md             # 本文件
│
├── src/
│   ├── core/                   # 核心加密引擎
│   │   ├── phantom-cipher.js   # AES-GCM 流式加解密
│   │   ├── key-derivation.js   # PBKDF2 密钥派生
│   │   └── manifest.js         # Manifest 生成/解析
│   │
│   ├── storage/                # 存储适配层
│   │   ├── cloud-store.js      # 云端存储接口
│   │   └── qr-code.js          # QR Code 编码/解码
│   │
│   ├── ui/                     # 用户界面
│   │   ├── app.js              # 主应用逻辑
│   │   ├── components/         # UI 组件
│   │   └── styles/             # 样式
│   │
│   └── utils/                  # 工具函数
│       ├── pool.js             # 并发控制池
│       └── memory.js           # 内存安全清理
│
└── tests/                      # 测试
    ├── unit/
    └── integration/
```

---

## 03. 编码规范

### 3.1 JavaScript 风格

- **ES2020+**: 使用现代 JavaScript 语法
- **严格模式**: 所有文件以 `'use strict'` 开头
- **JSDoc**: 所有公开 API 必须包含 JSDoc 注释
- **命名规范**:
  - 类名: `PascalCase`
  - 函数/变量: `camelCase`
  - 常量: `UPPER_SNAKE_CASE`
  - 私有属性: `_prefix`

### 3.2 安全编码规则

```javascript
// ✅ 正确：使用后立即清理密钥
const rawKey = await crypto.subtle.exportKey("raw", key);
try {
    // 使用密钥
} finally {
    new Uint8Array(rawKey).fill(0);
}

// ❌ 错误：密钥残留在内存中
const rawKey = await crypto.subtle.exportKey("raw", key);
// 忘记清理
```

### 3.3 错误处理规范

```javascript
// ✅ 正确：使用 PhantomFSError
throw new PhantomFSError('WRONG_PASSWORD', '密码错误');

// ❌ 错误：使用普通 Error
throw new Error('密码错误');
```

---

## 04. 测试指南

### 4.1 单元测试

```javascript
// tests/unit/cipher.test.js
describe('Phantom Cipher Engine', () => {
    test('确定性 IV 推导', () => {
        const baseIV = new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12]);
        const iv0 = deriveChunkIV(baseIV, 0);
        const iv1 = deriveChunkIV(baseIV, 1);
        
        expect(iv0).not.toEqual(iv1);
        expect(iv0[8] ^ iv1[8]).toBe(1); // XOR 验证
    });
    
    test('AAD 防篡改', async () => {
        const encrypted = await encryptChunk(data, key, baseIV, 0);
        // 尝试用错误索引解密
        await expect(
            decryptChunk(encrypted, key, baseIV, 1)
        ).rejects.toThrow();
    });
});
```

### 4.2 集成测试

```javascript
// tests/integration/encrypt-decrypt.test.js
describe('Full Cycle', () => {
    test('加密后解密应得到原始数据', async () => {
        const file = new File(['Hello, Phantom-FS!'], 'test.txt');
        const password = 'test-password-123';
        
        const result = await PhantomFS.encrypt(file, password, {
            storage: new PhantomFS.MemoryStore()
        });
        
        const decrypted = await PhantomFS.decrypt(
            result.manifest, password, result.fileId,
            { storage: new PhantomFS.MemoryStore() }
        );
        
        const text = await decrypted.text();
        expect(text).toBe('Hello, Phantom-FS!');
    });
});
```

---

## 05. 性能基准

### 5.1 加密性能

| 文件大小 | 加密耗时 | 内存峰值 | 分片数 |
|----------|----------|----------|--------|
| 10 MB | ~200ms | ~15 MB | 2 |
| 100 MB | ~2s | ~50 MB | 20 |
| 1 GB | ~20s | ~80 MB | 200 |
| 10 GB | ~3.5min | ~100 MB | 2000 |

### 5.2 视频 Seek 性能

| 操作 | 延迟 | 说明 |
|------|------|------|
| 密码校验 | < 100ms | 指纹比对 |
| 分片定位 | O(1) | 数学计算 |
| 单分片解密 | < 50ms | 5MB AES-GCM |
| 网络传输 | 取决于带宽 | Range Request |

---

## 06. 发布流程

### 版本号规范

遵循 [SemVer](https://semver.org/)：

```
MAJOR.MINOR.PATCH
```

- `MAJOR`: 不兼容的 API 变更
- `MINOR`: 向后兼容的功能新增
- `PATCH`: 向后兼容的 bug 修复

### 发布步骤

1. 更新版本号（Manifest 中的 `version` 字段）
2. 运行完整测试套件
3. 更新 CHANGELOG.md
4. 创建 Git Tag
5. 发布 Release

---

## 07. 安全审计清单

每次提交前检查：

- [ ] 所有密钥使用后是否执行 `fill(0)` 内存覆写
- [ ] 所有 `crypto.subtle` 调用是否包含错误处理
- [ ] Manifest 是否包含版本号校验
- [ ] 分片索引是否在安全边界内（< 2^32）
- [ ] AAD 是否在所有加解密操作中一致
- [ ] 并发池是否设置了最大并发数
- [ ] 上传失败是否有重试机制
- [ ] QR Code 是否包含纠错码

---

## 08. FAQ

### Q: 为什么不用 Web Worker？
A: `crypto.subtle` 本身就是异步的，底层调用 C++ 线程池。Web Worker 反而会增加数据序列化开销。

### Q: 为什么分片大小是 5MB？
A: 平衡点：
- 太小（< 1MB）：HTTP 请求过多，TLS 握手开销大
- 太大（> 10MB）：内存峰值高，视频 Seek 粒度粗
- 5MB：Chrome 网络栈的 sweet spot

### Q: 如何支持更多存储后端？
A: 实现 `CloudStore` 接口即可。参考 `S3Store` 或 `LocalStore` 的实现。

### Q: 密码丢失怎么办？
A: 无法恢复。这是设计使然——零信任架构下，服务端没有任何恢复机制。建议用户将 Manifest QR Code 打印成纸质版保存。
