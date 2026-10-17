// Previous author decisions only preselect individual current confirmation rows.
// The author still presses Continue; the UI sends the *current* complete server
// fingerprint and the server validates every current confirmation independently.
// This helper never removes issues, approves blockers, or stores article text.
const KEY = "wechat-preflight-ack-v1";
const LIMIT = 512;
const HASH = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const own = (value, key) =>
  value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
const shortString = (value, maximum) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

function checkedContext(context) {
  if (
    !context ||
    !shortString(context.draftId, 128) ||
    !shortString(context.accountId, 128) ||
    !shortString(context.renderVersion, 128) ||
    typeof context.fingerprint !== "string" ||
    !HASH.test(context.fingerprint) ||
    !Array.isArray(context.issues) ||
    context.issues.length > 4096
  )
    throw new Error("Invalid acknowledgement context");
  const metadata =
    context.metadata &&
    typeof context.metadata === "object" &&
    !Array.isArray(context.metadata)
      ? context.metadata
      : {};
  const articleType = own(metadata, "article_type") ?? "";
  if (typeof articleType !== "string" || articleType.length > 64)
    throw new Error("Invalid article type");
  return { metadata, articleType };
}

function fieldText(context, metadata, field) {
  if (field === "content" || field === "html")
    return typeof context[field] === "string" ? context[field] : null;
  const value = own(metadata, field);
  // Omitted source_url is the same intentional empty original-source field.
  if (field === "source_url" && (value === undefined || value === null))
    return "";
  if (typeof value === "string") return value;
  return null;
}

function decisionValue(context, metadata, issue) {
  if (
    !issue ||
    issue.severity !== "confirm" ||
    !shortString(issue.id, 256) ||
    !shortString(issue.code, 128) ||
    !shortString(issue.field, 64)
  )
    return null;
  const source = fieldText(context, metadata, issue.field);
  if (source === null) return null;
  const from = issue.from,
    to = issue.to;
  if (from === undefined && to === undefined)
    return [issue.code, issue.field, source, "", ""];
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to <= from ||
    to > source.length
  )
    return null;
  const before = source.slice(Math.max(0, from - 16), from),
    matched = source.slice(from, to),
    after = source.slice(to, to + 16),
    needle = before + matched + after;
  const first = source.indexOf(needle);
  // An old position must never migrate to another identical occurrence.
  if (first < 0 || source.indexOf(needle, first + 1) >= 0) return null;
  return [issue.code, issue.field, matched, before, after];
}

function parsedRecords(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "string" || raw.length > 200000)
    throw new Error("Invalid acknowledgement storage");
  const record = JSON.parse(raw);
  if (
    !record ||
    Object.keys(record).sort().join(",") !== "entries,version" ||
    record.version !== 1 ||
    !Array.isArray(record.entries) ||
    record.entries.length > LIMIT
  )
    throw new Error("Invalid acknowledgement storage");
  const seen = new Set();
  for (const entry of record.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).sort().join(",") !== "decision,draft,scope" ||
      !["decision", "draft", "scope"].every(
        (key) => typeof entry[key] === "string" && HASH.test(entry[key]),
      )
    )
      throw new Error("Invalid acknowledgement record");
    const key = entry.draft + entry.scope + entry.decision;
    if (seen.has(key)) throw new Error("Duplicate acknowledgement record");
    seen.add(key);
  }
  return record.entries;
}

/** storage uses localStorage's getItem/setItem/removeItem shape (async adapters
 * also work). accepted -> Set of current confirm IDs; remember -> boolean,
 * clear(draftId) -> boolean. Missing crypto/storage, malformed records and quota
 * errors all fail closed without reflecting exception text or caching approval.
 * Only three SHA256 identifiers per entry persist. At 512, new decisions are
 * refused; existing decisions and article recovery records remain untouched.
 */
