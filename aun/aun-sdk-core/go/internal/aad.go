package internal

import (
	"encoding/json"
)

// SerializeAAD 将 AAD 字典序列化为字节（排序键 + 紧凑格式）
// 与 Python json.dumps(sort_keys=True, separators=(",",":")) 完全一致。
// Go 的 encoding/json 默认对 map 键排序，因此直接使用 json.Marshal 即可。
func SerializeAAD(aad map[string]any) ([]byte, error) {
	return json.Marshal(aad)
}
