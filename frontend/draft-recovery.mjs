// Browser-only recovery. No server requests or WeChat operations occur here.
// The two-second interval bounds scheduling, not blocked storage or page shutdown:
// beforeunload cannot guarantee completion of an asynchronous IndexedDB write.
const CONTENT_LIMIT = 5 * 1024 * 1024;
const METADATA_LIMIT = 256 * 1024;
const encoder = new TextEncoder();

function jsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value))
    throw new TypeError("Metadata must be plain JSON");
  const array = Array.isArray(value);
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new TypeError("Metadata must be plain JSON");
  }
  if (Object.getOwnPropertySymbols(value).length)
    throw new TypeError("Metadata must be plain JSON");
  ancestors.add(value);
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))
      throw new TypeError("Metadata must be plain JSON");
  }
  let result;
  if (array) {
    if (
      keys.length !== value.length ||
      keys.some((key) => !/^(?:0|[1-9][0-9]*)$/.test(key))
    )
      throw new TypeError("Metadata must be plain JSON");
    result = value.map((item) => jsonValue(item, ancestors));
  } else {
    result = Object.fromEntries(
      keys.map((key) => [key, jsonValue(value[key], ancestors)]),
    );
  }
  ancestors.delete(value);
  return result;
}

function validId(id) {
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 128 ||
    /[\u0000-\u001f]/.test(id)
  )
    throw new TypeError("Invalid recovery draft id");
  return id;
}

function recordOf(value, updatedAt) {
  validId(value?.id);
  if (typeof value.content !== "string")
    throw new TypeError("Recovery content must be text");
  if (encoder.encode(value.content).byteLength > CONTENT_LIMIT)
    throw new RangeError("Recovery content exceeds 5 MiB");
  if (
    !value.metadata ||
    Array.isArray(value.metadata) ||
    typeof value.metadata !== "object"
  )
    throw new TypeError("Metadata must be a plain JSON object");
  const metadata = jsonValue(value.metadata);
  if (encoder.encode(JSON.stringify(metadata)).byteLength > METADATA_LIMIT)
    throw new RangeError("Recovery metadata exceeds 256 KiB");
  if (value.revision !== undefined && typeof value.revision !== "string")
    throw new TypeError("Invalid recovery base revision");
  if (!Number.isFinite(updatedAt))
    throw new TypeError("Invalid recovery timestamp");
  return {
    id: value.id,
    ...(value.recoveryId === undefined
      ? {}
      : { recoveryId: validId(value.recoveryId) }),
    content: value.content,
    metadata,
    revision: value.revision ?? "",
    updatedAt,
  };
}

const identity = (record) => JSON.stringify([record.content, record.metadata]);
const recovered = (record) => ({
  ...recordOf(record, record.updatedAt),
  recoveryId: record.recoveryId ?? record.id,
});
const sameRecord = (first, second) =>
  first &&
  second &&
  first.id === second.id &&
  first.recoveryId === second.recoveryId &&
  first.revision === second.revision &&
  first.updatedAt === second.updatedAt &&
  identity(first) === identity(second);
function countLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw new RangeError("Recovery record limit must be between 1 and 100");
  return value;
}

/** storage: async get(recoveryId), put(record), delete(recoveryId), list().
 * deleteIfUnchanged(expectedRecord) must atomically compare and delete; without
 * it clearSaved fails closed. Each controller writes independent recoveryIds;
 * record.id remains the actual draft id. Legacy records use recoveryId=id.
 * Records also contain content/metadata/revision (base revision)/updatedAt (ms).
 * changed() returns a boolean; flush() rejects on failure and retains dirty data.
 * clearSaved() resolves true only when the acknowledged exact text+metadata is
 * removed safely. list/read return validated copies. discard() is explicit.
 * onState receives {status,id,time,error?}; clear/discard adds cleared:true.
 */
