# 👻 Phantom-Web：幽灵锁孔

> **定位：消费与无门槛触达**
> "任何浏览器打开即用，扫码即解密，阅后即焚。"

---

## 概述

Phantom-Web 是 Phantom-FS 双端矩阵中的**幽灵锁孔**——一个不需要安装、只需要浏览器的纯静态 HTML 网页。

它的使命是**消费**：让任何人——哪怕是不懂技术的麻瓜——在任何设备上（手机、借来的电脑、网吧）都能零门槛解密查看加密数据。你可以把它挂在任何免费的静态托管服务上（GitHub Pages、Vercel、Netlify），一个 URL 走天下。

### 核心特性

| 特性 | 描述 |
|------|------|
| 🕸️ **零安装** | 纯静态 HTML，任何浏览器打开即用 |
| 📱 **全平台** | 手机 / 平板 / 电脑，无需安装任何软件 |
| 📷 **扫码解密** | Manifest 编码为 QR Code，扫一下即解密 |
| 🔒 **零信任架构** | 所有加解密在浏览器内存中完成，服务端无法作恶 |
| 🎯 **毫秒级 Seek** | 加密视频 O(1) 拖拽播放，无需从头解密 |
| 🕸️ **零依赖** | 仅调用 `window.crypto.subtle`，单 HTML 文件交付 |

### 劣势

加密速度受限于浏览器 JS 引擎，不适合处理几十 GB 的海量文件。\
**那是 Phantom-CLI 的事。**

---

## 快速开始

```bash
cd phantom-web
npx serve .
# 浏览器打开 http://localhost:3000
```

## 项目结构

```
phantom-web/
├── index.html              # 单页应用入口
├── src/
│   ├── core/
│   │   ├── phantom-cipher.js   # 密码学核心引擎
│   │   ├── key-derivation.js   # 密钥派生与指纹比对
│   │   └── manifest.js         # Manifest 序列化（JSON + 二进制 .ptm）
│   ├── storage/
│   │   ├── cloud-store.js      # 存储适配层（IStorageProvider）
│   │   └── qr-code.js          # QR Code 编码/解码
│   ├── ui/
│   │   ├── app.js              # 主应用逻辑
│   │   └── styles/
│   │       └── phantom.css     # 暗色主题样式
│   └── utils/
│       ├── pool.js             # 并发控制池
│       └── memory.js           # 安全内存管理
└── tests/
```

---

## 双端矩阵：幽灵锁孔 vs 重装步兵

```
┌─────────────────────────────────────────────────────────────┐
│                  Phantom-FS Ecosystem                        │
├──────────────────────────┬──────────────────────────────────┤
│  Phantom-Web (JS)        │  Phantom-CLI (Go)                │
│  「幽灵锁孔」             │  「重装步兵」                     │
│                          │                                  │
│  消费 & 无门槛触达        │  生产 & 自动化                    │
│                          │                                  │
│  • 纯静态 HTML           │  • 命令行二进制                   │
│  • 任何浏览器打开即用     │  • NAS / Crontab / CI            │
│  • 手机 / 借用的电脑     │  • 几十 GB 海量加密               │
│  • 扫码即解密            │  • 极速 AES 加密                  │
└──────────────────────────┴──────────────────────────────────┘
```

### 终极场景

> 你在家里的服务器上用 Go 加密了一段绝密视频存在了 S3，然后把那张 1KB 的二维码图纸发给了你的合伙人。\
> 合伙人是个不懂技术的麻瓜，他手机上根本跑不了 Go CLI。\
> 这时候，他只需要用手机浏览器打开你的 `phantom.yourdomain.com`（纯 JS 网页），扫一下二维码，输入密码，视频直接在浏览器内存里解码播放。阅后即焚。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 密码学 | `Web Crypto API` (`window.crypto.subtle`) |
| 密钥派生 | PBKDF2 (SHA-256, 600,000 次迭代) |
| Manifest | JSON / 二进制 `.ptm` 双模 |
| QR Code | `qrcode.js` (CDN) |
| 存储适配 | `IStorageProvider` 接口 |
| UI | 原生 DOM + CSS3 |

---

## 跨语言互操作

Phantom-Web (JS) 与 Phantom-CLI (Go) 共享同一套密码学协议：

**相同 password + salt + baseIV + chunkIndex → JS 与 Go 产出完全相同密文，可互相解密。**

---

## 许可证

MIT License
