/**
 * AUN Service Proxy 集成 — 把本地 HTTP/WS 服务通过控制 AID 暴露到 AUN 网络。
 *
 * 访问入口：https://{控制AID}/{serviceName}/...
 * proxy-server 剥掉 {serviceName} 前缀后，把剩余 path 经隧道转发，
 * ServiceProxyClient 真实 HTTP/WS 回连本地 endpoint（反向代理）。
 *
 * 关键设计：
 * - providerAid = 控制 AID（daemon 进程身份，pureIdentity 常驻 AUN）
 * - aunClient 生命周期陷阱：AUNChannel 重连会销毁重建底层 client，
 *   所以不能把 client 引用直接交给 ServiceProxyClient；传一个动态解引用的
 *   facade，每次 .call()/.authenticate()/._tokenStore 都读 channel 当前 client。
 *   serveForever(persistent) 的指数退避会在 client 缺失时自动等待恢复。
 * - endpoint 发现：source='ecweb' 时读 data/instance/ecweb-*.json 的 port。
 * - 失败降级：任何异常只 warn，绝不影响 daemon 主流程。
 */

import fs from 'fs';
import path from 'path';
import { ServiceProxyClient, EndpointPolicy } from '@agentunion/fastaun';
import type { AUNChannel } from '../channels/aun.js';
import type { ServiceProxyConfig, ServiceProxyService } from '../config-store.js';
import { resolvePaths } from '../paths.js';
import { logger } from '../utils/logger.js';

const LOG = '[ServiceProxy]';

interface EcwebInstanceRecord {
  pid: number;
  startedAt: number;
  port: number;
}

/**
 * 读 data/instance/ 下存活的 ecweb 实例端口。
 * 取 startedAt 最新的一条（多实例保护下通常只有一条存活）。
 */
function discoverEcwebPort(): number | null {
  const dir = resolvePaths().instanceDir;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const records: EcwebInstanceRecord[] = [];
  for (const file of files) {
    if (!/^(ecweb|watch-web)-\d+\.json$/.test(file)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as EcwebInstanceRecord;
      if (rec && typeof rec.pid === 'number' && isProcessAlive(rec.pid) && typeof rec.port === 'number') {
        records.push(rec);
      }
    } catch {
      /* 跳过损坏文件 */
    }
  }
  if (records.length === 0) return null;
  records.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return records[0].port;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM = 进程存在但无权限（仍算存活）；ESRCH = 不存在
    return e?.code === 'EPERM';
  }
}

/**
 * 把单个服务配置解析为本地回连 endpoint。无法解析返回 null。
 */
function resolveEndpoint(svc: ServiceProxyService): string | null {
  if (svc.source === 'ecweb') {
    const port = discoverEcwebPort();
    if (!port) {
      logger.warn(`${LOG} 服务 "${svc.name}" source=ecweb 但未发现存活的 ecweb 实例，跳过`);
      return null;
    }
    return `http://127.0.0.1:${port}`;
  }
  // static
  if (svc.endpoint && svc.endpoint.trim()) return svc.endpoint.trim();
  logger.warn(`${LOG} 服务 "${svc.name}" source=static 但未配置 endpoint，跳过`);
  return null;
}

export interface ServiceProxyHandle {
  stop(): void;
}

/**
 * 启动 Service Proxy。挂在控制 AUNChannel 上，常驻反向代理隧道。
 * 返回 handle 供关停；启动失败返回 null（已 warn，不抛异常）。
 */
