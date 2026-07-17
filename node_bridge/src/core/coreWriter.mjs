import { CoreError, coreError } from './coreErrors.mjs';

const ACTIVE_WRITERS = new Set();
const MAX_HIGH_BURST = 8;

class CoreWriter {
  #dbIdentity;
  #runTransaction;
  #high = [];
  #normal = [];
  #accepting = true;
  #draining = false;
  #highBurst = 0;
  #idleWaiters = [];

  constructor({ dbIdentity, runTransaction }) {
    if (!String(dbIdentity || '').trim() || typeof runTransaction !== 'function') {
      throw coreError('CORE_WRITER_AUTHORITY_REQUIRED', 'CoreWriter requires private database transaction authority');
    }
    if (ACTIVE_WRITERS.has(dbIdentity)) {
      throw coreError('CORE_WRITER_ALREADY_ACTIVE', 'a logical CoreWriter already owns this database');
    }
    this.#dbIdentity = dbIdentity;
    this.#runTransaction = runTransaction;
    ACTIVE_WRITERS.add(dbIdentity);
  }

  publicFacade() {
    return Object.freeze({
      write: (callback, options) => this.#write(callback, options),
    });
  }

  close() {
    this.#accepting = false;
    if (!this.#draining && this.#high.length === 0 && this.#normal.length === 0) {
      this.#release();
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #write(callback, { priority = 'normal' } = {}) {
    if (!this.#accepting) return Promise.reject(coreError('CORE_WRITER_CLOSED', 'CoreWriter is closed'));
    if (typeof callback !== 'function') return Promise.reject(coreError('CORE_WRITE_CALLBACK_REQUIRED', 'write callback is required'));
    if (!['normal', 'high'].includes(priority)) return Promise.reject(coreError('CORE_WRITE_PRIORITY_INVALID', 'priority must be normal or high'));
    return new Promise((resolve, reject) => {
      const queue = priority === 'high' ? this.#high : this.#normal;
      queue.push({ callback, resolve, reject });
      this.#schedule();
    });
  }

  #release() {
    ACTIVE_WRITERS.delete(this.#dbIdentity);
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }

  #schedule() {
    if (this.#draining) return;
    this.#draining = true;
    queueMicrotask(() => this.#drain());
  }

  #next() {
    if (this.#normal.length > 0 && (this.#high.length === 0 || this.#highBurst >= MAX_HIGH_BURST)) {
      this.#highBurst = 0;
      return this.#normal.shift();
    }
    if (this.#high.length > 0) {
      this.#highBurst += 1;
      return this.#high.shift();
    }
    this.#highBurst = 0;
    return this.#normal.shift();
  }

  #drain() {
    const item = this.#next();
    if (!item) {
      this.#draining = false;
      if (!this.#accepting) this.#release();
      return;
    }
    try {
      item.resolve(this.#runTransaction(item.callback));
    } catch (error) {
      item.reject(error instanceof CoreError
        ? error
        : coreError('CORE_WRITE_FAILED', `Core write failed: ${error instanceof Error ? error.message : String(error)}`, error));
    }
    queueMicrotask(() => this.#drain());
  }
}

export function createCoreWriter(authority) {
  const writer = new CoreWriter(authority);
  return Object.freeze({
    facade: writer.publicFacade(),
    close: () => writer.close(),
  });
}
