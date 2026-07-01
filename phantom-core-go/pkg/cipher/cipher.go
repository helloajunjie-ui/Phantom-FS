// Package cipher 实现 Phantom-FS V12.1 密码学核心
//
// 与 JS 端 100% 互操作：
//   - PBKDF2 600,000 次迭代, SHA-256, 256-bit key
//   - AES-256-GCM 认证加密
//   - 确定性 IV 推导: baseIV[0:8] ++ (baseIV[8:12] XOR chunkIndex)
//   - AAD: "chunk_{index}" (UTF-8)
//
// 跨语言协议保证：相同 password + salt + baseIV + chunkIndex
// → JS 与 Go 产出完全相同的密文，可互相解密
package cipher

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/pbkdf2"
)

const (
	// SaltLen PBKDF2 Salt 长度 (16 bytes)
	SaltLen = 16
	// BaseIVLen 基础 IV 长度 (12 bytes, GCM 标准 nonce)
	BaseIVLen = 12
	// KeyLen AES-256 密钥长度 (32 bytes)
	KeyLen = 32
	// FingerprintLen 密钥指纹长度 (SHA-256 前 16 bytes)
	FingerprintLen = 16
	// PBKDF2Iterations 密钥派生迭代次数
	PBKDF2Iterations = 600000
	// MaxSafeChunks 最大安全分片数 (2^32 - 1)
	MaxSafeChunks = 1<<32 - 1
)

// PhantomCipher 是 Phantom-FS 密码学引擎实例
type PhantomCipher struct {
	key    []byte // AES-256 密钥 (使用后清零)
	salt   []byte // 16 bytes
	baseIV []byte // 12 bytes
}

// NewCipher 创建密码学引擎
// password: 用户密码
// salt: 16 字节随机盐（加密时生成，解密时从 Manifest 读取）
func NewCipher(password string, salt []byte) (*PhantomCipher, error) {
	if len(salt) != SaltLen {
		return nil, errors.New("salt 必须为 16 字节")
	}

	key := deriveKey(password, salt)
	return &PhantomCipher{
		key:    key,
		salt:   append([]byte{}, salt...),
		baseIV: nil, // 由 Encrypt/Decrypt 设置
	}, nil
}

// deriveKey PBKDF2 密钥派生 (与 JS deriveKey 完全一致)
func deriveKey(password string, salt []byte) []byte {
	return pbkdf2.Key([]byte(password), salt, PBKDF2Iterations, KeyLen, sha256.New)
}

// ExtractFingerprint 提取密钥指纹 (SHA-256(key)[0:16])
// 与 JS extractFingerprint 完全一致
func ExtractFingerprint(key []byte) []byte {
	h := sha256.Sum256(key)
	return h[:FingerprintLen]
}

// Fingerprint 返回当前引擎的密钥指纹
func (c *PhantomCipher) Fingerprint() []byte {
	return ExtractFingerprint(c.key)
}

// VerifyPassword 快速校验密码 (与 JS verifyPassword 完全一致)
// 耗时 < 100ms，仅做密钥派生 + 指纹比对
func VerifyPassword(password string, salt, expectedFingerprint []byte) bool {
	key := deriveKey(password, salt)
	fp := ExtractFingerprint(key)
	secureZero(key)
	return compareFingerprint(fp, expectedFingerprint)
}

// compareFingerprint 常量时间指纹比对 (防时序攻击)
func compareFingerprint(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// DeriveChunkIV 确定性 IV 推导
// baseIV[0:8] 保持不变，baseIV[8:12] 与 chunkIndex 进行 BigEndian XOR
// 与 JS deriveChunkIV 完全一致
func DeriveChunkIV(baseIV []byte, chunkIndex uint32) []byte {
	if len(baseIV) != BaseIVLen {
		panic("baseIV 必须为 12 字节")
	}

	iv := make([]byte, BaseIVLen)
	copy(iv, baseIV)

	// 取 baseIV 后 4 字节作为 uint32 (BigEndian)
	last4 := binary.BigEndian.Uint32(baseIV[8:12])
	// XOR chunkIndex
	binary.BigEndian.PutUint32(iv[8:12], last4^chunkIndex)

	return iv
}

// BuildAAD 构建附加认证数据 (与 JS buildAAD 完全一致)
func BuildAAD(chunkIndex uint32) []byte {
	return []byte(fmt.Sprintf("chunk_%d", chunkIndex))
}

// EncryptChunk 加密单个分片
// plaintext: 原始分片数据
// chunkIndex: 分片索引 (用于 IV 推导和 AAD)
// 返回: nonce(12 bytes) + ciphertext + tag(16 bytes)
// 与 JS encryptChunk 完全一致
func (c *PhantomCipher) EncryptChunk(plaintext []byte, chunkIndex uint32) ([]byte, error) {
	if c.baseIV == nil {
		return nil, errors.New("baseIV 未设置，请使用 SetBaseIV 或 EncryptFile")
	}

	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, fmt.Errorf("AES 初始化失败: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("GCM 初始化失败: %w", err)
	}

	iv := DeriveChunkIV(c.baseIV, chunkIndex)
	aad := BuildAAD(chunkIndex)

	// GCM.Seal 输出: ciphertext + tag(16 bytes)
	// 我们前置 nonce 以便解密时直接提取
	// 格式: nonce(12) + ciphertext + tag(16)
	ciphertext := gcm.Seal(nil, iv, plaintext, aad)

	out := make([]byte, BaseIVLen+len(ciphertext))
	copy(out[:BaseIVLen], iv)
	copy(out[BaseIVLen:], ciphertext)

	return out, nil
}

// DecryptChunk 解密单个分片
// data: nonce(12 bytes) + ciphertext + tag(16 bytes)
// chunkIndex: 分片索引 (用于 IV 推导和 AAD)
// 与 JS decryptChunk 完全一致
func (c *PhantomCipher) DecryptChunk(data []byte, chunkIndex uint32) ([]byte, error) {
	if len(data) < BaseIVLen+16 {
		return nil, errors.New("数据太短，无法解密")
	}

	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, fmt.Errorf("AES 初始化失败: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("GCM 初始化失败: %w", err)
	}

	// 提取 nonce 和密文
	nonce := data[:BaseIVLen]
	ciphertext := data[BaseIVLen:]

	// 验证 IV 是否与推导一致（防篡改）
	expectedIV := DeriveChunkIV(c.baseIV, chunkIndex)
	if !compareFingerprint(nonce, expectedIV) {
		return nil, errors.New("IV 不匹配，数据可能被篡改")
	}

	aad := BuildAAD(chunkIndex)

	plaintext, err := gcm.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, fmt.Errorf("解密失败 (AAD 验证未通过): %w", err)
	}

	return plaintext, nil
}

