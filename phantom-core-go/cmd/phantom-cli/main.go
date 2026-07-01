// Phantom-CLI — Phantom-FS 系统级加密工具
//
// 使用方式:
//
//	phantom encrypt <file>         加密文件
//	phantom decrypt <file.ptm>     解密文件
//	phantom verify <file.ptm>      校验密码
//	phantom info <file.ptm>        查看 Manifest 信息
//
// 跨语言互操作: 与 Phantom-Web (JS) 完全兼容
// 相同 password + salt → 相同密文 → 可互相解密
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/phantom-fs/phantom-core-go/pkg/cipher"
	"github.com/phantom-fs/phantom-core-go/pkg/manifest"
	"github.com/phantom-fs/phantom-core-go/pkg/pool"
	"github.com/phantom-fs/phantom-core-go/pkg/store"
)

const (
	version          = "V12.1-Phantom"
	defaultChunkSize = 5 * 1024 * 1024 // 5MB
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "encrypt":
		cmdEncrypt(args)
	case "decrypt":
		cmdDecrypt(args)
	case "verify":
		cmdVerify(args)
	case "info":
		cmdInfo(args)
	case "version":
		fmt.Printf("Phantom-CLI %s\n", version)
	case "help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "未知命令: %s\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Printf(`Phantom-CLI %s — 零信任加密工具

用法:
  phantom encrypt [选项] <文件>
        加密文件，生成 .ptm 图纸和加密分片

  phantom decrypt [选项] <文件.ptm>
        根据 .ptm 图纸解密文件

  phantom verify <文件.ptm>
        校验密码是否正确（无需解密数据）

  phantom info <文件.ptm>
        查看 .ptm 图纸信息

选项:
  -p, --password string   加密/解密密码
  -o, --output string     输出目录 (默认: 当前目录)
  -c, --chunk-size int    分片大小 (默认: 5MB)
  --store string          存储后端: memory|local|http (默认: local)
  --store-dir string      本地存储目录 (默认: ./.phantom-fs)
  -h, --help              显示帮助
`, version)
}

