export class FairMutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  acquire(): Promise<() => void> {
    return new Promise(resolve => {
      const grant = (): void => {
        this.locked = true;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          const next = this.waiters.shift();
          if (next) queueMicrotask(next);
          else this.locked = false;
        });
      };
      if (!this.locked && this.waiters.length === 0) grant();
      else this.waiters.push(grant);
    });
  }

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class KeyedFairMutex {
  private locks = new Map<string, FairMutex>();

  forKey(key: string): FairMutex {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new FairMutex();
      this.locks.set(key, lock);
    }
    return lock;
  }
}
