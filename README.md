# 👻 Phantom-FS

> **零信任无服务器流式加密系统**
>
> 存储与信任的彻底剥离 — 你的数据无处不在，却又无迹可寻。

---

## 双端矩阵

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

---

## 快速导航

| 目录 | 角色 | 技术栈 | 启动方式 |
|------|------|--------|---------|
| [`phantom-web/`](phantom-web/) | 🕶️ 幽灵锁孔 | HTML5 + Web Crypto API | `npx serve .` |
| [`phantom-core-go/`](phantom-core-go/) | ⚔️ 重装步兵 | Go 1.26 + `crypto/aes` | `go build ./cmd/phantom-cli` |

---

## 文档索引

| 文档 | 受众 | 用途 |
|------|------|------|
| [`README_CN.md`](README_CN.md) | 客户 / 高净值用户 | 商业价值与场景叙事 |
| [`SECURITY.md`](SECURITY.md) | 安全审计 / 技术决策者 | 安全模型与攻击路径推演 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 架构师 / 技术选型 | 系统架构与数据流设计 |
| [`phantom-web/ARCHITECTURE.md`](phantom-web/ARCHITECTURE.md) | Web 开发者 | Phantom-Web 前端架构 |
| [`phantom-core-go/ARCHITECTURE.md`](phantom-core-go/ARCHITECTURE.md) | Go 开发者 | Phantom-CLI 后端架构 |

---

## 许可证

MIT License
