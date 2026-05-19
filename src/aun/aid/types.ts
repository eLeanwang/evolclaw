export interface AidInfo {
  aid: string;
  hasPrivateKey: boolean;
  hasAgentMd: boolean;
}

export interface AidShowResult {
  aid: string;
  hasPrivateKey: boolean;
  hasAgentMd: boolean;
  certExpiresAt: string | null;
  certSubject: string | null;
}

export interface AidLookupResult {
  exists: boolean;
  aid: string;
  gateway: string;
  content?: string;
  error?: string;
}

export interface AidCreateResult {
  aid: string;
  alreadyExisted: boolean;
  gateway: string;
  client: any; // AUNClient — dynamic import, avoid static dep
}
