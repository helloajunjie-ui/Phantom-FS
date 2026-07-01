// Package manifest 实现 Phantom-FS .ptm 二进制图纸格式
//
// 与 JS 端 100% 互操作：
//
//	60 字节固定头 + 可变 UTF-8 文件名
//
// ⚠️ 所有多字节字段使用 Big Endian（网络字节序），与 JS DataView(false) 一致
//
// Offset  Size  Field         Description
// ──────────────────────────────────────────────
// 0       16    Salt          PBKDF2 Salt（原始 bytes）
// 16      12    BaseIV        AES-GCM 基础 IV（原始 bytes）
// 28      16    Fingerprint   密钥指纹（原始 bytes）
// 44      4     ChunkSize     Uint32 Big Endian
// 48      4     TotalChunks   Uint32 Big Endian
// 52      6     FileSize      Uint48 Big Endian（高16位 + 低32位，支持最大 256TB）
// 60      ?     FileName      UTF-8 编码，无终止符
package manifest

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

const (
	// HeaderSize .ptm 固定头大小 (60 bytes)
	HeaderSize = 60
	// SaltOffset Salt 偏移
	SaltOffset = 0
	// SaltLen Salt 长度
	SaltLen = 16
	// BaseIVOffset BaseIV 偏移
	BaseIVOffset = 16
	// BaseIVLen BaseIV 长度
	BaseIVLen = 12
	// FingerprintOffset Fingerprint 偏移
	FingerprintOffset = 28
	// FingerprintLen Fingerprint 长度
	FingerprintLen = 16
	// ChunkSizeOffset ChunkSize 偏移
	ChunkSizeOffset = 44
	// TotalChunksOffset TotalChunks 偏移
	TotalChunksOffset = 48
	// FileSizeHiOffset FileSize 高16位偏移
	FileSizeHiOffset = 52
	// FileSizeLoOffset FileSize 低32位偏移
	FileSizeLoOffset = 54
	// FileNameOffset FileName 偏移
	FileNameOffset = 60
)

// Manifest 存储解密所需的所有密码学参数
type Manifest struct {
	Version     string `json:"version"`
	FileName    string `json:"fileName"`
	FileSize    int64  `json:"fileSize"` // ⚠️ int64 防止 32 位系统溢出
	ChunkSize   int    `json:"chunkSize"`
	TotalChunks int    `json:"totalChunks"`
	Salt        []byte `json:"salt"`
	BaseIV      []byte `json:"baseIV"`
	Fingerprint []byte `json:"fingerprint"`
}

// Validate 校验 Manifest 字段合法性
func (m *Manifest) Validate() error {
	if len(m.Salt) != SaltLen {
		return fmt.Errorf("Salt 长度错误: 期望 %d, 实际 %d", SaltLen, len(m.Salt))
	}
	if len(m.BaseIV) != BaseIVLen {
		return fmt.Errorf("BaseIV 长度错误: 期望 %d, 实际 %d", BaseIVLen, len(m.BaseIV))
	}
	if len(m.Fingerprint) != FingerprintLen {
		return fmt.Errorf("Fingerprint 长度错误: 期望 %d, 实际 %d", FingerprintLen, len(m.Fingerprint))
	}
	if m.ChunkSize <= 0 {
		return errors.New("ChunkSize 必须大于 0")
	}
	if m.TotalChunks <= 0 {
		return errors.New("TotalChunks 必须大于 0")
	}
	if m.FileSize < 0 {
		return errors.New("FileSize 不能为负")
	}
	if m.FileName == "" {
		return errors.New("FileName 不能为空")
	}
	return nil
}

// ExportBinary 导出为二进制 .ptm 格式
// 与 JS exportBinaryManifest 完全一致
// ⚠️ 所有多字节字段使用 Big Endian，与 JS DataView(false) 对齐
func (m *Manifest) ExportBinary() ([]byte, error) {
	if err := m.Validate(); err != nil {
		return nil, fmt.Errorf("Manifest 校验失败: %w", err)
	}

	nameBytes := []byte(m.FileName)
	buf := make([]byte, HeaderSize+len(nameBytes))

	// Salt [0:16]
	copy(buf[SaltOffset:SaltOffset+SaltLen], m.Salt)

	// BaseIV [16:28]
	copy(buf[BaseIVOffset:BaseIVOffset+BaseIVLen], m.BaseIV)

	// Fingerprint [28:44]
	copy(buf[FingerprintOffset:FingerprintOffset+FingerprintLen], m.Fingerprint)

	// ChunkSize [44:48] Uint32 Big Endian
	binary.BigEndian.PutUint32(buf[ChunkSizeOffset:ChunkSizeOffset+4], uint32(m.ChunkSize))

	// TotalChunks [48:52] Uint32 Big Endian
	binary.BigEndian.PutUint32(buf[TotalChunksOffset:TotalChunksOffset+4], uint32(m.TotalChunks))

	// FileSize [52:60] Uint48 Big Endian（高16位 + 低32位）
	fs := uint64(m.FileSize)
	fileSizeHi := uint16(fs >> 32)        // 高 16 位
	fileSizeLo := uint32(fs & 0xFFFFFFFF) // 低 32 位
	binary.BigEndian.PutUint16(buf[FileSizeHiOffset:FileSizeHiOffset+2], fileSizeHi)
	binary.BigEndian.PutUint32(buf[FileSizeLoOffset:FileSizeLoOffset+4], fileSizeLo)

	// FileName [60:]
	copy(buf[FileNameOffset:], nameBytes)

	return buf, nil
}

