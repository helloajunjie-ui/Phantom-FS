// Package store 实现 Phantom-FS 存储适配器接口
//
// 与 JS IStorageProvider 接口语义一致
// 万物皆可为沙箱：Memory / HTTP / LocalFile / S3 / IPFS
package store

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Provider 存储提供者接口 (IStorageProvider)
// chunkId 格式: "{fileId}/{index}" (如 "abc123/00000000")
type Provider interface {
	// PutChunk 保存一个分片，返回寻址 ID
	PutChunk(ctx context.Context, chunkID string, data []byte) (string, error)

	// GetChunk 获取一个分片（支持 Range）
	GetChunk(ctx context.Context, chunkID string, rangeOpt *Range) ([]byte, error)

	// DeleteFile 删除一个文件的所有分片
	DeleteFile(ctx context.Context, fileID string) error

	// GetChunkURL 获取分片的直接访问 URL
	GetChunkURL(chunkID string) string
}

// Range 字节范围
type Range struct {
	Start int64
	End   int64
}

// ============================================================
//  MemoryProvider
// ============================================================

// MemoryProvider 内存存储后端（开发调试用）
type MemoryProvider struct {
	mu    sync.RWMutex
	store map[string][]byte
}

func NewMemoryProvider() *MemoryProvider {
	return &MemoryProvider{
		store: make(map[string][]byte),
	}
}

func (p *MemoryProvider) PutChunk(_ context.Context, chunkID string, data []byte) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	buf := make([]byte, len(data))
	copy(buf, data)
	p.store[chunkID] = buf
	return fmt.Sprintf("memory://%s", chunkID), nil
}

func (p *MemoryProvider) GetChunk(_ context.Context, chunkID string, rangeOpt *Range) ([]byte, error) {
	p.mu.RLock()
	data, ok := p.store[chunkID]
	p.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("分片不存在: %s", chunkID)
	}

	if rangeOpt != nil {
		if rangeOpt.Start < 0 || rangeOpt.End > int64(len(data)) || rangeOpt.Start > rangeOpt.End {
			return nil, fmt.Errorf("Range 越界: %d-%d (长度 %d)", rangeOpt.Start, rangeOpt.End, len(data))
		}
		return data[rangeOpt.Start:rangeOpt.End], nil
	}

	buf := make([]byte, len(data))
	copy(buf, data)
	return buf, nil
}

func (p *MemoryProvider) DeleteFile(_ context.Context, fileID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	prefix := fileID + "/"
	for k := range p.store {
		if strings.HasPrefix(k, prefix) {
			delete(p.store, k)
		}
	}
	return nil
}

func (p *MemoryProvider) GetChunkURL(chunkID string) string {
	return fmt.Sprintf("memory://%s", chunkID)
}

// Stats 存储统计
func (p *MemoryProvider) Stats() (files int, chunks int, size int64) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	fileMap := make(map[string]bool)
	for k, v := range p.store {
		chunks++
		size += int64(len(v))
		parts := strings.SplitN(k, "/", 2)
		if len(parts) == 2 {
			fileMap[parts[0]] = true
		}
	}
	files = len(fileMap)
	return
}

// ============================================================
//  HTTPProvider
// ============================================================

// HTTPProvider HTTP 存储后端（基于 Range Request）
type HTTPProvider struct {
	baseURL string
	client  *http.Client
	headers map[string]string
}

func NewHTTPProvider(baseURL string) *HTTPProvider {
	return &HTTPProvider{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{},
		headers: make(map[string]string),
	}
}

func (p *HTTPProvider) SetHeader(key, value string) {
	p.headers[key] = value
}

func (p *HTTPProvider) PutChunk(ctx context.Context, chunkID string, data []byte) (string, error) {
	url := fmt.Sprintf("%s/%s.chunk", p.baseURL, chunkID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, nil)
	if err != nil {
		return "", fmt.Errorf("创建请求失败: %w", err)
	}
	req.Body = io.NopCloser(strings.NewReader(string(data)))
	req.ContentLength = int64(len(data))
	req.Header.Set("Content-Type", "application/octet-stream")
	for k, v := range p.headers {
		req.Header.Set(k, v)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("上传失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("上传失败: %s", resp.Status)
	}

	return url, nil
}

func (p *HTTPProvider) GetChunk(ctx context.Context, chunkID string, rangeOpt *Range) ([]byte, error) {
	url := p.GetChunkURL(chunkID)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("创建请求失败: %w", err)
	}

	if rangeOpt != nil {
		// HTTP Range 是 inclusive（包含 end），接口定义 rangeOpt.End 是 exclusive
		// 所以需要 End - 1，与 JS HTTPProvider.getChunk 一致
		end := rangeOpt.End - 1
		if end < rangeOpt.Start {
			end = rangeOpt.Start
		}
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", rangeOpt.Start, end))
	}
	for k, v := range p.headers {
		req.Header.Set(k, v)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("下载失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return nil, fmt.Errorf("下载失败: %s", resp.Status)
	}

	return io.ReadAll(resp.Body)
}

func (p *HTTPProvider) DeleteFile(_ context.Context, _ string) error {
	return fmt.Errorf("HTTPProvider: DeleteFile 未实现，需要后端支持批量删除")
}

func (p *HTTPProvider) GetChunkURL(chunkID string) string {
	return fmt.Sprintf("%s/%s.chunk", p.baseURL, chunkID)
}

// ============================================================
//  LocalFileProvider
// ============================================================

// LocalFileProvider 本地文件系统存储后端
// 按 fileId 子目录存储分片，与 JS LocalFileProvider 一致
// 目录结构: {baseDir}/{fileId}/{index}.chunk
type LocalFileProvider struct {
	baseDir string
}

func NewLocalFileProvider(baseDir string) *LocalFileProvider {
	return &LocalFileProvider{
		baseDir: baseDir,
	}
}

// chunkPath 返回分片文件路径
// chunkID 格式: "{fileId}/{index}" → {baseDir}/{fileId}/{index}.chunk
func (p *LocalFileProvider) chunkPath(chunkID string) string {
	parts := strings.SplitN(chunkID, "/", 2)
	if len(parts) == 2 {
		return filepath.Join(p.baseDir, parts[0], parts[1]+".chunk")
	}
	return filepath.Join(p.baseDir, chunkID+".chunk")
}

func (p *LocalFileProvider) PutChunk(_ context.Context, chunkID string, data []byte) (string, error) {
	path := p.chunkPath(chunkID)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", fmt.Errorf("创建目录失败: %w", err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return "", fmt.Errorf("写入文件失败: %w", err)
	}
	return path, nil
}

func (p *LocalFileProvider) GetChunk(_ context.Context, chunkID string, rangeOpt *Range) ([]byte, error) {
	path := p.chunkPath(chunkID)

	if rangeOpt != nil {
		f, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("打开文件失败: %w", err)
		}
		defer f.Close()

		buf := make([]byte, rangeOpt.End-rangeOpt.Start)
		_, err = f.ReadAt(buf, rangeOpt.Start)
		if err != nil {
			return nil, fmt.Errorf("读取文件失败: %w", err)
		}
		return buf, nil
	}

	return os.ReadFile(path)
}

func (p *LocalFileProvider) DeleteFile(_ context.Context, fileID string) error {
	dir := filepath.Join(p.baseDir, fileID)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("删除分片目录失败: %w", err)
	}
	return nil
}

func (p *LocalFileProvider) GetChunkURL(chunkID string) string {
	return p.chunkPath(chunkID)
}