export function createRecoveryController({
  storage,
  capture,
  onState = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  maxRecords = 20,
}) {
  countLimit(maxRecords);
  if (
    !storage ||
    ["get", "put", "delete", "list"].some(
      (key) => typeof storage[key] !== "function",
    ) ||
    typeof capture !== "function"
  ) {
    throw new TypeError("Recovery requires storage and capture");
  }
  const entries = new Map();
  const recoveryKeys = new Map();
  const ownKey = (id) => {
    if (!recoveryKeys.has(id))
      recoveryKeys.set(id, `recovery-${globalThis.crypto.randomUUID()}`);
    return recoveryKeys.get(id);
  };
  let generation = 0,
    idleTimer = null,
    maximumTimer = null,
    tail = Promise.resolve();
  const report = (status, id, extra = {}) =>
    onState({ status, id, time: now(), ...extra });
  const fail = (id, error) => report("error", id, { error });
  const enqueue = (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  const cancelTimers = () => {
    if (idleTimer !== null) clearTimer(idleTimer);
    if (maximumTimer !== null) clearTimer(maximumTimer);
    idleTimer = maximumTimer = null;
  };
  const schedule = () => {
    if (idleTimer !== null) clearTimer(idleTimer);
    const write = () => {
      persistPending().catch(() => {});
    };
    idleTimer = setTimer(write, 1000);
    if (maximumTimer === null) maximumTimer = setTimer(write, 2000);
  };
  const observe = (value) => {
    if (value === null || value === undefined) return null;
    const record = recordOf({ ...value, recoveryId: ownKey(value.id) }, now()),
      key = identity(record),
      previous = entries.get(record.id);
    if (previous?.key === key) {
      previous.record.revision = record.revision;
      return previous;
    }
    const entry = { record, key, generation: ++generation, dirty: true };
    entries.set(record.id, entry);
    report("pending", record.id);
    return entry;
  };
  const sample = () => observe(capture());
  function persistPending() {
    cancelTimers();
    const batch = [...entries.values()]
      .filter((entry) => entry.dirty)
      .map((entry) => ({
        ...entry,
        record: recordOf(entry.record, entry.record.updatedAt),
      }));
    return enqueue(async () => {
      let firstError;
      for (const entry of batch) {
        const id = entry.record.id;
        if (entries.get(id)?.generation !== entry.generation) continue;
        try {
          report("saving", id);
          const stored = await storage.list();
          if (
            !stored.some(
              (record) =>
                (record.recoveryId ?? record.id) === entry.record.recoveryId,
            ) &&
            stored.length >= maxRecords
          )
            throw new RangeError(
              "Recovery record limit reached; restore or discard an existing record",
            );
          await storage.put(entry.record);
          const latest = entries.get(id);
          if (latest?.generation === entry.generation) {
            latest.dirty = false;
            report("stored", id);
          }
        } catch (error) {
          if (entries.get(id)?.generation === entry.generation) fail(id, error);
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    });
  }
  function changed() {
    try {
      const entry = sample();
      if (entry?.dirty) schedule();
      return Boolean(entry);
    } catch (error) {
      fail(null, error);
      return false;
    }
  }
  function flush() {
    try {
      sample();
      return persistPending();
    } catch (error) {
      fail(null, error);
      return Promise.reject(error);
    }
  }
  async function clearSaved(acknowledged) {
    let ack;
    try {
      ack = recordOf(acknowledged, now());
    } catch (error) {
      fail(acknowledged?.id ?? null, error);
      throw error;
    }
    const key = identity(ack),
      id = ack.id;
    // The editor might have received input without a changed notification yet.
    const protectCurrent = () => {
      const visible = capture();
      if (visible?.id === id) {
        const current = recordOf(visible, now());
        if (identity(current) !== key) {
          observe(current);
          schedule();
          return true;
        }
      }
      return false;
    };
    try {
      protectCurrent();
      const expectedGeneration = entries.get(id)?.generation;
      return await enqueue(async () => {
        const protectedEdit = () =>
          protectCurrent() ||
          entries.get(id)?.generation !== expectedGeneration ||
          (entries.has(id) && entries.get(id).key !== key);
        if (protectedEdit()) return false;
        const recoveryId = recoveryKeys.get(id);
        if (!recoveryId || typeof storage.deleteIfUnchanged !== "function")
          return false;
        const persisted = await storage.get(recoveryId);
        if (protectedEdit()) return false;
        if (
          persisted &&
          identity(recordOf(persisted, persisted.updatedAt)) !== key
        )
          return false;
        if (
          persisted &&
          !(await storage.deleteIfUnchanged(recovered(persisted)))
        )
          return false;
        if (entries.get(id)?.generation !== expectedGeneration) return false;
        if (entries.get(id)?.generation === expectedGeneration)
          entries.delete(id);
        if (![...entries.values()].some((entry) => entry.dirty)) cancelTimers();
        report("stored", id, { cleared: true });
        return true;
      });
    } catch (error) {
      fail(id, error);
      throw error;
    }
  }
  async function list() {
    try {
      return await enqueue(async () => {
        const records = await storage.list();
        return records
          .map(recovered)
          .sort(
            (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
          );
      });
    } catch (error) {
      fail(null, error);
      throw error;
    }
  }
  async function read(id) {
    validId(id);
    try {
      return await enqueue(async () => {
        return resolveRecord(id);
      });
    } catch (error) {
      fail(id, error);
      throw error;
    }
  }
  async function resolveRecord(id) {
    const direct = await storage.get(id);
    if (direct) return recovered(direct);
    const owned = recoveryKeys.get(id);
    if (owned) {
      const record = await storage.get(owned);
      return record ? recovered(record) : null;
    }
    const matches = (await storage.list()).filter((record) => record.id === id);
    if (matches.length > 1)
      throw new Error("Ambiguous recovery draft id; use recoveryId");
    return matches.length ? recovered(matches[0]) : null;
  }
  async function discard(id) {
    validId(id);
    const draftId =
      [...entries.values()].find((entry) => entry.record.recoveryId === id)
        ?.record.id ?? id;
    entries.delete(draftId);
    if (![...entries.values()].some((entry) => entry.dirty)) cancelTimers();
    try {
      return await enqueue(async () => {
        const record = await resolveRecord(id);
        if (record) await storage.delete(record.recoveryId);
        if (!entries.has(draftId))
          report("stored", record?.id ?? draftId, { cleared: true });
      });
    } catch (error) {
      fail(id, error);
      throw error;
    }
  }
  return { changed, flush, clearSaved, list, read, discard };
}

/** Persistent bounded store. The limit rejects new records; it never evicts.
 * Optional databaseName/maxRecords support isolated browser tests and policy.
 * Native readwrite transactions serialize count+put across browser windows.
 */
export function createIndexedDBRecoveryStore(
  indexedDB = globalThis.indexedDB,
  { databaseName = "wechat-draft-recovery", maxRecords = 20 } = {},
) {
  countLimit(maxRecords);
  let connection;
  const open = () => {
    if (!connection) {
      connection = new Promise((resolve, reject) => {
        if (!indexedDB || typeof indexedDB.open !== "function") {
          reject(new Error("IndexedDB recovery storage unavailable"));
          return;
        }
        let settled = false;
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("drafts"))
            db.createObjectStore("drafts", { keyPath: "id" });
        };
        request.onerror = () => {
          settled = true;
          reject(request.error ?? new Error("Cannot open recovery storage"));
        };
        request.onblocked = () => {
          settled = true;
          reject(
            new Error(
              "Recovery storage upgrade is blocked; close other publisher windows",
            ),
          );
        };
        request.onsuccess = () => {
          const db = request.result;
          if (settled) {
            db.close();
            return;
          }
          db.onversionchange = () => {
            db.close();
            connection = null;
          };
          resolve(db);
        };
      }).catch((error) => {
        connection = null;
        throw error;
      });
    }
    return connection;
  };
  async function transaction(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let result, failure;
      const tx = db.transaction("drafts", mode),
        store = tx.objectStore("drafts");
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure ??
            tx.error ??
            new Error("Recovery storage transaction aborted"),
        );
      tx.onerror = () => {
        failure ??= tx.error;
      };
      try {
        operation(
          store,
          (value) => {
            result = value;
          },
          (error) => {
            failure = error;
            tx.abort();
          },
        );
      } catch (error) {
        failure = error;
        tx.abort();
      }
    });
  }
  // Keep the original v1 keyPath=id database readable by older installations.
  // New physical ids are opaque recovery keys; draftId preserves the article id.
  const decode = (value) =>
    value
      ? recovered(
          value.draftId === undefined
            ? value
            : { ...value, id: value.draftId, recoveryId: value.id },
        )
      : null;
  return {
    get(id) {
      validId(id);
      return transaction("readonly", (store, done) => {
        const request = store.get(id);
        request.onsuccess = () => done(decode(request.result));
      });
    },
    list() {
      return transaction("readonly", (store, done) => {
        const request = store.getAll();
        request.onsuccess = () => done(request.result.map(decode));
      });
    },
    delete(id) {
      validId(id);
      return transaction("readwrite", (store) => {
        store.delete(id);
      });
    },
    deleteIfUnchanged(expected) {
      const record = recovered(expected),
        key = record.recoveryId;
      return transaction("readwrite", (store, done) => {
        const request = store.get(key);
        request.onsuccess = () => {
          if (!sameRecord(decode(request.result), record)) {
            done(false);
            return;
          }
          store.delete(key);
          done(true);
        };
      });
    },
    put(value) {
      const record = recordOf(value, value.updatedAt);
      const key = record.recoveryId ?? record.id;
      const physical =
        record.recoveryId === undefined
          ? record
          : { ...record, id: key, draftId: record.id };
      return transaction("readwrite", (store, done, abort) => {
        const existing = store.get(key);
        existing.onsuccess = () => {
          if (existing.result) {
            store.put(physical);
            return;
          }
          const count = store.count();
          count.onsuccess = () => {
            if (count.result >= maxRecords) {
              abort(
                new RangeError(
                  "Recovery record limit reached; restore or discard an existing record",
                ),
              );
              return;
            }
            store.put(physical);
          };
        };
      });
    },
  };
}
