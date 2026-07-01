# Changelog

## V1.0.0 (2026-07-01)

### 🎉 初始发布

Phantom-FS 零信任无服务器流式加密系统正式版。

#### 核心架构

- **Phantom-Web (JS)**: 浏览器端 AES-256-GCM 加密/解密 + BYOS 6 种存储适配器
- **Phantom-Core-Go (Go)**: 系统级 CLI 加密工具，跨语言互操作

#### 密码学协议

- PBKDF2 600,000 次迭代, SHA-256, 256-bit 密钥
- AES-256-GCM 认证加密, 确定性 IV 推导 (Big Endian)
- AAD 防篡改标签 + 指纹验证
- 跨语言 (Go/JS) 字节序对齐

#### 存储层 (BYOS)

- MemoryProvider / HTTPProvider / S3Provider / WebDAVProvider
- FileSystemProvider (OPFS) / LocalFileProvider (showDirectoryPicker)
- CredentialVault: AES-GCM 加密 localStorage, 24h TTL
- Email 推送: phantom-pack 打包 + EmailJS 发送

#### 三轮深度排查

- 18 个 Bug 全部修复（5 🔴 High, 9 🟡 Medium, 2 🟢 Low, 2 确认无问题）
- verify-proof 16/16 全部通过
- Go 编译零错误
