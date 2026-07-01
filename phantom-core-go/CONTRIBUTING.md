# 🤝 Phantom-CLI 开发指南

> 版本: V12.1-Phantom (Go 后端)

---

## 01. 开发环境

### 要求

- **Go**: 1.26+
- **编辑器**: VS Code（推荐，安装 Go 扩展）
- **构建**: Go 标准工具链（`go build`, `go test`）

### 快速启动

```bash
# 克隆仓库
git clone https://github.com/your-org/phantom-fs.git
cd phantom-core-go

# 编译
go build -o phantom-cli ./cmd/phantom-cli

# 运行测试
go test ./...

# 安装到 $GOPATH/bin
go install ./cmd/phantom-cli
```

---

## 02. 项目结构

```
phantom-core-go/
├── cmd/
│   └── phantom-cli/
│       └── main.go         # CLI 入口，flag 解析 + 命令分发
├── pkg/
│   ├── cipher/             # 密码学核心
│   │   └── cipher.go       # PBKDF2 + AES-256-GCM
│   ├── manifest/           # .ptm 二进制图纸格式
│   │   └── manifest.go     # 序列化/反序列化
│   ├── pool/               # 并发控制
│   │   └── pool.go         # 信号量 + 指数退避
│   └── store/              # 存储适配层
│       └── store.go        # Provider 接口 + 3 种实现
├── go.mod / go.sum
└── 文档 (README, ARCHITECTURE, ENGINE_SPEC, API, CONTRIBUTING)
```

---

## 03. 编码规范

### 命名
- 导出类型/函数使用 CamelCase
- 私有函数使用 camelCase
- 常量使用 PascalCase
- 错误变量以 `Err` 开头

### 错误处理
- 所有可能失败的操作返回 `error`
- 使用 `fmt.Errorf` 包装错误上下文
- 不在库层面 `panic`（除不可恢复的编程错误）

### 安全
- 敏感数据（密钥、密码）使用后调用 `secureZero()` 清零
- 指纹比对使用常量时间比较
- 不从外部源直接信任输入，始终校验 Manifest 字段

### 测试
- 每个包应有对应的 `*_test.go` 文件
- 密码学测试需覆盖与 JS 端的互操作性
- 使用 `t.Parallel()` 加速测试

---

## 04. 构建与发布

```bash
# 开发编译
go build -o phantom-cli ./cmd/phantom-cli

# 发布编译（跨平台）
GOOS=linux GOARCH=amd64 go build -o phantom-cli-linux ./cmd/phantom-cli
GOOS=darwin GOARCH=amd64 go build -o phantom-cli-macos ./cmd/phantom-cli
GOOS=windows GOARCH=amd64 go build -o phantom-cli.exe ./cmd/phantom-cli

# 运行所有测试
go test -v -race ./...
```

---

## 05. 跨语言互操作测试

Phantom-CLI 与 Phantom-Web (JS) 共享同一套密码学协议。测试需验证：

1. **相同输入 → 相同输出**：Go 加密 → JS 解密，JS 加密 → Go 解密
2. **.ptm 格式兼容**：Go 导出的 .ptm 文件可被 JS 端解析，反之亦然
3. **指纹一致**：相同 password + salt 派生相同指纹

测试向量：

| 参数 | 值 |
|------|-----|
| Password | `"test-password-123"` |
| Salt | `000102030405060708090a0b0c0d0e0f` (16 bytes) |
| BaseIV | `000102030405060708090a0b` (12 bytes) |
| Plaintext | `"Hello Phantom-FS!"` |
| ChunkIndex | `0` |

---

## 06. 依赖管理

```bash
# 添加依赖
go get golang.org/x/crypto@v0.32.0

# 更新依赖
go get -u ./...

# 清理
go mod tidy
```

当前外部依赖：
- `golang.org/x/crypto` — PBKDF2 密钥派生（仅此一个外部依赖）
