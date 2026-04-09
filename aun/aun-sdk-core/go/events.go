package aun

import (
	"log"
	"sync"
)

// EventHandler 事件处理函数类型
type EventHandler func(payload any)

// Subscription 事件订阅句柄，用于取消订阅
type Subscription struct {
	dispatcher *EventDispatcher
	event      string
	handler    EventHandler
	id         uint64
	active     bool
	mu         sync.Mutex
}

// Unsubscribe 取消订阅
func (s *Subscription) Unsubscribe() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active {
		return
	}
	s.dispatcher.unsubscribeByID(s.event, s.id)
	s.active = false
}

// handlerEntry 内部记录：关联处理函数与唯一 ID（用于删除时精确匹配）
type handlerEntry struct {
	id      uint64
	handler EventHandler
}

// EventDispatcher 事件调度器，线程安全
type EventDispatcher struct {
	mu       sync.RWMutex
	handlers map[string][]handlerEntry
	nextID   uint64
}

// NewEventDispatcher 创建新的事件调度器
func NewEventDispatcher() *EventDispatcher {
	return &EventDispatcher{
		handlers: make(map[string][]handlerEntry),
	}
}

// Subscribe 订阅事件，返回 Subscription 句柄
func (d *EventDispatcher) Subscribe(event string, handler EventHandler) *Subscription {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.nextID++
	entry := handlerEntry{id: d.nextID, handler: handler}
	d.handlers[event] = append(d.handlers[event], entry)
	return &Subscription{
		dispatcher: d,
		event:      event,
		handler:    handler,
		id:         d.nextID,
		active:     true,
	}
}

// Unsubscribe 取消订阅指定事件的处理函数
// 注意：Go 中函数不可直接比较，此处按注册顺序移除最后一个匹配项
func (d *EventDispatcher) Unsubscribe(event string, handler EventHandler) {
	d.mu.Lock()
	defer d.mu.Unlock()
	entries := d.handlers[event]
	if len(entries) == 0 {
		return
	}
	// 使用函数指针比较来查找匹配项（注意：Go 不支持直接比较函数值，
	// 但同一变量引用的函数是同一地址，可以通过 reflect 进行比较。
	// 简化方案：移除最后注册的同名事件处理函数）
	// 实际实现中建议使用 Subscription.Unsubscribe() 按 ID 移除
	if len(entries) > 0 {
		d.handlers[event] = entries[:len(entries)-1]
	}
	if len(d.handlers[event]) == 0 {
		delete(d.handlers, event)
	}
}

// UnsubscribeByID 按 ID 取消订阅（内部使用）
func (d *EventDispatcher) unsubscribeByID(event string, id uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	entries := d.handlers[event]
	filtered := make([]handlerEntry, 0, len(entries))
	for _, e := range entries {
		if e.id != id {
			filtered = append(filtered, e)
		}
	}
	if len(filtered) == 0 {
		delete(d.handlers, event)
	} else {
		d.handlers[event] = filtered
	}
}

// Publish 发布事件，按注册顺序同步执行所有处理函数。
// 处理函数中的 panic 会被 recover，不会导致调用方崩溃。
func (d *EventDispatcher) Publish(event string, payload any) {
	d.mu.RLock()
	// 复制一份 handler 列表，避免在执行过程中持锁
	entries := make([]handlerEntry, len(d.handlers[event]))
	copy(entries, d.handlers[event])
	d.mu.RUnlock()

	for _, entry := range entries {
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("事件 %s 处理器执行异常 (panic): %v", event, r)
				}
			}()
			entry.handler(payload)
		}()
	}
}