export function createPreflightAcknowledgements({
  storage,
  subtle = globalThis.crypto?.subtle,
} = {}) {
  if (storage === undefined)
    try {
      storage = globalThis.localStorage;
    } catch {
      storage = null;
    }
  let tail = Promise.resolve();
  const queue = (operation, fallback) => {
    const result = tail.then(operation).catch(() => fallback());
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  async function digest(value) {
    if (!subtle || typeof subtle.digest !== "function")
      throw new Error("Acknowledgement hashing unavailable");
    const bytes = await subtle.digest(
      "SHA-256",
      encoder.encode(JSON.stringify(value)),
    );
    if (bytes.byteLength !== 32)
      throw new Error("Invalid acknowledgement hash");
    return [...new Uint8Array(bytes)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }
  async function read() {
    if (
      !storage ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function"
    )
      throw new Error("Acknowledgement storage unavailable");
    return parsedRecords(await storage.getItem(KEY));
  }
  async function identities(context) {
    const { metadata, articleType } = checkedContext(context);
    const draft = await digest(["draft", context.draftId]);
    const scope = await digest([
      "scope",
      context.draftId,
      context.accountId,
      context.renderVersion,
      articleType,
    ]);
    const counts = new Map();
    for (const issue of context.issues)
      if (typeof issue?.id === "string")
        counts.set(issue.id, (counts.get(issue.id) || 0) + 1);
    const candidates = await Promise.all(
      context.issues.map(async (issue) => {
        if (counts.get(issue?.id) !== 1) return null;
        const value = decisionValue(context, metadata, issue);
        return value ? { id: issue.id, decision: await digest(value) } : null;
      }),
    );
    const decisions = new Map();
    for (const item of candidates)
      if (item)
        decisions.set(item.decision, (decisions.get(item.decision) || 0) + 1);
    return {
      draft,
      scope,
      candidates: candidates.filter(
        (item) => item && decisions.get(item.decision) === 1,
      ),
    };
  }
  function accepted(context) {
    return queue(
      async () => {
        const entries = await read(),
          { draft, scope, candidates } = await identities(context);
        const remembered = new Set(
          entries
            .filter((entry) => entry.draft === draft && entry.scope === scope)
            .map((entry) => entry.decision),
        );
        return new Set(
          candidates
            .filter((item) => remembered.has(item.decision))
            .map((item) => item.id),
        );
      },
      () => new Set(),
    );
  }
  function remember(context, acknowledgedIDs) {
    return queue(
      async () => {
        if (
          !Array.isArray(acknowledgedIDs) &&
          !(acknowledgedIDs instanceof Set)
        )
          return false;
        const acknowledged = new Set(acknowledgedIDs);
        if (
          acknowledged.size > 4096 ||
          [...acknowledged].some((id) => !shortString(id, 256))
        )
          return false;
        const entries = await read(),
          { draft, scope, candidates } = await identities(context);
        const present = new Set(
          entries.map((entry) => entry.draft + entry.scope + entry.decision),
        );
        const additions = candidates
          .filter(
            (item) =>
              acknowledged.has(item.id) &&
              !present.has(draft + scope + item.decision),
          )
          .map((item) => ({ draft, scope, decision: item.decision }));
        if (entries.length + additions.length > LIMIT) return false;
        if (!additions.length) return true;
        const serialized = JSON.stringify({
          version: 1,
          entries: [...entries, ...additions],
        });
        await storage.setItem(KEY, serialized);
        return (await storage.getItem(KEY)) === serialized;
      },
      () => false,
    );
  }
  function clear(draftId) {
    return queue(
      async () => {
        if (!shortString(draftId, 128)) return false;
        const entries = await read(),
          draft = await digest(["draft", draftId]),
          remaining = entries.filter((entry) => entry.draft !== draft);
        if (entries.length === remaining.length) return true;
        const serialized = JSON.stringify({ version: 1, entries: remaining });
        await storage.setItem(KEY, serialized);
        return (await storage.getItem(KEY)) === serialized;
      },
      () => false,
    );
  }
  return { accepted, remember, clear };
}