// ImportBinary 从二进制 .ptm 数据导入 Manifest
// 与 JS importBinaryManifest 完全一致
// ⚠️ 所有多字节字段使用 Big Endian，与 JS DataView(false) 对齐
func ImportBinary(data []byte) (*Manifest, error) {
	if len(data) < HeaderSize {
		return nil, fmt.Errorf("数据太短: 期望至少 %d 字节, 实际 %d", HeaderSize, len(data))
	}

	m := &Manifest{
		Version: "V12-Phantom",
	}

	// Salt [0:16]
	m.Salt = make([]byte, SaltLen)
	copy(m.Salt, data[SaltOffset:SaltOffset+SaltLen])

	// BaseIV [16:28]
	m.BaseIV = make([]byte, BaseIVLen)
	copy(m.BaseIV, data[BaseIVOffset:BaseIVOffset+BaseIVLen])

	// Fingerprint [28:44]
	m.Fingerprint = make([]byte, FingerprintLen)
	copy(m.Fingerprint, data[FingerprintOffset:FingerprintOffset+FingerprintLen])

	// ChunkSize [44:48] Big Endian
	m.ChunkSize = int(binary.BigEndian.Uint32(data[ChunkSizeOffset : ChunkSizeOffset+4]))

	// TotalChunks [48:52] Big Endian
	m.TotalChunks = int(binary.BigEndian.Uint32(data[TotalChunksOffset : TotalChunksOffset+4]))

	// FileSize [52:60] Uint48 Big Endian（高16位 + 低32位）
	fileSizeHi := uint64(binary.BigEndian.Uint16(data[FileSizeHiOffset : FileSizeHiOffset+2]))
	fileSizeLo := uint64(binary.BigEndian.Uint32(data[FileSizeLoOffset : FileSizeLoOffset+4]))
	m.FileSize = int64(fileSizeHi<<32 | fileSizeLo)

	// FileName [60:]
	nameBytes := data[FileNameOffset:]
	// 去除尾部空字节
	nameBytes = trimNullBytes(nameBytes)
	m.FileName = string(nameBytes)

	return m, nil
}

// IsBinaryManifest 检测数据是否为二进制 .ptm 格式
// 通过检查数据长度和字段合理性来判断
func IsBinaryManifest(data []byte) bool {
	if len(data) < HeaderSize {
		return false
	}

	// 检查 Salt 非全零（极低概率误判）
	salt := data[SaltOffset : SaltOffset+SaltLen]
	allZero := true
	for _, b := range salt {
		if b != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		return false
	}

	// 检查 ChunkSize 合理性 (>= 1MB, <= 1GB)
	chunkSize := binary.BigEndian.Uint32(data[ChunkSizeOffset : ChunkSizeOffset+4])
	if chunkSize < 1024*1024 || chunkSize > 1024*1024*1024 {
		return false
	}

	// 检查 TotalChunks 合理性
	totalChunks := binary.BigEndian.Uint32(data[TotalChunksOffset : TotalChunksOffset+4])
	if totalChunks == 0 || totalChunks > MaxSafeChunks {
		return false
	}

	return true
}

// MaxSafeChunks 最大安全分片数
const MaxSafeChunks = 1<<32 - 1

// EstimateSize 估算 Manifest 在两种模式下的体积
func (m *Manifest) EstimateSize() (jsonBytes int, binaryBytes int, ratio float64) {
	// JSON 模式估算
	jsonBytes = 200 + len(m.FileName) // 近似
	// Binary 模式
	binaryBytes = HeaderSize + len(m.FileName)
	// 压缩比
	if binaryBytes > 0 {
		ratio = float64(jsonBytes) / float64(binaryBytes)
	}
	return
}

// MaxFileSize 返回 .ptm 格式支持的最大文件大小（256TB）
func MaxFileSize() uint64 {
	return math.MaxUint32 | (math.MaxUint16 << 32)
}

// trimNullBytes 去除尾部空字节
func trimNullBytes(data []byte) []byte {
	end := len(data)
	for end > 0 && data[end-1] == 0 {
		end--
	}
	return data[:end]
}

// String 返回 Manifest 摘要信息
func (m *Manifest) String() string {
	return fmt.Sprintf("Manifest{file=%s, size=%d, chunks=%d, chunkSize=%d}",
		m.FileName, m.FileSize, m.TotalChunks, m.ChunkSize)
}

// BinaryManifestToBase64 将二进制 .ptm 数据转为 PTM:Base64 格式
// 与 JS binaryManifestToBase64 完全一致
func BinaryManifestToBase64(data []byte) string {
	const prefix = "PTM:"
	encoded := base64.StdEncoding.EncodeToString(data)
	return prefix + encoded
}

// Base64ToArrayBuffer 将 PTM:Base64 格式解码为二进制 .ptm 数据
// 与 JS base64ToArrayBuffer 完全一致
func Base64ToArrayBuffer(ptmBase64 string) ([]byte, error) {
	const prefix = "PTM:"
	if len(ptmBase64) < len(prefix) || ptmBase64[:len(prefix)] != prefix {
		return nil, errors.New("无效的 PTM:Base64 格式: 缺少 PTM: 前缀")
	}
	encoded := ptmBase64[len(prefix):]
	return base64.StdEncoding.DecodeString(encoded)
}
