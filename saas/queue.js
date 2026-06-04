import { createClient } from "redis";

const DEFAULT_QUEUE_NAME = "patchproof:jobs";

export function createJobQueue(options = {}) {
  const driver =
    options.driver ||
    process.env.PATCHPROOF_QUEUE_DRIVER ||
    (process.env.REDIS_URL ? "redis" : "memory");
  if (driver === "redis") return new RedisJobQueue(options.redis);
  return new MemoryJobQueue();
}

export class MemoryJobQueue {
  constructor() {
    this.driver = "memory";
    this.items = [];
  }

  async connect() {}

  async close() {}

  async enqueue(payload) {
    this.items.push(payload);
    return payload;
  }

  async claim({ timeoutSeconds = 1 } = {}) {
    const existing = this.items.shift();
    if (existing) return existing;
    await new Promise((resolve) => setTimeout(resolve, timeoutSeconds * 1000));
    return null;
  }

  async depth() {
    return this.items.length;
  }

  async health() {
    return { ok: true, driver: this.driver, depth: this.items.length };
  }
}

export class RedisJobQueue {
  constructor(options = {}) {
    this.driver = "redis";
    this.queueName = options.queueName || process.env.PATCHPROOF_REDIS_QUEUE || DEFAULT_QUEUE_NAME;
    this.client =
      options.client ||
      createClient({
        url: options.url || process.env.REDIS_URL || "redis://127.0.0.1:6379"
      });
    this.connected = Boolean(options.client);
    this.client.on?.("error", () => {});
  }

  async connect() {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
  }

  async close() {
    if (!this.connected) return;
    await this.client.quit();
    this.connected = false;
  }

  async enqueue(payload) {
    await this.connect();
    await this.client.rPush(this.queueName, JSON.stringify(payload));
    return payload;
  }

  async claim({ timeoutSeconds = 5 } = {}) {
    await this.connect();
    const result = await this.client.blPop(this.queueName, timeoutSeconds);
    if (!result) return null;
    return JSON.parse(result.element);
  }

  async depth() {
    await this.connect();
    return this.client.lLen(this.queueName);
  }

  async health() {
    await this.connect();
    await this.client.ping();
    return { ok: true, driver: this.driver, depth: await this.depth() };
  }
}