export function startServiceProxy(
  controlChannel: AUNChannel,
  providerAid: string,
  config: ServiceProxyConfig,
): ServiceProxyHandle | null {
  try {
    const services = (config.services ?? []).filter((s) => s.enabled !== false);
    if (services.length === 0) {
      logger.info(`${LOG} 无启用的服务，跳过`);
      return null;
    }

    // 动态解引用 facade：每次访问都读 channel 当前 client，规避重连换 client 的死引用问题。
    const aunFacade = {
      call: (method: string, params?: any) => {
        const client = controlChannel.getClient() as any;
        if (!client) return Promise.reject(new Error('AUN control client not connected'));
        return client.call(method, params ?? {});
      },
      authenticate: () => {
        const client = controlChannel.getClient() as any;
        if (!client || typeof client.authenticate !== 'function') {
          return Promise.reject(new Error('AUN control client not connected'));
        }
        return client.authenticate();
      },
      on: (event: string, handler: (payload: unknown) => void) => {
        const client = controlChannel.getClient() as any;
        return client?.on?.(event, handler);
      },
      get _tokenStore() {
        return (controlChannel.getClient() as any)?._tokenStore;
      },
      // ServiceProxyClient._resolveCachedAccessToken 依次读取 _identity / _auth /
      // _tokenStore + deviceId 来复用 AUNChannel 已签发的 access_token。控制 AID 在
      // connect 时已 authenticate（client 处于 ready 态），若这些字段不透出，
      // _ensureAccessToken 会回退到 authenticate() 并抛 "authenticate not allowed
      // in state ready"，导致隧道永远连不上 proxy-server。动态解引用，规避重连换 client。
      get _identity() {
        return (controlChannel.getClient() as any)?._identity;
      },
      get _auth() {
        return (controlChannel.getClient() as any)?._auth;
      },
      get _deviceId() {
        return (controlChannel.getClient() as any)?._deviceId;
      },
    };

    // endpoint 白名单：只允许回连本机回环（127.0.0.1 / localhost 默认放行）。
    // logger：把 SDK 内部 _logWarn/_logError 接到 evolclaw logger，
    // 否则 serveForever() 的隧道失败被静默吞掉（无任何日志），无法排障。
    const proxyClient = new ServiceProxyClient({
      providerAid,
      aunClient: aunFacade as any,
      endpointPolicy: new EndpointPolicy(),
      logger: {
        error: (msg: string, err?: Error) => logger.error(`${LOG} ${msg}${err ? ` ${err.stack || err.message}` : ''}`),
        warn: (msg: string) => logger.warn(`${LOG} ${msg}`),
        info: (msg: string) => logger.info(`${LOG} ${msg}`),
        debug: (msg: string) => logger.debug(`${LOG} ${msg}`),
      },
    });

    let registered = 0;
    for (const svc of services) {
      const endpoint = resolveEndpoint(svc);
      if (!endpoint) continue;
      try {
        proxyClient.registerService(svc.name, endpoint, {
          serviceType: svc.serviceType ?? 'http',
          visibility: svc.visibility ?? 'private',
          metadata: svc.metadata ?? {},
        });
        registered += 1;
        logger.info(`${LOG} 注册服务 "${svc.name}" → ${endpoint} (visibility=${svc.visibility ?? 'private'})`);
      } catch (e: any) {
        logger.warn(`${LOG} 注册服务 "${svc.name}" 失败: ${e?.message || e}`);
      }
    }

    if (registered === 0) {
      logger.warn(`${LOG} 没有成功注册任何服务，不启动隧道`);
      return null;
    }

    // 常驻持久隧道（内部自带指数退避重连 + client 缺失时自动等待）。
    // 不 await：后台运行，不阻塞 daemon 启动。
    proxyClient
      .serveForever({ connectionMode: 'persistent' })
      .then((stats) => {
        logger.info(`${LOG} serveForever 退出: ${JSON.stringify(stats)}`);
      })
      .catch((e: any) => {
        logger.warn(`${LOG} serveForever 异常退出: ${e?.message || e}`);
      });

    logger.info(`${LOG} ✓ 已启动，provider=${providerAid}，注册 ${registered} 个服务`);
    return {
      stop: () => {
        try {
          proxyClient.stop();
        } catch {
          /* noop */
        }
      },
    };
  } catch (e: any) {
    logger.warn(`${LOG} 启动失败（不影响 daemon 主流程）: ${e?.message || e}`);
    return null;
  }
}