func cmdEncrypt(args []string) {
	fs := flag.NewFlagSet("encrypt", flag.ExitOnError)
	password := fs.String("p", "", "加密密码")
	output := fs.String("o", ".", "输出目录")
	chunkSize := fs.Int("c", defaultChunkSize, "分片大小")
	storeType := fs.String("store", "local", "存储后端")
	storeDir := fs.String("store-dir", "./.phantom-fs", "本地存储目录")
	fs.Parse(args)

	filePath := fs.Arg(0)
	if filePath == "" {
		fmt.Fprintln(os.Stderr, "错误: 请指定要加密的文件")
		os.Exit(1)
	}
	if *password == "" {
		fmt.Fprint(os.Stderr, "请输入密码: ")
		fmt.Scanln(password)
	}

	// ⚠️ Roo Audit: 使用 os.Open + ReadAt 替代 os.ReadFile
	// 防止大文件（如 50GB）一次性读入内存导致 OOM
	file, err := os.Open(filePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "打开文件失败: %v\n", err)
		os.Exit(1)
	}
	defer file.Close()

	fi, err := file.Stat()
	if err != nil {
		fmt.Fprintf(os.Stderr, "获取文件信息失败: %v\n", err)
		os.Exit(1)
	}

	fileName := filepath.Base(filePath)
	fileSize := fi.Size() // int64

	// 生成密码学参数
	salt := make([]byte, cipher.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		fmt.Fprintf(os.Stderr, "生成 Salt 失败: %v\n", err)
		os.Exit(1)
	}

	baseIV := make([]byte, cipher.BaseIVLen)
	if _, err := rand.Read(baseIV); err != nil {
		fmt.Fprintf(os.Stderr, "生成 BaseIV 失败: %v\n", err)
		os.Exit(1)
	}

	// 创建密码学引擎
	eng, err := cipher.NewCipher(*password, salt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "初始化密码引擎失败: %v\n", err)
		os.Exit(1)
	}
	defer eng.Destroy()
	eng.SetBaseIV(baseIV)

	fingerprint := eng.Fingerprint()

	// 计算分片
	totalChunks := (int(fileSize) + *chunkSize - 1) / *chunkSize
	fmt.Printf("🔐 加密: %s (%d bytes, %d 分片)\n", fileName, fileSize, totalChunks)

	// ── BYOS Session 文件夹结构 ──
	// 先创建 Session 目录，再初始化 Provider，确保分片直接写入正确位置
	sessionName := strings.TrimSuffix(fileName, filepath.Ext(fileName)) + "_phantom"
	sessionDir := filepath.Join(*output, sessionName)
	chunksDir := filepath.Join(sessionDir, "chunks")

	if err := os.MkdirAll(chunksDir, 0700); err != nil {
		fmt.Fprintf(os.Stderr, "创建 Session 目录失败: %v\n", err)
		os.Exit(1)
	}

	// 创建存储后端 — 直接指向 chunksDir
	var prov store.Provider
	switch *storeType {
	case "memory":
		prov = store.NewMemoryProvider()
	case "local":
		prov = store.NewLocalFileProvider(chunksDir)
	case "http":
		prov = store.NewHTTPProvider(*storeDir)
	default:
		fmt.Fprintf(os.Stderr, "未知存储后端: %s\n", *storeType)
		os.Exit(1)
	}

	// ⚠️ Roo Audit: 创建 sync.Pool 复用缓冲区
	// 总内存上限 = maxConcurrency * chunkSize，永远可控
	bufPool := pool.NewBufferPool(*chunkSize)

	// 并发加密
	startTime := time.Now()
	concPool := pool.New(pool.DefaultMaxConcurrency, pool.DefaultMaxRetries)
	fileID := generateFileID()

	for i := 0; i < totalChunks; i++ {
		chunkIdx := uint32(i)
		offset := int64(i) * int64(*chunkSize)

		concPool.Add(func(ctx context.Context) error {
			// ⚠️ Roo Audit: Worker 自行从文件指定 Offset 读取分片
			// 主线程不分配任何大块内存
			bufPtr := bufPool.Get().(*[]byte)
			defer bufPool.Put(bufPtr)

			n, err := file.ReadAt(*bufPtr, offset)
			if err != nil && err.Error() != "EOF" {
				return fmt.Errorf("读取分片 %d 失败: %w", chunkIdx, err)
			}
			chunkData := (*bufPtr)[:n]

			encrypted, err := eng.EncryptChunk(chunkData, chunkIdx)
			if err != nil {
				return fmt.Errorf("加密分片 %d 失败: %w", chunkIdx, err)
			}

			chunkID := fmt.Sprintf("%s/%08x", fileID, chunkIdx)
			_, err = prov.PutChunk(ctx, chunkID, encrypted)
			if err != nil {
				return fmt.Errorf("存储分片 %d 失败: %w", chunkIdx, err)
			}

			fmt.Printf("\r  进度: %d/%d", chunkIdx+1, totalChunks)
			return nil
		})
	}

	errors := concPool.WaitAll()
	fmt.Println()

	if len(errors) > 0 {
		fmt.Fprintf(os.Stderr, "加密完成，但有 %d 个错误:\n", len(errors))
		for _, e := range errors {
			fmt.Fprintf(os.Stderr, "  - %v\n", e)
		}
	}

	// 构建 Manifest
	m := &manifest.Manifest{
		Version:     version,
		FileName:    fileName,
		FileSize:    fileSize,
		ChunkSize:   *chunkSize,
		TotalChunks: totalChunks,
		Salt:        salt,
		BaseIV:      baseIV,
		Fingerprint: fingerprint,
	}

	// 导出 .ptm 图纸
	ptmData, err := m.ExportBinary()
	if err != nil {
		fmt.Fprintf(os.Stderr, "导出 .ptm 失败: %v\n", err)
		os.Exit(1)
	}

	// 写入 blueprint.ptm
	ptmPath := filepath.Join(sessionDir, "blueprint.ptm")
	if err := os.WriteFile(ptmPath, ptmData, 0600); err != nil {
		fmt.Fprintf(os.Stderr, "写入 blueprint.ptm 失败: %v\n", err)
		os.Exit(1)
	}

	duration := time.Since(startTime)
	fmt.Printf("✅ 加密完成!\n")
	fmt.Printf("   📁 Session: %s/\n", sessionDir)
	fmt.Printf("   📄 图纸:    %s/blueprint.ptm (%d bytes)\n", sessionDir, len(ptmData))
	fmt.Printf("   🗂️  分片:    %s/ (%d 个 .chk 文件)\n", chunksDir, totalChunks)
	fmt.Printf("   🆔 标识:    %s\n", fileID)
	fmt.Printf("   ⏱️  耗时:    %v (%.2f MB/s)\n", duration, float64(fileSize)/duration.Seconds()/1024/1024)
	fmt.Println()
	fmt.Println("  💡 提示: 将整个 chunks/ 目录上传到任意云盘，")
	fmt.Println("          blueprint.ptm 单独保管（可打印为二维码）")
}

