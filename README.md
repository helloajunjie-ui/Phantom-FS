# 👻 Phantom-FS

**零信任无服务器流式加密系统** — 存储与信任的彻底剥离。

> **English** · [中文](#phantom-fs-1)

[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](#)
[![Go](https://img.shields.io/badge/Go-1.26+-00ADD8?logo=go)](phantom-core-go/)
[![Web](https://img.shields.io/badge/Web-ES2020+-F7DF1E?logo=javascript)](phantom-web/)

---

## Phantom-FS

> *"你的数据无处不在，却又无迹可寻。除了你，连上帝都无法拼凑它的全貌。"*

在这个时代，把绝密数据交给任何云盘都意味着将刀柄递给他人。**我们不信任任何云，我们只信任数学。**

Phantom-FS 不是一个提供存储空间的网盘。它是一个存在于设备内存中的**赛博粉碎与重组引擎**——将机密文件切成高熵值的"加密碎沙"，散落在网络上。没有你的允许，这些数据在任何人眼里都只是毫无意义的电子白噪声。

### 核心特性

| 特性 | 描述 |
|------|------|
| **云端降维** | 加密碎片存于任何云盘，服务端无法知晓内容。即便被彻底脱库，泄露的也只是无法解密的废料 |
| **物理冷钱包** | 生成几 KB 的二维码图纸，可打印锁进保险箱。真正的数字资产物理隔离 |
| **O(1) 极速 Seek** | 50GB 加密视频随意拖拽，毫秒级定位解密。无需等待全量下载 |
| **阅后即焚** | 关闭瞬间内存物理覆写清零，拔网线即焚，不留残影 |
| **三重物理边界** | Chunks（加密碎沙）+ .ptm 图纸（藏宝图）+ 密码（脑中钥匙），缺一不可 |

### 双端矩阵

```
Phantom-FS
│
├── Phantom-CLI (Go)  ──  「重装步兵」
│   定位：生产 & 自动化
│   形态：几 MB 的命令行二进制文件
│   场景：NAS / Crontab / CI — 深夜自动加密几十 GB 文件扬到云端
│   劣势：不能在外网借来的电脑或手机上敲命令行
│   └── 进入 → phantom-core-go/
│
└── Phantom-Web (JS)  ──  「幽灵锁孔」
    定位：消费 & 无门槛触达
    形态：纯静态 HTML，任何浏览器打开即用
    场景：合伙人用手机浏览器扫二维码，输入密码，视频直接在内存解码播放
    劣势：JS 引擎加密速度有限，不适合海量文件
    └── 进入 → phantom-web/
```

### 快速导航

| 目录 | 角色 | 技术栈 | 启动方式 |
|------|------|--------|---------|
| [`phantom-web/`](phantom-web/) | 🕶️ 幽灵锁孔 | HTML5 + Web Crypto API | `npx serve .` |
| [`phantom-core-go/`](phantom-core-go/) | ⚔️ 重装步兵 | Go 1.26+ + `crypto/aes` | `go build ./cmd/phantom-cli` |

### 文档索引

| 文档 | 受众 | 用途 |
|------|------|------|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 架构师 / 技术选型 | 系统架构、数据流、安全模型 |
| [`ENGINE_SPEC.md`](ENGINE_SPEC.md) | 开发者 / 审计者 | 密码学协议、.ptm 格式、跨语言规范 |
| [`API.md`](API.md) | 集成开发者 | 接口定义、Provider 矩阵、错误码 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献者 | 开发环境、编码规范、PR 流程 |
| [`CHANGELOG.md`](CHANGELOG.md) | 所有人 | 版本发布记录 |
| [`SECURITY.md`](SECURITY.md) | 安全审计 | 安全模型与攻击路径推演 |

### 许可证

MIT License

---

## Phantom-FS

> *"Your data is everywhere, yet nowhere to be found. Not even God can piece it together without you."*

**The Ultimate Zero-Trust Cypher-Vault.** A serverless streaming encryption system that completely separates storage from trust.

### Core Capabilities

| Capability | Description |
|------------|-------------|
| **Cloud Degradation** | Encrypted chunks stored anywhere — the server has zero knowledge. Even a total breach yields only indecipherable garbage |
| **Physical Cold Wallet** | Generate a tiny QR code Manifest, print it, lock it in a bank vault. True physical isolation |
| **O(1) Streaming Seek** | Seek through a 50GB encrypted video in milliseconds. No full download needed |
| **Burn After Reading** | Memory is physically zeroed on close. Pull the plug and it's gone |
| **Triple Boundaries** | Chunks + .ptm Manifest + Password — all three required, physically separated |

### Dual-End Matrix

| End | Role | Stack | Start |
|-----|------|-------|-------|
| [`phantom-web/`](phantom-web/) | 👻 Ghost Keyhole | HTML5 + Web Crypto API | `npx serve .` |
| [`phantom-core-go/`](phantom-core-go/) | ⚔️ Heavy Infantry | Go 1.26+ + `crypto/aes` | `go build ./cmd/phantom-cli` |

### Docs

| Document | Audience |
|----------|----------|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Architects / Tech leads |
| [`ENGINE_SPEC.md`](ENGINE_SPEC.md) | Developers / Auditors |
| [`API.md`](API.md) | Integrators |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contributors |
| [`CHANGELOG.md`](CHANGELOG.md) | Everyone |
| [`SECURITY.md`](SECURITY.md) | Security auditors |

### License

MIT License
