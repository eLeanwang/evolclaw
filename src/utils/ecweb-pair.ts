/**
 * ECWeb 配对码取码 helper（共享给 daemon 和 CLI）。
 *
 * 配对码是 ecweb 进程自己生成并持有的内部状态。daemon/CLI 通过 ecweb 的
 * localhost-only HTTP 接口 GET /api/pair-code 取当前码（远程访问被 ecweb 403 拒绝）。
 */

/** 经 localhost 拉取 ecweb 当前配对码（仅本机可取）。失败返回 null。 */
export async function fetchEcwebPairCode(port: number): Promise<{ code: string; expiresAt: number } | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/pair-code`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    return await resp.json() as { code: string; expiresAt: number };
  } catch {
    return null;
  }
}
