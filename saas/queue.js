import { randomBytes } from "node:crypto";
import { createClient } from "redis";

const DEFAULT_QUEUE_NAME = "patchproof:jobs";
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

export function createJobQueue(options = {}) {
  const driver =
    options.driver ||
    process.env.PATCHPROOF_QUEUE_DRIVER ||
    (process.env.REDIS_URL ? "redis" : "memory");
  if (driver === "redis") return new RedisJobQueue(options.redis || options);
  return new MemoryJobQueue(options.memory || options);
}

export class MemoryJobQueue {
  constructor(options = {}) {
    this.driver = "memory";
    this.items = [];
    this.leased = new Map();
    this.dead = [];
    this.leaseMs = Number(options.leaseMs || process.env.PATCHPROOF_QUEUE_LEASE_MS || DEFAULT_LEASE_MS);
    this.maxAttempts = Number(options.maxAttempts || process.env.PATCHPROOF_QUEUE_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS);
  }

  async connect() {}

  async close() {}

  async enqueue(payload) {
    const item = sanitizePayload({
      ...payload,
      queueAttempt: Number(payload?.queueAttempt || 0),
      queuedAt: payload?.queuedAt || nowIso()
    });
    this.items.push(item);
    return item;
  }

  async claim({ timeoutSeconds = 1, leaseMs = this.leaseMs } = {}) {
    this.requeueExpired();
    let item = this.items.shift();
    if (!item && timeoutSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, timeoutSeconds * 1000));
      this.requeueExpired();
      item = this.items.shift();
    }
    if (!item) return null;
    return this.lease(item, leaseMs);
  }

  async ack(payload) {
    const leaseId = payload?.leaseId;
    if (leaseId && this.leased.delete(leaseId)) return { acked: true };
    for (const [id, item] of this.leased.entries()) {
      if (item.jobId === payload?.jobId) {
        this.leased.delete(id);
        return { acked: true };
      }
    }
    return { acked: false };
  }

  async fail(payload, error, options = {}) {
    await this.ack(payload);
    const attempts = Number(payload?.queueAttempt || 1);
    const retry = options.retry !== false && attempts < this.maxAttempts;
    const failedPayload = sanitizePayload({
      ...payload,
      lastError: error?.message || String(error || "Job failed."),
      failedAt: nowIso()
    });
    if (retry) {
      this.items.push({ ...failedPayload, queuedAt: nowIso() });
    } else {
      this.dead.push(failedPayload);
    }
    return { retry, deadLettered: !retry, attempts, maxAttempts: this.maxAttempts };
  }

  async depth() {
    this.requeueExpired();
    return this.items.length;
  }

  async inFlightDepth() {
    this.requeueExpired();
    return this.leased.size;
  }

  async deadDepth() {
    return this.dead.length;
  }

  async health() {
    this.requeueExpired();
    return {
      ok: true,
      driver: this.driver,
      depth: this.items.length,
      inFlight: this.leased.size,
      dead: this.dead.length,
      leaseMs: this.leaseMs,
      maxAttempts: this.maxAttempts
    };
  }

  lease(item, leaseMs) {
    const leaseId = id("lease");
    const leased = {
      ...sanitizePayload(item),
      queueAttempt: Number(item.queueAttempt || 0) + 1,
      leaseId,
      leasedAt: nowIso(),
      leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString()
    };
    this.leased.set(leaseId, leased);
    return leased;
  }

  requeueExpired() {
    const now = Date.now();
    for (const [leaseId, item] of [...this.leased.entries()]) {
      const expiresAt = Date.parse(item.leaseExpiresAt || "");
      if (Number.isFinite(expiresAt) && expiresAt > now) continue;
      this.leased.delete(leaseId);
      const expired = sanitizePayload({
        ...item,
        lastError: item.lastError || "Queue lease expired before acknowledgement.",
        failedAt: nowIso()
      });
      if (Number(item.queueAttempt || 0) < this.maxAttempts) {
        this.items.push({ ...expired, queuedAt: nowIso() });
      } else {
        this.dead.push(expired);
      }
    }
  }
}

