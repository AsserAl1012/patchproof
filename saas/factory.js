import { JsonSaasStore } from "./store.js";
import { PostgresSaasStore } from "./postgres-store.js";

export function createSaasStore(options = {}) {
  if (options.store) return options.store;
  const driver =
    options.driver ||
    process.env.PATCHPROOF_STORE_DRIVER ||
    (process.env.DATABASE_URL || process.env.NODE_ENV === "production" ? "postgres" : "json");
  if (driver === "postgres") return new PostgresSaasStore(options.postgres);
  if (driver === "json") return new JsonSaasStore(options.json || options.storeOptions);
  throw new Error(`Unknown PATCHPROOF_STORE_DRIVER '${driver}'.`);
}
