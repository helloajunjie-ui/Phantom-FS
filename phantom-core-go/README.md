# 👻 Phantom-CLI：重装步兵

> **定位：生产与自动化**
> "极速榨干 CPU，深夜替你切碎机密文件扬到云端。"

---

## 概述

Phantom-CLI 是 Phantom-FS 双端矩阵中的**重装步兵**——一个纯粹的、几 MB 的命令行二进制文件。

它的使命是**生产**：用最快的速度把海量文件加密、分片、分发到云端。你可以把它挂在 NAS 上、写进 Crontab 定时任务里，每天半夜自动处理几十 GB 的机密数据。

### 核心特性

| 特性 | 描述 |
|------|------|
| ⚡ **极速加密** | Goroutine 并发 + AES-NI 硬件加速，榨干 CPU |
| 📦 **单二进制分发** | 静态编译，零运行时依赖，丢到任何服务器就能跑 |
| 🤖 **可自动化** | 纯 CLI 设计，可嵌入 Shell 脚本、Crontab、CI/CD |
| 🔒 **零信任架构** | 加密分片可存于任何位置，无 Manifest 则无法解密 |
| 🔄 **跨语言互操作** | 与 Phantom-Web (JS) 相同输入 → 相同输出 |

### 劣势

你不能指望在外网借来的电脑上，或者用 iPhone 时，敲命令行去解密看个视频。\
**那是 Phantom-Web 的事。**

---

## 安装

```bash
# 编译
cd phantom-core-go
go build -o phantom-cli ./cmd/phantom-cli

# 或直接安装
go install ./cmd/phantom-cli
```

## 快速开始

```bash
# 加密文件（生成 .ptm 图纸 + 加密分片）
./phantom-cli encrypt -p "your-password" secret.pdf

# 解密文件（需要 .ptm 图纸 + 密码）
./phantom-cli decrypt -p "your-password" secret.ptm

# 校验密码是否正确（无需解密数据）
./phantom-cli verify secret.ptm

# 查看 .ptm 图纸信息
./phantom-cli info secret.ptm
```

## 项目结构

```
phantom-core-go/
├── cmd/phantom-cli/main.go    # CLI 入口
├── pkg/
│   ├── cipher/                # 密码学核心 (PBKDF2 + AES-256-GCM)
│   ├── manifest/              # .ptm 二进制图纸格式
│   ├── pool/                  # 并发控制 (信号量 + 指数退避)
│   └── store/                 # 存储适配层 (Memory/LocalFile/HTTP)
├── go.mod / go.sum
└── docs/ (README, ARCHITECTURE, ENGINE_SPEC, API, CONTRIBUTING)
```

---

## 双端矩阵：重装步兵 vs 幽灵锁孔

```
┌─────────────────────────────────────────────────────────────┐
│                  Phantom-FS Ecosystem                        │
├──────────────────────────┬──────────────────────────────────┤
│  Phantom-CLI (Go)        │  Phantom-Web (JS)                │
│  「重装步兵」             │  「幽灵锁孔」                     │
│                          │                                  │
│  生产 & 自动化            │  消费 & 无门槛触达                │
│                          │                                  │
│  • 命令行二进制           │  • 纯静态 HTML                   │
│  • NAS / Crontab / CI    │  • 任何浏览器打开即用             │
│  • 几十 GB 海量加密       │  • 手机 / 借用的电脑都能跑        │
│  • 极速 AES 加密          │  • 扫码即解密                    │
└──────────────────────────┴──────────────────────────────────┘
```

### 终极场景

> 你在家里的服务器上用 Go 加密了一段绝密视频存在了 S3，然后把那张 1KB 的二维码图纸发给了你的合伙人。\
> 合伙人是个不懂技术的麻瓜，他手机上根本跑不了 Go CLI。\
> 这时候，他只需要用手机浏览器打开你的 `phantom.yourdomain.com`（纯 JS 网页），扫一下二维码，输入密码，视频直接在浏览器内存里解码播放。阅后即焚。

---

## 命令参考

```
phantom encrypt [选项] <文件>
  选项:
    -p, --password string    加密密码
    -o, --output string      输出目录 (默认: 当前目录)
    -c, --chunk-size int     分片大小 (默认: 5MB)
    --store string           存储后端: memory|local|http (默认: local)
    --store-dir string       本地存储目录 (默认: ./.phantom-fs)

phantom decrypt [选项] <文件.ptm>
phantom verify <文件.ptm>
phantom info <文件.ptm>
```

---

## 跨语言互操作

| 参数 | 规范 |
|------|------|
| 密钥派生 | PBKDF2, SHA-256, 600,000 次迭代 |
| 加密算法 | AES-256-GCM |
| IV 推导 | `baseIV[0:8] ++ (baseIV[8:12] XOR BigEndian(chunkIndex))` |
| AAD | `"chunk_{index}"` (UTF-8) |
| Manifest | 二进制 `.ptm` 格式 (56-byte 固定头) |

**保证：相同 password + salt + baseIV + chunkIndex → Go 与 JS 产出完全相同密文。**

---

## 许可证

MIT License
