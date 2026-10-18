export type QueuePriority = 0 | 1 | 2;

export interface TranslationQueueItem<T> {
  id: string;
  priority: QueuePriority;
  contentPriority?: number;
  distance: number;
  value: T;
}

export interface TranslationQueueOptions<T> {
  batchSize: number;
  concurrency: number;
  tokenBudget?: number;
  itemTokens?: (item: T) => number;
  worker: (items: T[]) => Promise<void>;
}

export class TranslationQueue<T> {
  #batchSize: number;
  #concurrency: number;
  #tokenBudget: number;
  readonly #itemTokens: (item: T) => number;
  readonly #worker: (items: T[]) => Promise<void>;
  readonly #pending = new Map<string, TranslationQueueItem<T>>();
  #running = 0;
  #cancelled = false;
  #epoch = 0;
  #scheduled = false;

  constructor(options: TranslationQueueOptions<T>) {
    this.#batchSize = options.batchSize;
    this.#concurrency = options.concurrency;
    this.#worker = options.worker;
    this.#tokenBudget = options.tokenBudget ?? Infinity;
    this.#itemTokens = options.itemTokens ?? (() => 1);
  }

  enqueue(items: TranslationQueueItem<T>[]): void {
    this.#cancelled = false;
    for (const item of items) {
      const existing = this.#pending.get(item.id);
      if (!existing || compareQueueItems(item, existing) < 0) {
        this.#pending.set(item.id, item);
      }
    }
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        this.#drain();
      });
    }
  }

  clear(): void {
    this.#cancelled = true;
    this.#pending.clear();
    this.#epoch += 1;
    this.#running = 0;
  }

  configure(
    options: Partial<Pick<TranslationQueueOptions<T>, "batchSize" | "concurrency" | "tokenBudget">>
  ): void {
    if (options.batchSize !== undefined) {
      this.#batchSize = options.batchSize;
    }
    if (options.concurrency !== undefined) {
      this.#concurrency = options.concurrency;
    }
    if (options.tokenBudget !== undefined) this.#tokenBudget = options.tokenBudget;
    this.#drain();
  }

  get size(): number {
    return this.#pending.size;
  }

  get running(): number {
    return this.#running;
  }

  #drain(): void {
    while (!this.#cancelled && this.#running < this.#concurrency && this.#pending.size > 0) {
      const batch = this.#takeBatch();
      const epoch = this.#epoch;
      this.#running += 1;
      void this.#worker(batch)
        .catch(() => undefined)
        .finally(() => {
          if (epoch !== this.#epoch) return;
          this.#running -= 1;
          this.#drain();
        });
    }
  }

  #takeBatch(): T[] {
    const sorted = [...this.#pending.values()].sort(compareQueueItems);
    const batch: TranslationQueueItem<T>[] = [];
    let tokens = 0;
    for (const item of sorted) {
      const cost = this.#itemTokens(item.value);
      if (
        batch.length &&
        (batch.length >= this.#batchSize ||
          tokens + cost > this.#tokenBudget ||
          item.priority !== batch[0].priority)
      )
        break;
      batch.push(item);
      tokens += cost;
    }
    for (const item of batch) {
      this.#pending.delete(item.id);
    }
    return batch.map((item) => item.value);
  }
}

export function compareQueueItems<T>(
  left: TranslationQueueItem<T>,
  right: TranslationQueueItem<T>
): number {
  return (
    left.priority - right.priority ||
    (left.contentPriority ?? 0) - (right.contentPriority ?? 0) ||
    left.distance - right.distance ||
    left.id.localeCompare(right.id, undefined, { numeric: true })
  );
}
