# 🤝 Phantom-FS 开发指南

> 版本: V12.1-Phantom | 双端: Go + JS

---

## 01. 开发环境

### 要求

| 端 | 要求 |
|----|------|
| **Phantom-CLI (Go)** | Go 1.26+, VS Code (Go 扩展) |
| **Phantom-Web (JS)** | Chrome 90+ / Firefox 90+ / Edge 90+, VS Code |

### 快速启动

```bash
# 克隆仓库
git clone https://github.com/helloajunjie-ui/Phantom-FS.git
cd Phantom-FS

# Go 端编译
cd phantom-core-go
go build -o phantom-cli ./cmd/phantom-cli

# JS 端启动
cd phantom-web
npx serve .
```

---

## 02. 项目结构

```
Phantom-FS/
│
├── README.md               # 项目总览 (中英双语)
├── ARCHITECTURE.md          # 架构设计文档
├── ENGINE_SPEC.md           # 核心引擎规范
├── API.md                   # API 设计文档
├── CONTRIBUTING.md          # 本文件
├── CHANGELOG.md             # 版本发布记录
├── SECURITY.md              # 安全模型
│
├── phantom-core-go/         # Go 系统级 CLI
│   ├── cmd/
│   │   ├── phantom-cli/     # CLI 入口
│   │   └── verify-proof/    # 能力验证工具
│   └── pkg/
│       ├── cipher/          # 密码学核心
│       ├── manifest/        # .ptm 二进制图纸
│       ├── pool/            # 并发控制
│       └── store/           # 存储适配层
│
└── phantom-web/             # JS 浏览器端
    ├── index.html           # 单页应用入口
    └── src/
        ├── core/            # 密码学核心
        ├── storage/         # 存储适配层
        ├── ui/              # 应用逻辑 + 样式
        └── utils/           # 并发池 + 安全内存
```

---

## 03. 编码规范

### Go

- 遵循 [Go Code Review Comments](https://go.dev/wiki/CodeReviewComments)
- 使用 `gofmt` 格式化代码
- 错误处理：始终检查返回值，使用 `fmt.Errorf` 包装错误上下文
- 并发：使用 `sync.Pool` 复用缓冲区，使用 `context.Context` 传递取消信号
- 安全：敏感数据使用后调用 `secureZero()` 清零

### JavaScript

- 使用 `'use strict'` 严格模式
- 使用 `async/await` 处理异步操作
- 使用 `crypto.subtle` 进行密码学操作
- 使用 `DataView` 处理二进制数据（指定字节序）
- 所有 `Uint8Array` 视图操作使用 `.slice()` 拷贝而非引用

### 跨语言一致性

- 所有多字节字段使用 **Big Endian** 编码
- IV 推导：`baseIV[0:8] ++ (baseIV[8:12] XOR BigEndian(chunkIndex))`
- AAD：`"chunk_{index}"` (UTF-8)
- JS 中 XOR 运算使用 `>>> 0` 确保无符号

---

## 04. 测试

```bash
# Go 端
cd phantom-core-go
go test ./...
go run ./cmd/verify-proof/    # 16 项能力验证

# JS 端
# 浏览器打开 phantom-web/index.html
# 手动测试加密 → 解密流程
```

---

## 05. PR 流程

1. Fork 仓库
2. 创建特性分支: `git checkout -b feat/your-feature`
3. 提交变更: `git commit -m "feat: description"`
4. 推送分支: `git push origin feat/your-feature`
5. 创建 Pull Request

### Commit 规范

```
<type>: <description>

type:
  feat    - 新功能
  fix     - Bug 修复
  docs    - 文档变更
  refactor- 重构
  perf    - 性能优化
  security- 安全修复
  chore   - 构建/工具
```

---

## 06. 安全注意事项

- 永远不要在日志中打印密钥或密码
- 永远不要将 `.ptm` 图纸与 `chunks/` 存储在同一个位置
- 修改密码学代码后必须运行 `verify-proof` 验证跨语言兼容性
- 修改存储适配器后必须测试所有 Provider 的 Range 请求