func cmdDecrypt(args []string) {
	fs := flag.NewFlagSet("decrypt", flag.ExitOnError)
	password := fs.String("p", "", "解密密码")
	output := fs.String("o", ".", "输出目录")
	storeType := fs.String("store", "local", "存储后端")
	storeDir := fs.String("store-dir", "", "分片存储目录 (默认: 与 .ptm 同级的 chunks/)")
	fs.Parse(args)

	ptmPath := fs.Arg(0)
	if ptmPath == "" {
		fmt.Fprintln(os.Stderr, "错误: 请指定 .ptm 图纸文件")
		os.Exit(1)
	}

	// 读取 .ptm 文件
	ptmData, err := os.ReadFile(ptmPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "读取 .ptm 失败: %v\n", err)
		os.Exit(1)
	}

	// 解析 Manifest
	m, err := manifest.ImportBinary(ptmData)
	if err != nil {
		fmt.Fprintf(os.Stderr, "解析 .ptm 失败: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("📄 图纸信息: %s (%d bytes, %d 分片)\n", m.FileName, m.FileSize, m.TotalChunks)

	if *password == "" {
		fmt.Fprint(os.Stderr, "请输入密码: ")
		fmt.Scanln(password)
	}

	// 校验密码
	if !cipher.VerifyPassword(*password, m.Salt, m.Fingerprint) {
		fmt.Fprintln(os.Stderr, "❌ 密码错误")
		os.Exit(1)
	}
	fmt.Println("✅ 密码正确")

	// 创建密码学引擎
	eng, err := cipher.NewCipher(*password, m.Salt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "初始化密码引擎失败: %v\n", err)
		os.Exit(1)
	}
	defer eng.Destroy()
	eng.SetBaseIV(m.BaseIV)

	// ── BYOS: 自动推断 Session 目录 ──
	// 如果 .ptm 在 Session 目录中 (如 xxx_phantom/blueprint.ptm)
	// 则 chunks/ 目录自动定位到同级
	if *storeDir == "" {
		ptmDir := filepath.Dir(ptmPath)
		// 检查是否在 Session 目录中
		if strings.HasSuffix(ptmDir, "_phantom") || strings.HasSuffix(ptmDir, "_phantom/") || strings.HasSuffix(ptmDir, "_phantom\\") {
			*storeDir = filepath.Join(ptmDir, "chunks")
		} else {
			// 尝试查找同级的 chunks 目录
			candidate := filepath.Join(ptmDir, "chunks")
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				*storeDir = candidate
			} else {
				*storeDir = "./.phantom-fs"
			}
		}
	}

	// 创建存储后端
	var prov store.Provider
	switch *storeType {
	case "memory":
		prov = store.NewMemoryProvider()
	case "local":
		os.MkdirAll(*storeDir, 0700)
		prov = store.NewLocalFileProvider(*storeDir)
	case "http":
		prov = store.NewHTTPProvider(*storeDir)
	default:
		fmt.Fprintf(os.Stderr, "未知存储后端: %s\n", *storeType)
		os.Exit(1)
	}

	// ── BYOS: 从 Session 目录推断 fileID ──
	// chunks/ 目录下的子目录名即为 fileID
	fileID := detectFileID(*storeDir)
	if fileID == "" {
		fmt.Fprint(os.Stderr, "请输入文件标识 (fileId): ")
		fmt.Scanln(&fileID)
	}

	fmt.Printf("   🆔 文件标识: %s\n", fileID)
	fmt.Printf("   🗂️  分片目录: %s\n", *storeDir)

	// 并发下载解密
	startTime := time.Now()

	// ⚠️ Roo Audit: 解密端使用临时文件写入替代全量内存分配
	outPath := filepath.Join(*output, "decrypted_"+m.FileName)
	tmpPath := outPath + ".tmp"

	tmpFile, err := os.Create(tmpPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "创建临时文件失败: %v\n", err)
		os.Exit(1)
	}

	concPool := pool.New(pool.DefaultMaxConcurrency, pool.DefaultMaxRetries)
	var writeMu sync.Mutex

	for i := 0; i < m.TotalChunks; i++ {
		chunkIdx := uint32(i)
		chunkID := fmt.Sprintf("%s/%08x", fileID, chunkIdx)
		offset := int64(chunkIdx) * int64(m.ChunkSize)

		concPool.Add(func(ctx context.Context) error {
			encrypted, err := prov.GetChunk(ctx, chunkID, nil)
			if err != nil {
				return fmt.Errorf("下载分片 %d 失败: %w", chunkIdx, err)
			}

			plaintext, err := eng.DecryptChunk(encrypted, chunkIdx)
			if err != nil {
				return fmt.Errorf("解密分片 %d 失败: %w", chunkIdx, err)
			}

			// ⚠️ Roo Audit: 使用 WriteAt 按偏移写入，无需全量内存
			writeMu.Lock()
			_, err = tmpFile.WriteAt(plaintext, offset)
			writeMu.Unlock()
			if err != nil {
				return fmt.Errorf("写入分片 %d 失败: %w", chunkIdx, err)
			}

			fmt.Printf("\r  进度: %d/%d", chunkIdx+1, m.TotalChunks)
			return nil
		})
	}

	errors := concPool.WaitAll()
	fmt.Println()

	if len(errors) > 0 {
		tmpFile.Close()
		os.Remove(tmpPath)
		fmt.Fprintf(os.Stderr, "解密完成，但有 %d 个错误:\n", len(errors))
		for _, e := range errors {
			fmt.Fprintf(os.Stderr, "  - %v\n", e)
		}
		os.Exit(1)
	}

	// 关闭临时文件并重命名
	if err := tmpFile.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "关闭临时文件失败: %v\n", err)
		os.Exit(1)
	}
	if err := os.Rename(tmpPath, outPath); err != nil {
		fmt.Fprintf(os.Stderr, "重命名文件失败: %v\n", err)
		os.Exit(1)
	}

	duration := time.Since(startTime)
	fmt.Printf("✅ 解密完成!\n")
	fmt.Printf("   输出: %s (%d bytes)\n", outPath, m.FileSize)
	fmt.Printf("   耗时: %v (%.2f MB/s)\n", duration, float64(m.FileSize)/duration.Seconds()/1024/1024)
}

