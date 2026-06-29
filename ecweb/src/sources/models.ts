import fs from 'fs';
import path from 'path';

interface CatalogModule {
  getCatalog: (self?: string, ba?: string) => Promise<{ models: RawModelEntry[]; source: string }>;
}

interface RawModelEntry {
  id: string;
  owned_by?: string;
  created?: number;
}

export interface ModelCatalogApiEntry {
  id: string;
  owned_by?: string;
  created?: number;
  family: string;
  status: 'alias' | 'available';
  isAlias: boolean;
}

export interface ModelCatalogSnapshot {
  models: ModelCatalogApiEntry[];
  source: string;
  lastUpdate: string;
}

function toFileUrl(p: string): string {
  return process.platform === 'win32'
    ? new URL('file:///' + p.replace(/\\/g, '/')).href
    : p;
}

async function getCatalogModule(): Promise<CatalogModule> {
  const catalogPath = path.join(process.cwd(), 'dist', 'core', 'model', 'model-catalog.js');
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Model catalog module not found. Is evolclaw built? cwd=${process.cwd()}`);
  }

  const mod = await import(toFileUrl(catalogPath));
  if (typeof mod.getCatalog !== 'function') {
    throw new Error('getCatalog not found in model-catalog.js');
  }
  return { getCatalog: mod.getCatalog as CatalogModule['getCatalog'] };
}

export function inferModelFamily(id: string): string {
  if (['opus', 'sonnet', 'haiku'].includes(id)) return id;

  const claude = id.match(/^claude-([a-z0-9]+)-/i);
  if (claude) return claude[1].toLowerCase();

  const vendor = id.match(/^([a-z0-9]+)[-_]/i);
  return vendor ? vendor[1].toLowerCase() : 'other';
}

export function normalizeModelEntries(models: RawModelEntry[]): ModelCatalogApiEntry[] {
  const seen = new Set<string>();
  const out: ModelCatalogApiEntry[] = [];

  for (const model of models || []) {
    if (!model || typeof model.id !== 'string') continue;
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const isAlias = model.owned_by === 'alias';
    out.push({
      id,
      owned_by: model.owned_by,
      created: model.created,
      family: inferModelFamily(id),
      status: isAlias ? 'alias' : 'available',
      isAlias
    });
  }

  return out;
}

export async function getModelCatalogSnapshot(baseagent = 'claude'): Promise<ModelCatalogSnapshot> {
  const { getCatalog } = await getCatalogModule();
  const catalog = await getCatalog(undefined, baseagent);
  return {
    models: normalizeModelEntries(catalog.models || []),
    source: catalog.source || 'unknown',
    lastUpdate: new Date().toISOString()
  };
}

function sendJson(res: any, status: number, payload: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function handleModelsApi(req: any, res: any): Promise<void> {
  try {
    const url = new URL(req.url || '', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/models/catalog') {
      const baseagent = url.searchParams.get('baseagent') || 'claude';
      if (!/^[a-z0-9_-]+$/i.test(baseagent)) {
        sendJson(res, 400, { success: false, error: 'Invalid baseagent' });
        return;
      }

      const data = await getModelCatalogSnapshot(baseagent);
      sendJson(res, 200, { success: true, data });
      return;
    }

    sendJson(res, 404, { success: false, error: 'Not found' });
  } catch (err: any) {
    console.error('[models] API error:', err);
    sendJson(res, 500, { success: false, error: err.message });
  }
}
