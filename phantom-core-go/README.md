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

## 许可证

MIT License