export class RedisJobQueue {
  constructor(options = {}) {
    this.driver = "redis";
    this.queueName = options.queueName || process.env.PATCHPROOF_REDIS_QUEUE || DEFAULT_QUEUE_NAME;
    this.processingName = options.processingName || `${this.queueName}:processing`;
    this.deadName = options.deadName || `${this.queueName}:dead`;
    this.leaseMs = Number(options.leaseMs || process.env.PATCHPROOF_QUEUE_LEASE_MS || DEFAULT_LEASE_MS);
    this.maxAttempts = Number(options.maxAttempts || process.env.PATCHPROOF_QUEUE_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS);
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
    const item = sanitizePayload({
      ...payload,
      queueAttempt: Number(payload?.queueAttempt || 0),
      queuedAt: payload?.queuedAt || nowIso()
    });
    await this.client.rPush(this.queueName, JSON.stringify(item));
    return item;
  }

  async claim({ timeoutSeconds = 5, leaseMs = this.leaseMs } = {}) {
    await this.connect();
    await this.requeueExpired();
    const raw = await this.client.sendCommand([
      "BRPOPLPUSH",
      this.queueName,
      this.processingName,
      String(Math.max(0, Number(timeoutSeconds || 0)))
    ]);
    if (!raw) return null;
    const item = parseQueuePayload(raw);
    const leased = {
      ...sanitizePayload(item),
      queueAttempt: Number(item.queueAttempt || 0) + 1,
      leaseId: id("lease"),
      leasedAt: nowIso(),
      leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString()
    };
    const leasedRaw = JSON.stringify(leased);
    await this.client.lRem(this.processingName, 1, raw);
    await this.client.lPush(this.processingName, leasedRaw);
    return { ...leased, __queueRaw: leasedRaw };
  }

  async ack(payload) {
    await this.connect();
    const raw = await this.findProcessingRaw(payload);
    if (!raw) return { acked: false };
    await this.client.lRem(this.processingName, 1, raw);
    return { acked: true };
  }

  async fail(payload, error, options = {}) {
    await this.connect();
    const raw = await this.findProcessingRaw(payload);
    if (raw) await this.client.lRem(this.processingName, 1, raw);
    const attempts = Number(payload?.queueAttempt || 1);
    const retry = options.retry !== false && attempts < this.maxAttempts;
    const failedPayload = sanitizePayload({
      ...payload,
      lastError: error?.message || String(error || "Job failed."),
      failedAt: nowIso()
    });
    if (retry) {
      await this.client.rPush(this.queueName, JSON.stringify({ ...failedPayload, queuedAt: nowIso() }));
    } else {
      await this.client.rPush(this.deadName, JSON.stringify(failedPayload));
    }
    return { retry, deadLettered: !retry, attempts, maxAttempts: this.maxAttempts };
  }

  async depth() {
    await this.connect();
    await this.requeueExpired();
    return this.client.lLen(this.queueName);
  }

  async inFlightDepth() {
    await this.connect();
    await this.requeueExpired();
    return this.client.lLen(this.processingName);
  }

  async deadDepth() {
    await this.connect();
    return this.client.lLen(this.deadName);
  }

  async health() {
    await this.connect();
    await this.client.ping();
    return {
      ok: true,
      driver: this.driver,
      depth: await this.depth(),
      inFlight: await this.inFlightDepth(),
      dead: await this.deadDepth(),
      leaseMs: this.leaseMs,
      maxAttempts: this.maxAttempts
    };
  }

  async requeueExpired() {
    const rows = await this.client.lRange(this.processingName, 0, -1);
    const now = Date.now();
    for (const raw of rows) {
      const item = parseQueuePayload(raw);
      const expiresAt = Date.parse(item.leaseExpiresAt || "");
      if (Number.isFinite(expiresAt) && expiresAt > now) continue;
      await this.client.lRem(this.processingName, 1, raw);
      const expired = sanitizePayload({
        ...item,
        lastError: item.lastError || "Queue lease expired before acknowledgement.",
        failedAt: nowIso()
      });
      if (Number(item.queueAttempt || 0) < this.maxAttempts) {
        await this.client.rPush(this.queueName, JSON.stringify({ ...expired, queuedAt: nowIso() }));
      } else {
        await this.client.rPush(this.deadName, JSON.stringify(expired));
      }
    }
  }

  async findProcessingRaw(payload) {
    if (payload?.__queueRaw) return payload.__queueRaw;
    const rows = await this.client.lRange(this.processingName, 0, -1);
    return rows.find((raw) => {
      const item = parseQueuePayload(raw);
      return (payload?.leaseId && item.leaseId === payload.leaseId) || item.jobId === payload?.jobId;
    }) || null;
  }
}

function sanitizePayload(payload = {}) {
  const { __queueRaw, leaseId, leasedAt, leaseExpiresAt, ...rest } = payload;
  return rest;
}

function parseQueuePayload(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { malformed: true, raw };
  }
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}