// detectFileID 从 chunks 目录自动推断 fileID
// 查找第一个子目录作为 fileID
func detectFileID(chunksDir string) string {
	entries, err := os.ReadDir(chunksDir)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if entry.IsDir() {
			return entry.Name()
		}
	}
	return ""
}

func cmdVerify(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "错误: 请指定 .ptm 图纸文件")
		os.Exit(1)
	}

	ptmData, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "读取 .ptm 失败: %v\n", err)
		os.Exit(1)
	}

	m, err := manifest.ImportBinary(ptmData)
	if err != nil {
		fmt.Fprintf(os.Stderr, "解析 .ptm 失败: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("📄 %s (%d bytes, %d 分片)\n", m.FileName, m.FileSize, m.TotalChunks)

	fmt.Fprint(os.Stderr, "请输入密码: ")
	var password string
	fmt.Scanln(&password)

	start := time.Now()
	ok := cipher.VerifyPassword(password, m.Salt, m.Fingerprint)
	duration := time.Since(start)

	if ok {
		fmt.Printf("✅ 密码正确 (%v)\n", duration)
	} else {
		fmt.Printf("❌ 密码错误 (%v)\n", duration)
		os.Exit(1)
	}
}

func cmdInfo(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "错误: 请指定 .ptm 图纸文件")
		os.Exit(1)
	}

	ptmData, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "读取 .ptm 失败: %v\n", err)
		os.Exit(1)
	}

	m, err := manifest.ImportBinary(ptmData)
	if err != nil {
		fmt.Fprintf(os.Stderr, "解析 .ptm 失败: %v\n", err)
		os.Exit(1)
	}

	jsonSize, binarySize, ratio := m.EstimateSize()

	fmt.Printf("📄 Phantom-FS .ptm 图纸信息\n")
	fmt.Printf("═══════════════════════════════\n")
	fmt.Printf("  版本:      %s\n", m.Version)
	fmt.Printf("  文件名:    %s\n", m.FileName)
	fmt.Printf("  文件大小:  %d bytes (%.2f MB)\n", m.FileSize, float64(m.FileSize)/1024/1024)
	fmt.Printf("  分片大小:  %d bytes (%.2f MB)\n", m.ChunkSize, float64(m.ChunkSize)/1024/1024)
	fmt.Printf("  分片数:    %d\n", m.TotalChunks)
	fmt.Printf("  Salt:      %s\n", hex.EncodeToString(m.Salt))
	fmt.Printf("  BaseIV:    %s\n", hex.EncodeToString(m.BaseIV))
	fmt.Printf("  指纹:      %s\n", hex.EncodeToString(m.Fingerprint))
	fmt.Printf("  图纸体积:  %d bytes (二进制 .ptm)\n", binarySize)
	fmt.Printf("            (JSON 模式约 %d bytes, 压缩比 %.1fx)\n", jsonSize, ratio)
}

func generateFileID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func extractFileID(prov store.Provider, m *manifest.Manifest) string {
	// 尝试从存储中推断 fileID
	// 实际实现需要存储后端支持列出文件
	_ = prov
	_ = m
	return ""
}
