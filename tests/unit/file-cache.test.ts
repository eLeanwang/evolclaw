import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FileCache } from '../../src/core/daemon-file-cache.js';

// relation-prefs 是唯一设了 LRU 上限（512）的组。为可控测试，这里用 513+ 个
// 文件验证「超限驱逐最旧、命中续期、不设限组不受影响」三条不变量。
const CAPPED_GROUP = 'relation-prefs';
const CAP = 512;

describe('FileCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it('caches parsed value and does not re-read on-reload hit', () => {
    const cache = new FileCache();
    const p = write('a.txt', 'v1');
    let loads = 0;
    const read = () => cache.get(p, (raw) => { loads++; return raw; }, { policy: 'on-reload' });
    expect(read()).toBe('v1');
    fs.writeFileSync(p, 'v2');           // 带外改动
    expect(read()).toBe('v1');           // on-reload 不检查 → 仍旧值
    expect(loads).toBe(1);
  });

  it('mtime policy re-reads when file changes', () => {
    const cache = new FileCache();
    const p = write('b.txt', 'v1');
    const read = () => cache.get(p, (raw) => raw, { policy: 'mtime' });
    expect(read()).toBe('v1');
    // 确保 mtime 前进（某些 FS mtime 粒度较粗）
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(p, 'v2');
    fs.utimesSync(p, future, future);
    expect(read()).toBe('v2');
  });

  it('caches non-existent file as null without throwing', () => {
    const cache = new FileCache();
    const missing = path.join(dir, 'nope.txt');
    expect(cache.getText(missing, { policy: 'mtime' })).toBeNull();
  });

  it('evicts oldest entries in a capped group when over capacity', () => {
    const cache = new FileCache();
    // 写 CAP+10 个文件，逐个 get → 触发驱逐
    const paths: string[] = [];
    for (let i = 0; i < CAP + 10; i++) {
      const p = write(`f${i}.txt`, String(i));
      paths.push(p);
      cache.get(p, (raw) => raw, { policy: 'on-reload', group: CAPPED_GROUP });
    }
    // 容量被 bound：组项数不超过 CAP
    expect(cache.size()).toBe(CAP);
    // 最早的 10 个应已被驱逐 → 重新 get 会重新读盘（loader 再次触发）
    let reloaded = false;
    cache.get(paths[0], (raw) => { reloaded = true; return raw; }, { policy: 'on-reload', group: CAPPED_GROUP });
    expect(reloaded).toBe(true);
  });

  it('touch-on-hit keeps a frequently-accessed entry from eviction', () => {
    const cache = new FileCache();
    const hot = write('hot.txt', 'hot');
    cache.get(hot, (raw) => raw, { policy: 'on-reload', group: CAPPED_GROUP });
    // 持续填充其余项，每填一个就访问一次 hot → hot 始终在 LRU 末尾
    for (let i = 0; i < CAP + 50; i++) {
      const p = write(`g${i}.txt`, String(i));
      cache.get(p, (raw) => raw, { policy: 'on-reload', group: CAPPED_GROUP });
      cache.get(hot, (raw) => raw, { policy: 'on-reload', group: CAPPED_GROUP });  // 续期
    }
    // hot 未被驱逐 → 再 get 不触发重读
    let reloaded = false;
    cache.get(hot, (raw) => { reloaded = true; return raw; }, { policy: 'on-reload', group: CAPPED_GROUP });
    expect(reloaded).toBe(false);
  });

  it('does not cap groups without a configured limit', () => {
    const cache = new FileCache();
    for (let i = 0; i < CAP + 100; i++) {
      const p = write(`k${i}.txt`, String(i));
      cache.get(p, (raw) => raw, { policy: 'on-reload', group: 'kits' });
    }
    expect(cache.size()).toBe(CAP + 100);  // 不设限组全部保留
  });

  it('invalidateGroup only drops the named group', () => {
    const cache = new FileCache();
    const a = write('ga.txt', 'a');
    const b = write('gb.txt', 'b');
    cache.get(a, (raw) => raw, { policy: 'on-reload', group: 'agent-files:x' });
    cache.get(b, (raw) => raw, { policy: 'on-reload', group: 'agent-files:y' });
    cache.invalidateGroup('agent-files:x');
    let reloadedA = false, reloadedB = false;
    cache.get(a, () => { reloadedA = true; return 'a'; }, { policy: 'on-reload', group: 'agent-files:x' });
    cache.get(b, () => { reloadedB = true; return 'b'; }, { policy: 'on-reload', group: 'agent-files:y' });
    expect(reloadedA).toBe(true);   // x 被失效 → 重读
    expect(reloadedB).toBe(false);  // y 未受影响
  });

  // ── 监控埋点 ──

  it('stats() counts hits/misses/gets by total, group, and policy', () => {
    const cache = new FileCache();
    const p = write('s.txt', 'v1');
    const read = () => cache.get(p, (raw) => raw, { policy: 'on-reload', group: 'kits' });
    read();   // miss (首次)
    read();   // hit
    read();   // hit
    const st = cache.stats();
    expect(st.totals.gets).toBe(3);
    expect(st.totals.misses).toBe(1);
    expect(st.totals.hits).toBe(2);
    expect(st.byGroup['kits'].gets).toBe(3);
    expect(st.byGroup['kits'].hits).toBe(2);
    expect(st.byPolicy['on-reload'].misses).toBe(1);
    expect(st.size).toBe(1);
    expect(st.occupancy['kits'].size).toBe(1);
    expect(st.occupancy['kits'].bytes).toBe(2);  // 'v1'.length
    expect(st.occupancy['kits'].cap).toBeNull();
  });

  it('stats() counts statChecks and reReads for mtime policy', () => {
    const cache = new FileCache();
    const p = write('m.txt', 'v1');
    const read = () => cache.get(p, (raw) => raw, { policy: 'mtime' });
    read();  // miss + statCheck
    read();  // hit + statCheck (mtime unchanged)
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(p, 'v2');
    fs.utimesSync(p, future, future);
    read();  // reRead + miss + statCheck (mtime changed)
    const st = cache.stats();
    expect(st.totals.statChecks).toBe(3);
    expect(st.totals.reReads).toBe(1);
    expect(st.totals.misses).toBe(2);
    expect(st.totals.hits).toBe(1);
  });

  it('stats() counts evictions and invalidations', () => {
    const cache = new FileCache();
    for (let i = 0; i < CAP + 5; i++) {
      const p = write(`e${i}.txt`, String(i));
      cache.get(p, (raw) => raw, { policy: 'on-reload', group: CAPPED_GROUP });
    }
    let st = cache.stats();
    expect(st.totals.evictions).toBe(5);
    expect(st.byGroup[CAPPED_GROUP].evictions).toBe(5);

    cache.invalidateAll();
    st = cache.stats();
    expect(st.totals.invalidations).toBe(CAP);  // 驱逐后剩 CAP 项被失效
  });

  it('honors a custom read hook instead of reading disk', () => {
    const cache = new FileCache();
    const p = path.join(dir, 'never-on-disk.json');  // 不写盘
    let readCalls = 0;
    const customRead = () => { readCalls++; return '{"from":"hook"}'; };
    const val = cache.get(
      p,
      (raw) => JSON.parse(raw as string),
      { policy: 'mtime', group: 'config', read: customRead },
    );
    expect(val).toEqual({ from: 'hook' });
    expect(readCalls).toBe(1);
    // 第二次 mtime 命中（文件不存在 → mtime=null 稳定），不再调 read
    cache.get(p, (raw) => JSON.parse(raw as string), { policy: 'mtime', group: 'config', read: customRead });
    expect(readCalls).toBe(1);
  });
});
