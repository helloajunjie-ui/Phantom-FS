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

### `encrypt` — 加密文件

```
phantom encrypt [选项] <文件>
```

将文件加密分片，生成 BYOS Session 文件夹：

```
输出目录/
├── {文件名}_phantom/          ← Session 目录
│   ├── blueprint.ptm          ← 图纸（单独保管）
│   └── chunks/
│       └── {fileId}/
│           ├── 00000000.chk   ← 加密分片
│           ├── 00000001.chk
│           └── ...
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-p`, `--password` | `""`（交互输入） | 加密密码。未提供则终端提示输入 |
| `-o`, `--output` | `"."`（当前目录） | Session 目录的父目录 |
| `-c`, `--chunk-size` | `5242880` (5MB) | 每分片字节数。增大可减少分片数但增加单次内存 |
| `--store` | `"local"` | 存储后端：`local`（本地磁盘）、`memory`（内存，仅测试）、`http`（HTTP PUT/GET） |
| `--store-dir` | `"./.phantom-fs"` | 仅 `http` 后端使用，作为 URL 前缀 |

**示例**：
```bash
# 基本加密（输出到当前目录）
phantom-cli encrypt -p "MySecret" secret.pdf

# 指定输出目录和分片大小
phantom-cli encrypt -p "MySecret" -o /backup -c 10485760 large_video.mp4

# 使用 HTTP 存储后端
phantom-cli encrypt -p "MySecret" --store http --store-dir "https://example.com/api/chunks" secret.pdf
```

---

### `decrypt` — 解密文件

```
phantom decrypt [选项] <文件.ptm>
```

读取 `.ptm` 图纸，从存储后端下载分片并解密还原文件。

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-p`, `--password` | `""`（交互输入） | 解密密码。未提供则终端提示输入 |
| `-o`, `--output` | `"."`（当前目录） | 解密文件的输出目录 |
| `--store` | `"local"` | 存储后端：`local`、`memory`、`http` |
| `--store-dir` | `""`（自动推断） | 分片存储目录。默认自动推断：若 `.ptm` 在 `xxx_phantom/` 目录中，则同级 `chunks/` 为分片目录；否则尝试查找同级 `chunks/`；都找不到则回退 `./.phantom-fs` |

**自动推断逻辑**：
1. 若 `.ptm` 在 `xxx_phantom/` Session 目录中 → `xxx_phantom/chunks/`
2. 若 `.ptm` 同级有 `chunks/` 目录 → 使用该目录
3. 否则 → `./.phantom-fs`

**示例**：
```bash
# 标准解密（.ptm 在 Session 目录中）
phantom-cli decrypt -p "MySecret" secret_phantom/blueprint.ptm

# 指定分片目录（分片在远程 HTTP 服务器）
phantom-cli decrypt -p "MySecret" --store http --store-dir "https://example.com/api/chunks" secret.ptm

# 指定输出路径
phantom-cli decrypt -p "MySecret" -o ~/Downloads secret.ptm
```

---

### `verify` — 校验密码

```
phantom verify <文件.ptm>
```

仅校验密码是否正确，**无需解密数据**。通过比对 `.ptm` 中的指纹（Fingerprint）验证。

| 参数 | 说明 |
|------|------|
| `<文件.ptm>` | 必填。`.ptm` 图纸文件路径 |

**示例**：
```bash
phantom-cli verify secret_phantom/blueprint.ptm
# 提示输入密码，输出 "✅ 密码正确" 或 "❌ 密码错误"
```

---

### `info` — 查看图纸信息

```
phantom info <文件.ptm>
```

解析并打印 `.ptm` 图纸的完整信息，包括文件名、大小、分片数、密码学参数等。

| 参数 | 说明 |
|------|------|
| `<文件.ptm>` | 必填。`.ptm` 图纸文件路径 |

**输出示例**：
```
📄 Phantom-FS .ptm 图纸信息
═══════════════════════════════
  版本:      V12.1-Phantom
  文件名:    secret.pdf
  文件大小:  10485760 bytes (10.00 MB)
  分片大小:  5242880 bytes (5.00 MB)
  分片数:    2
  Salt:      a1b2c3d4e5f6...
  BaseIV:    010203040506...
  指纹:      ffeeddccbbaa...
  图纸体积:  128 bytes (二进制 .ptm)
            (JSON 模式约 256 bytes, 压缩比 2.0x)
```

---

### `version` — 查看版本

```
phantom version
```

打印 CLI 版本号。

### `help` — 帮助

```
phantom help
phantom --help
phantom -h
```

打印使用帮助。

## 许可证

MIT License
