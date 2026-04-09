package aun

import (
	"sync"
	"testing"
)

// TestSubscribeAndPublish 验证订阅后能收到发布的事件
func TestSubscribeAndPublish(t *testing.T) {
	d := NewEventDispatcher()
	var received any
	d.Subscribe("test.event", func(payload any) {
		received = payload
	})
	d.Publish("test.event", "hello")
	if received != "hello" {
		t.Errorf("收到的 payload 不正确: %v", received)
	}
}

// TestUnsubscribe 验证取消订阅后不再收到事件
func TestUnsubscribe(t *testing.T) {
	d := NewEventDispatcher()
	callCount := 0
	sub := d.Subscribe("test.event", func(payload any) {
		callCount++
	})
	d.Publish("test.event", nil)
	if callCount != 1 {
		t.Fatalf("取消订阅前应被调用 1 次, 实际: %d", callCount)
	}
	sub.Unsubscribe()
	d.Publish("test.event", nil)
	if callCount != 1 {
		t.Errorf("取消订阅后不应再被调用, 调用次数: %d", callCount)
	}
}

// TestMultipleHandlers 验证同一事件的多个处理器按顺序执行
func TestMultipleHandlers(t *testing.T) {
	d := NewEventDispatcher()
	var order []int
	d.Subscribe("test.event", func(payload any) {
		order = append(order, 1)
	})
	d.Subscribe("test.event", func(payload any) {
		order = append(order, 2)
	})
	d.Subscribe("test.event", func(payload any) {
		order = append(order, 3)
	})
	d.Publish("test.event", nil)
	if len(order) != 3 {
		t.Fatalf("应有 3 个处理器执行, 实际: %d", len(order))
	}
	for i, v := range order {
		if v != i+1 {
			t.Errorf("执行顺序错误: 位置 %d 应为 %d, 实际: %d", i, i+1, v)
		}
	}
}

// TestPublishNoHandlers 验证发布无订阅者的事件不会 panic
func TestPublishNoHandlers(t *testing.T) {
	d := NewEventDispatcher()
	// 不应 panic
	d.Publish("nonexistent.event", "data")
}

// TestPublishPanicRecovery 验证处理器 panic 不影响后续处理器
func TestPublishPanicRecovery(t *testing.T) {
	d := NewEventDispatcher()
	var secondCalled bool
	d.Subscribe("test.event", func(payload any) {
		panic("测试 panic")
	})
	d.Subscribe("test.event", func(payload any) {
		secondCalled = true
	})
	d.Publish("test.event", nil)
	if !secondCalled {
		t.Error("第一个处理器 panic 后，第二个处理器应仍被执行")
	}
}

// TestSubscriptionUnsubscribeIdempotent 验证重复取消订阅不会 panic
func TestSubscriptionUnsubscribeIdempotent(t *testing.T) {
	d := NewEventDispatcher()
	sub := d.Subscribe("test.event", func(payload any) {})
	sub.Unsubscribe()
	sub.Unsubscribe() // 不应 panic
}

// TestConcurrentPublish 验证并发发布的线程安全
func TestConcurrentPublish(t *testing.T) {
	d := NewEventDispatcher()
	var mu sync.Mutex
	count := 0
	d.Subscribe("test.event", func(payload any) {
		mu.Lock()
		count++
		mu.Unlock()
	})
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d.Publish("test.event", nil)
		}()
	}
	wg.Wait()
	if count != 100 {
		t.Errorf("并发发布计数不正确: %d", count)
	}
}
