export function getErrorMessage(error: any): string {
  const msg = error?.message || String(error);

  if (msg.includes('API Error: 400')) {
    return '⚠️ 请求格式错误，请检查输入内容';
  }
  if (msg.includes('API Error: 500')) {
    return '⚠️ API 服务暂时不可用，请稍后重试';
  }
  if (msg.includes('API Error: 429')) {
    return '⚠️ 请求过于频繁，请稍后再试';
  }
  if (msg.includes('timeout')) {
    return '⚠️ 请求超时，请重试';
  }
  if (msg.includes('permission') || msg.includes('im:resource')) {
    return '⚠️ 权限不足，请联系管理员配置应用权限';
  }

  return '⚠️ 处理消息时出错，请稍后重试';
}
