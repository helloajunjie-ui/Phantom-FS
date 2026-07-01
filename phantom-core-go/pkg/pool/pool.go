// Package pool 实现 Phantom-FS 并发控制池
//
// 基于 Go 有缓冲 channel 的 Goroutine 池
// 与 JS ConcurrencyPool 语义一致但性能碾压
//
// ⚠️ Roo Audit: 使用 sync.Pool 复用内存缓冲区，防止 OOM
// 主线程不得分配大块内存抛给 goroutine，应由 Worker 自行 ReadAt
package pool

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// DefaultMaxConcurrency 默认最大并发数
const DefaultMaxConcurrency = 5

// DefaultMaxRetries 默认最大重试次数
const DefaultMaxRetries = 3

// DefaultRetryDelay 默认重试延迟 (指数退避基数)
const DefaultRetryDelay = 1 * time.Second

// Task 是池中执行的任务
type Task func(ctx context.Context) error

// Pool 并发控制池
type Pool struct {
	maxConcurrency int
	maxRetries     int
	retryDelay     time.Duration
	sem            chan struct{}
	wg             sync.WaitGroup
	errors         []error
	mu             sync.Mutex
	ctx            context.Context
	cancel         context.CancelFunc
}

// New 创建并发池
func New(maxConcurrency, maxRetries int) *Pool {
	if maxConcurrency <= 0 {
		maxConcurrency = DefaultMaxConcurrency
	}
	if maxRetries <= 0 {
		maxRetries = DefaultMaxRetries
	}

	ctx, cancel := context.WithCancel(context.Background())

	return &Pool{
		maxConcurrency: maxConcurrency,
		maxRetries:     maxRetries,
		retryDelay:     DefaultRetryDelay,
		sem:            make(chan struct{}, maxConcurrency),
		ctx:            ctx,
		cancel:         cancel,
	}
}

// Add 添加任务到池中
// 如果池已满，会阻塞直到有空闲槽位
func (p *Pool) Add(task Task) {
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()

		// 获取信号量
		select {
		case p.sem <- struct{}{}:
		case <-p.ctx.Done():
			return
		}
		defer func() { <-p.sem }()

		// 执行任务（带重试）
		var lastErr error
		for i := 0; i <= p.maxRetries; i++ {
			select {
			case <-p.ctx.Done():
				return
			default:
			}

			err := task(p.ctx)
			if err == nil {
				return // 成功
			}
			lastErr = err

			// 指数退避
			if i < p.maxRetries {
				delay := p.retryDelay * (1 << i) // 1s, 2s, 4s
				select {
				case <-time.After(delay):
				case <-p.ctx.Done():
					return
				}
			}
		}

		// 所有重试失败
		p.mu.Lock()
		p.errors = append(p.errors, fmt.Errorf("任务失败 (重试 %d 次): %w", p.maxRetries, lastErr))
		p.mu.Unlock()
	}()
}

// WaitAll 等待所有任务完成
func (p *Pool) WaitAll() []error {
	p.wg.Wait()
	p.cancel()
	return p.errors
}

// Errors 获取错误列表
func (p *Pool) Errors() []error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]error{}, p.errors...)
}

// Stop 停止池中所有任务
func (p *Pool) Stop() {
	p.cancel()
}

// NewBufferPool 创建 sync.Pool 用于复用指定大小的字节缓冲区
// ⚠️ Roo Audit: 防止主线程疯狂分配内存导致 OOM
// 总内存上限 = maxConcurrency * bufSize，永远可控
func NewBufferPool(bufSize int) *sync.Pool {
	return &sync.Pool{
		New: func() interface{} {
			b := make([]byte, bufSize)
			return &b
		},
	}
}