// SetBaseIV 设置基础 IV (加密时由随机数生成)
func (c *PhantomCipher) SetBaseIV(baseIV []byte) error {
	if len(baseIV) != BaseIVLen {
		return errors.New("baseIV 必须为 12 字节")
	}
	c.baseIV = append([]byte{}, baseIV...)
	return nil
}

// GetSalt 获取 Salt 副本
func (c *PhantomCipher) GetSalt() []byte {
	return append([]byte{}, c.salt...)
}

// GetBaseIV 获取 BaseIV 副本
func (c *PhantomCipher) GetBaseIV() []byte {
	if c.baseIV == nil {
		return nil
	}
	return append([]byte{}, c.baseIV...)
}

// GenerateSalt 生成随机 Salt
func GenerateSalt() ([]byte, error) {
	salt := make([]byte, SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("生成 Salt 失败: %w", err)
	}
	return salt, nil
}

// GenerateBaseIV 生成随机 BaseIV
func GenerateBaseIV() ([]byte, error) {
	iv := make([]byte, BaseIVLen)
	if _, err := rand.Read(iv); err != nil {
		return nil, fmt.Errorf("生成 BaseIV 失败: %w", err)
	}
	return iv, nil
}

// EncryptFile 加密整个文件（流式分片）
// 返回: 加密后的分片列表, 每个分片格式为 nonce(12) + ciphertext + tag(16)
func (c *PhantomCipher) EncryptFile(plaintext []byte, chunkSize int) ([][]byte, error) {
	if c.baseIV == nil {
		return nil, errors.New("baseIV 未设置")
	}
	if chunkSize <= 0 {
		chunkSize = 5 * 1024 * 1024 // 默认 5MB
	}

	totalChunks := (len(plaintext) + chunkSize - 1) / chunkSize
	if totalChunks > MaxSafeChunks {
		return nil, fmt.Errorf("分片数 %d 超过安全边界 %d", totalChunks, MaxSafeChunks)
	}

	chunks := make([][]byte, 0, totalChunks)

	for i := 0; i < totalChunks; i++ {
		start := i * chunkSize
		end := start + chunkSize
		if end > len(plaintext) {
			end = len(plaintext)
		}

		encrypted, err := c.EncryptChunk(plaintext[start:end], uint32(i))
		if err != nil {
			return nil, fmt.Errorf("加密分片 %d 失败: %w", i, err)
		}
		chunks = append(chunks, encrypted)
	}

	return chunks, nil
}

// DecryptFile 解密整个文件
func (c *PhantomCipher) DecryptFile(chunks [][]byte, totalSize int) ([]byte, error) {
	if c.baseIV == nil {
		return nil, errors.New("baseIV 未设置")
	}

	result := make([]byte, 0, totalSize)

	for i, chunk := range chunks {
		decrypted, err := c.DecryptChunk(chunk, uint32(i))
		if err != nil {
			return nil, fmt.Errorf("解密分片 %d 失败: %w", i, err)
		}
		result = append(result, decrypted...)
	}

	return result, nil
}

// secureZero 安全清零内存 (与 JS secureZero 一致)
func secureZero(data []byte) {
	for i := range data {
		data[i] = 0
	}
}

// Destroy 销毁密钥，清零内存
func (c *PhantomCipher) Destroy() {
	secureZero(c.key)
	secureZero(c.salt)
	if c.baseIV != nil {
		secureZero(c.baseIV)
	}
	c.key = nil
	c.salt = nil
	c.baseIV = nil
}

// Ensure io import is used
var _ = io.Discard
