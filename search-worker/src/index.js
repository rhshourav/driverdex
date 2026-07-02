/**
 * search-worker/src/index.js
 * ----------------------------------------------------------------------------
 * DriverDex search API ("driverdex-check" Worker). Read-only HTTP API over the D1
 * driver mirror populated by migrate_to_d1.py / d1-sync.yml.
 *
 * Routes
 *   GET  /api/search?q=<text>&category=&provider=&arch=&os=&page=&pageSize=&enabledOnly=
 *        Free-text + faceted search across Drivers (display_name, provider,
 *        category, version, descriptions, driver_id, pack, source_manifest)
 *        AND an exact/prefix HWID lookup
 *        against the HWIDs covering index when `q` looks like a hardware ID
 *        (contains "VEN_" or "DEV_" or a backslash, e.g. "PCI\VEN_10DE").
 *        Drivers with NO hwids are fully searchable via text/facet mode.
 *        HWID mode always respects enabledOnly (default: true).
 *        Supports `includeNoHwid=0` to exclude no-hwid drivers from text search.
 *        Pass `enabledOnly=0` to include disabled / superseded drivers.
 *
 *   GET  /api/driver/:driver_id
 *        Full detail for one driver: row + its HWIDs[] + DriverParts[]
 *        (i.e. everything a client needs to download + reassemble it).
 *
 *   GET  /api/driver/:driver_id/versions
 *        All versions of a driver grouped by supersedes/superseded_by chain.
 *        Returns { current, history[] } sorted newest→oldest.
 *
 *   GET  /api/hwid/:hwid
 *        Direct hardware-ID lookup: given one PCI/USB hwid string, return
 *        every enabled driver that declares it, ranked by exact id-string
 *        match first, then by the generic/compatible-id fallback.
 *
 *   GET  /api/stats
 *        Aggregate counts (drivers, hwids, categories, providers, last sync)
 *        including a breakdown of drivers WITH and WITHOUT hwids.
 *
 *   GET  /api/facets
 *        Distinct category/provider/arch/os_targets values + counts, for
 *        populating filter dropdowns. Includes no-hwid driver counts per facet.
 *
 * All responses are JSON. CORS is wide open (GET-only, no credentials).
 * ----------------------------------------------------------------------------
 */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "public, max-age=60",
};

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorResponse(message, status = 400) {
  return json({ error: message }, status);
}

function parsePagination(url) {
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  let pageSize = parseInt(url.searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10);
  if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = DEFAULT_PAGE_SIZE;
  pageSize = Math.min(pageSize, MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// A query "looks like" a hardware ID rather than free text if it contains
// the telltale PnP ID syntax. This routes it to the indexed HWID lookup.
// Note: single backslash in regex literal = matches one literal backslash.
function looksLikeHwid(q) {
  return /VEN_|DEV_|SUBSYS_|\\/i.test(q);
}

/**
 * Normalize a user-supplied HWID query so it matches the canonical form
 * stored in the database.
 *
 * The DB stores HWIDs with a single backslash as the separator (e.g.
 * "HDAUDIO\FUNC_01&VEN_10DE&DEV_0010"), matching the raw string value from
 * the manifest JSON.  When a user copies an HWID from a JSON source, code
 * editor, or terminal output the backslash is often doubled (\\) because the
 * surrounding context escapes it -- but the underlying character value the
 * browser sees is still a literal double-backslash, not a single one.
 * Without normalization the exact-match and prefix-LIKE arms of the HWID
 * query both silently miss, returning zero results even though the driver is
 * present in the database.
 *
 * This function collapses any run of two consecutive backslashes down to one,
 * which is the only normalisation needed: Windows PnP IDs never contain a
 * legitimate double-backslash, so this is always safe and idempotent (a
 * single-backslash input passes through unchanged).
 */
function normalizeHwidQuery(q) {
  return q.replace(/\\\\/g, "\\");
}

/**
 * Escape a string for use as a literal pattern in a SQL LIKE expression.
 *
 * SQLite's LIKE treats `%` (any sequence) and `_` (any single character) as
 * wildcards.  HWIDs always contain underscores (e.g. "VEN_10DE&DEV_1234"),
 * and user-supplied free-text may contain either.  Without escaping, those
 * characters act as wildcards and broaden the match set in unpredictable ways
 * (e.g. "VEN_10DE" would match "VEN410DE" since `_` matches any char).
 *
 * Use with the matching ESCAPE '$' clause in the SQL, e.g.:
 *   h.hwid_string LIKE ? || '%' ESCAPE '$'
 */
function escapeLikePattern(s) {
  // Escape the escape char first, then % and _.
  return s.replace(/\$/g, "$$$$").replace(/%/g, "$%").replace(/_/g, "$_");
}

function parseDriverRow(row) {
  return {
    ...row,
    descriptions: safeParseJsonArray(row.descriptions),
    os_targets: safeParseJsonArray(row.os_targets),
    enabled: !!row.enabled,
  };
}

function safeParseJsonArray(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function handleSearch(url, env) {
  const q = (url.searchParams.get("q") || "").trim();
  const category = url.searchParams.get("category") || "";
  const provider = url.searchParams.get("provider") || "";
  const arch = url.searchParams.get("arch") || "";
  const os = url.searchParams.get("os") || "";

  // enabledOnly defaults to true; pass enabledOnly=0 to include disabled/superseded drivers
  const enabledOnly = url.searchParams.get("enabledOnly") !== "0";

  // includeNoHwid defaults to true -- no-HWID drivers ARE included in text/facet results.
  // Pass includeNoHwid=0 to exclude them (e.g. for a "must be matchable by device scan" view).
  const includeNoHwid = url.searchParams.get("includeNoHwid") !== "0";

  const { page, pageSize, offset } = parsePagination(url);

  // --- HWID-shaped query: hit the covering index directly ------------------
  if (q && looksLikeHwid(q)) {
    const enabledClause = enabledOnly ? "AND d.enabled = 1" : "";

    const qNorm = normalizeHwidQuery(q);
    const qEscaped = escapeLikePattern(qNorm);

    // ?1 = normalized q for exact match, ?2 = escaped q for prefix LIKE, ?3/?4 = pagination
    const baseDataQuery = `
      SELECT d.driver_id, d.display_name, d.provider, d.category, d.version,
             d.arch, d.primary_url, d.zip_parts, d.enabled, d.date_added,
             h.hwid_string, h.is_generic,
             d.supersedes, d.superseded_by
        FROM HWIDs h
        JOIN Drivers d ON d.driver_id = h.driver_id
       WHERE (h.hwid_string = ?1 OR h.hwid_string LIKE ?2 || '%' ESCAPE '$')
       ${enabledClause}
       ORDER BY h.is_generic ASC, d.date_added DESC
       LIMIT ?3 OFFSET ?4`;

    const baseCountQuery = `
      SELECT COUNT(*) AS total
        FROM HWIDs h
        JOIN Drivers d ON d.driver_id = h.driver_id
       WHERE (h.hwid_string = ?1 OR h.hwid_string LIKE ?2 || '%' ESCAPE '$')
       ${enabledClause}`;

    const [{ results: rows }, { results: countRows }] = await Promise.all([
      env.DB.prepare(baseDataQuery).bind(qNorm, qEscaped, pageSize, offset).all(),
      env.DB.prepare(baseCountQuery).bind(qNorm, qEscaped).all(),
    ]);

    return json({
      mode: "hwid",
      query: q,   // echo back the original user input, not the normalized form
      page,
      pageSize,
      total: countRows[0]?.total ?? 0,
      results: rows.map(parseDriverRow),
    });
  }

  // --- Free-text + faceted search over Drivers ------------------------------
  const conditions = [];
  const params = [];

  if (q) {
    const qEscaped = escapeLikePattern(q);
    conditions.push(
      "(d.display_name LIKE ? ESCAPE '$' OR d.provider LIKE ? ESCAPE '$' OR d.category LIKE ? ESCAPE '$'" +
      " OR d.version LIKE ? ESCAPE '$' OR d.descriptions LIKE ? ESCAPE '$' OR d.notes LIKE ? ESCAPE '$'" +
      " OR d.driver_id LIKE ? ESCAPE '$' OR d.pack LIKE ? ESCAPE '$' OR d.source_manifest LIKE ? ESCAPE '$')"
    );
    const like = `%${qEscaped}%`;
    params.push(like, like, like, like, like, like, like, like, like);
  }
  if (category) {
    conditions.push("d.category = ?");
    params.push(category);
  }
  if (provider) {
    conditions.push("d.provider = ?");
    params.push(provider);
  }
  if (arch) {
    conditions.push("d.arch = ?");
    params.push(arch);
  }
  if (os) {
    const osEscaped = escapeLikePattern(os);
    conditions.push("d.os_targets LIKE ? ESCAPE '$'");
    params.push(`%${osEscaped}%`);
  }
  if (enabledOnly) {
    conditions.push("d.enabled = 1");
  }

  if (!includeNoHwid) {
    conditions.push("EXISTS (SELECT 1 FROM HWIDs h2 WHERE h2.driver_id = d.driver_id)");
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countStmt = env.DB.prepare(
    `SELECT COUNT(*) AS total FROM Drivers d ${whereClause}`
  );
  const dataStmt = env.DB.prepare(
    `SELECT d.driver_id, d.display_name, d.provider, d.category, d.version, d.arch,
            d.primary_url, d.zip_parts, d.date_added, d.enabled,
            d.supersedes, d.superseded_by,
            (SELECT COUNT(*) FROM HWIDs h WHERE h.driver_id = d.driver_id) AS hwid_count
       FROM Drivers d
       ${whereClause}
       ORDER BY d.date_added DESC
       LIMIT ? OFFSET ?`
  );

  const [{ results: countRows }, { results: dataRows }] = await Promise.all([
    countStmt.bind(...params).all(),
    dataStmt.bind(...params, pageSize, offset).all(),
  ]);

  return json({
    mode: "text",
    query: q,
    page,
    pageSize,
    total: countRows[0]?.total ?? 0,
    results: dataRows.map(r => ({ ...parseDriverRow(r), hwid_count: r.hwid_count ?? 0 })),
  });
}

async function handleDriverDetail(driverId, env) {
  const driver = await env.DB.prepare(`SELECT * FROM Drivers WHERE driver_id = ?1`)
    .bind(driverId)
    .first();

  if (!driver) return errorResponse("Driver not found", 404);

  const [{ results: hwids }, { results: parts }] = await Promise.all([
    env.DB.prepare(
      `SELECT hwid_string, is_generic FROM HWIDs WHERE driver_id = ?1 ORDER BY is_generic ASC, hwid_string ASC`
    )
      .bind(driverId)
      .all(),
    env.DB.prepare(
      `SELECT part_num, filename, size_bytes, sha256, url FROM DriverParts WHERE driver_id = ?1 ORDER BY part_num ASC`
    )
      .bind(driverId)
      .all(),
  ]);

  return json({
    ...parseDriverRow(driver),
    hwids,
    parts,
  });
}

/**
 * GET /api/driver/:driver_id/versions
 *
 * Walks the supersedes/superseded_by chain starting from any node in the
 * version family and returns the full timeline sorted newest → oldest.
 *
 * Algorithm:
 *   1. Fetch the seed driver.
 *   2. Walk supersedes links backward (older versions).
 *   3. Walk superseded_by links forward (newer versions).
 *   4. Collect the union, sort by date_added DESC (newest first).
 *   5. Return { driver_id, display_name, versions: [...] }
 *
 * Each version entry has: driver_id, display_name, version, date_added,
 * enabled, supersedes, superseded_by, is_current (true for the newest
 * enabled entry in the chain).
 */
async function handleDriverVersions(driverId, env) {
  const seed = await env.DB.prepare(
    `SELECT driver_id, display_name, provider, category, version, arch,
            date_added, enabled, supersedes, superseded_by
       FROM Drivers WHERE driver_id = ?1`
  ).bind(driverId).first();

  if (!seed) return errorResponse("Driver not found", 404);

  // BFS/walk through the chain in both directions, guarded by a visited set
  const visited = new Set();
  const queue = [seed.driver_id];
  const rows = [];

  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);

    const row = await env.DB.prepare(
      `SELECT driver_id, display_name, provider, category, version, arch,
              date_added, enabled, supersedes, superseded_by
         FROM Drivers WHERE driver_id = ?1`
    ).bind(id).first();

    if (!row) continue;
    rows.push(row);

    // Walk backward (older): follow supersedes link
    if (row.supersedes && !visited.has(row.supersedes)) {
      queue.push(row.supersedes);
    }
    // Walk forward (newer): follow superseded_by link
    if (row.superseded_by && !visited.has(row.superseded_by)) {
      queue.push(row.superseded_by);
    }

    // Also find any driver that lists THIS driver as its supersedes target
    // (i.e. drivers that replaced this one, in case superseded_by is not set)
    const { results: pointingHere } = await env.DB.prepare(
      `SELECT driver_id FROM Drivers WHERE supersedes = ?1`
    ).bind(id).all();
    for (const p of pointingHere) {
      if (!visited.has(p.driver_id)) queue.push(p.driver_id);
    }

    // Also find any driver superseded BY this one
    const { results: supersededBy } = await env.DB.prepare(
      `SELECT driver_id FROM Drivers WHERE superseded_by = ?1`
    ).bind(id).all();
    for (const p of supersededBy) {
      if (!visited.has(p.driver_id)) queue.push(p.driver_id);
    }
  }

  // Sort newest → oldest
  rows.sort((a, b) => {
    const da = a.date_added || "";
    const db = b.date_added || "";
    return da < db ? 1 : da > db ? -1 : 0;
  });

  // Mark the "current" version: the most recent enabled entry, or just the first if none enabled
  const currentIdx = rows.findIndex(r => r.enabled);
  const markedRows = rows.map((r, i) => ({
    ...r,
    enabled: !!r.enabled,
    is_current: i === (currentIdx === -1 ? 0 : currentIdx),
  }));

  return json({
    driver_id: seed.driver_id,
    display_name: seed.display_name,
    provider: seed.provider,
    category: seed.category,
    arch: seed.arch,
    version_count: markedRows.length,
    versions: markedRows,
  });
}

async function handleHwidLookup(hwid, env) {
  // Normalize double-backslash to single so direct /api/hwid/:hwid lookups
  // work regardless of whether the caller URL-encoded a single or double backslash.
  const hwid_norm = normalizeHwidQuery(hwid);
  const { results } = await env.DB.prepare(
    `SELECT d.*, h.is_generic AS matched_is_generic
       FROM HWIDs h
       JOIN Drivers d ON d.driver_id = h.driver_id
      WHERE h.hwid_string = ?1 AND d.enabled = 1
      ORDER BY h.is_generic ASC, d.date_added DESC`
  )
    .bind(hwid_norm)
    .all();

  return json({
    hwid,
    matches: results.map(parseDriverRow),
  });
}

async function handleStats(env) {
  const [drivers, driversDisabled, driversNoHwid, hwids, lastSync, categories, providers] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM Drivers WHERE enabled = 1`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM Drivers WHERE enabled = 0`).first(),
    // Expose no-hwid driver count so the UI can surface it
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM Drivers d
        WHERE enabled = 1
          AND NOT EXISTS (SELECT 1 FROM HWIDs h WHERE h.driver_id = d.driver_id)`
    ).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM HWIDs`).first(),
    env.DB.prepare(
      `SELECT run_at, commit_sha, drivers_upserted, hwids_upserted FROM SyncLog ORDER BY id DESC LIMIT 1`
    ).first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT category) AS n FROM Drivers WHERE category IS NOT NULL`
    ).first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT provider) AS n FROM Drivers WHERE provider IS NOT NULL`
    ).first(),
  ]);

  return json({
    drivers: drivers?.n ?? 0,
    drivers_disabled: driversDisabled?.n ?? 0,
    drivers_no_hwid: driversNoHwid?.n ?? 0,
    hwids: hwids?.n ?? 0,
    categories: categories?.n ?? 0,
    providers: providers?.n ?? 0,
    lastSync: lastSync || null,
  });
}

async function handleFacets(env) {
  const [{ results: categories }, { results: providers }, { results: archs }] = await Promise.all([
    env.DB.prepare(
      `SELECT category, COUNT(*) AS n FROM Drivers WHERE enabled = 1 AND category IS NOT NULL GROUP BY category ORDER BY n DESC`
    ).all(),
    env.DB.prepare(
      `SELECT provider, COUNT(*) AS n FROM Drivers WHERE enabled = 1 AND provider IS NOT NULL GROUP BY provider ORDER BY n DESC`
    ).all(),
    env.DB.prepare(
      `SELECT arch, COUNT(*) AS n FROM Drivers WHERE enabled = 1 AND arch IS NOT NULL GROUP BY arch ORDER BY n DESC`
    ).all(),
  ]);

  return json({ categories, providers, archs });
}

// ----------------------------------------------------------------------------
// Install-link minting
// ----------------------------------------------------------------------------

const INSTALL_TTL_SECONDS = 300; // 5-minute death, enforced by KV expirationTtl
const RATE_LIMIT_MAX = 10;       // tokens per window, per IP
const RATE_LIMIT_WINDOW = 60;    // seconds

/**
 * Resolve the public base URL the generated `irm <url> | iex` one-liner points
 * at. Pinned via the PUBLIC_BASE_URL var (recommended) so a CDN/edge origin or
 * forwarded host can never poison the command baked into a token. Falls back to
 * the request origin only if the var is unset (e.g. local `wrangler dev`).
 */
function resolveBaseUrl(env, url) {
  const pinned = (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (pinned) return pinned;
  return url.origin;
}

/**
 * Cheap per-IP rate limiter backed by KV. Increment a short-TTL counter and
 * reject once it crosses RATE_LIMIT_MAX within the window. This is best-effort
 * (KV is eventually consistent) — fine for an MVP abuse speed-bump, not a hard
 * security control. Returns true if the request should be blocked.
 */
async function isRateLimited(ip, env) {
  if (!env.INSTALL_LINKS || !ip) return false;
  const key = `ratelimit:${ip}`;
  let count = 0;
  try {
    const raw = await env.INSTALL_LINKS.get(key);
    count = raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return false; // never fail the request because the limiter itself errored
  }
  if (count >= RATE_LIMIT_MAX) return true;
  // Re-set with the original window TTL. We don't read back the remaining TTL
  // (KV doesn't expose it), so the window is approximate — acceptable here.
  await env.INSTALL_LINKS.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  return false;
}

/**
 * POST /api/install/create  { driver_id }
 *
 * Re-validates driver_id against D1 (never trusts the client), mints a 122-bit
 * single-use token, writes {driver_id, created_at, used} to KV with a 300s TTL,
 * and returns the token + the `irm | iex` one-liner. Disabled/missing drivers
 * are rejected with 404 so a stale or forged id can't be baked into a script.
 */
async function handleInstallCreate(request, env) {
  if (!env.INSTALL_LINKS) {
    return errorResponse("Install links are not configured on this deployment", 503);
  }

  const ip = request.headers.get("cf-connecting-ip") || "";
  if (await isRateLimited(ip, env)) {
    return errorResponse("Too many requests — slow down and try again in a minute", 429);
  }

  const body = await request.json().catch(() => null);
  const driverId = body && typeof body.driver_id === "string" ? body.driver_id.trim() : "";
  if (!driverId) return errorResponse("driver_id required", 400);

  const driver = await env.DB.prepare(
    `SELECT driver_id, display_name, provider, category, version, arch,
            primary_url, zip_parts, enabled
       FROM Drivers WHERE driver_id = ?1`
  ).bind(driverId).first();

  if (!driver) return errorResponse("Driver not found", 404);
  if (!driver.enabled) return errorResponse("Driver is disabled or superseded", 404);

  const token = crypto.randomUUID().replace(/-/g, ""); // 32 hex chars, ~122 bits
  await env.INSTALL_LINKS.put(
    `install:${token}`,
    JSON.stringify({ driver_id: driver.driver_id, created_at: Date.now(), used: false }),
    { expirationTtl: INSTALL_TTL_SECONDS }
  );

  const base = resolveBaseUrl(env, new URL(request.url));
  return json({
    token,
    url: `${base}/i/${token}`,
    command: `irm ${base}/i/${token} | iex`,
    expires_in_seconds: INSTALL_TTL_SECONDS,
    driver: {
      driver_id: driver.driver_id,
      display_name: driver.display_name,
      provider: driver.provider,
      version: driver.version,
      arch: driver.arch,
    },
  });
}

const MAX_BULK_DRIVERS = 100; // cap how many drivers one cart token can carry

/**
 * POST /api/install/create-bulk  { driver_ids: [...] }
 *
 * The cart "Install all" path. Dedupes + caps the requested ids, re-validates
 * each against D1 (enabled only — never trusts the client), and mints ONE
 * single-use token holding the surviving driver_ids. The site worker's
 * /i/:token renders a multi-package script from these ids. Returns 404 if none
 * of the ids resolve to an installable driver.
 */
async function handleInstallCreateBulk(request, env) {
  if (!env.INSTALL_LINKS) {
    return errorResponse("Install links are not configured on this deployment", 503);
  }

  const ip = request.headers.get("cf-connecting-ip") || "";
  if (await isRateLimited(ip, env)) {
    return errorResponse("Too many requests — slow down and try again in a minute", 429);
  }

  const body = await request.json().catch(() => null);
  const rawIds = body && Array.isArray(body.driver_ids) ? body.driver_ids : null;
  if (!rawIds || rawIds.length === 0) {
    return errorResponse("driver_ids (non-empty array) required", 400);
  }

  // Dedupe, trim, drop falsy, and cap.
  const ids = [...new Set(rawIds.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean))];
  if (ids.length === 0) return errorResponse("driver_ids (non-empty array) required", 400);
  if (ids.length > MAX_BULK_DRIVERS) {
    return errorResponse(`Too many drivers — max ${MAX_BULK_DRIVERS} per install link`, 400);
  }

  // Validate each id against D1, keeping only enabled drivers (order preserved).
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  const { results: rows } = await env.DB.prepare(
    `SELECT driver_id FROM Drivers WHERE enabled = 1 AND driver_id IN (${placeholders})`
  )
    .bind(...ids)
    .all();

  const validSet = new Set(rows.map((r) => r.driver_id));
  const validIds = ids.filter((id) => validSet.has(id));
  if (validIds.length === 0) {
    return errorResponse("None of the requested drivers are installable", 404);
  }

  const token = crypto.randomUUID().replace(/-/g, "");
  await env.INSTALL_LINKS.put(
    `install:${token}`,
    JSON.stringify({ driver_ids: validIds, created_at: Date.now(), used: false }),
    { expirationTtl: INSTALL_TTL_SECONDS }
  );

  const base = resolveBaseUrl(env, new URL(request.url));
  return json({
    token,
    url: `${base}/i/${token}`,
    command: `irm ${base}/i/${token} | iex`,
    expires_in_seconds: INSTALL_TTL_SECONDS,
    driver_count: validIds.length,
    skipped: ids.length - validIds.length,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...JSON_HEADERS, "access-control-allow-methods": "GET, POST, OPTIONS" } });
    }

    // ---- POST: ephemeral install-link minting -----------------------------
    // The only write-ish path in this otherwise read-only API. Wrapped in the
    // same try/catch shape as the GET routes via its own handler.
    if (request.method === "POST") {
      if (url.pathname === "/api/install/create") {
        try {
          return await handleInstallCreate(request, env);
        } catch (err) {
          console.error("driverdex-check install/create error:", err);
          return errorResponse("Internal error", 500);
        }
      }
      if (url.pathname === "/api/install/create-bulk") {
        try {
          return await handleInstallCreateBulk(request, env);
        } catch (err) {
          console.error("driverdex-check install/create-bulk error:", err);
          return errorResponse("Internal error", 500);
        }
      }
      return errorResponse("Not found", 404);
    }

    if (request.method !== "GET") {
      return errorResponse("Method not allowed", 405);
    }

    try {
      if (url.pathname === "/api/search") return await handleSearch(url, env);
      if (url.pathname === "/api/stats") return await handleStats(env);
      if (url.pathname === "/api/facets") return await handleFacets(env);

      // /api/driver/:id/versions — must match before the plain driver route
      const versionsMatch = url.pathname.match(/^\/api\/driver\/(.+)\/versions$/);
      if (versionsMatch) {
        let driverId;
        try { driverId = decodeURIComponent(versionsMatch[1]); }
        catch { return errorResponse("Malformed driver_id in URL", 400); }
        return await handleDriverVersions(driverId, env);
      }

      const driverMatch = url.pathname.match(/^\/api\/driver\/(.+)$/);
      if (driverMatch) {
        let driverId;
        try { driverId = decodeURIComponent(driverMatch[1]); }
        catch { return errorResponse("Malformed driver_id in URL", 400); }
        return await handleDriverDetail(driverId, env);
      }

      const hwidMatch = url.pathname.match(/^\/api\/hwid\/(.+)$/);
      if (hwidMatch) {
        let hwid;
        try { hwid = decodeURIComponent(hwidMatch[1]); }
        catch { return errorResponse("Malformed hwid in URL", 400); }
        return await handleHwidLookup(hwid, env);
      }

      // shields.io endpoint badge — returns the JSON schema shields.io expects
      if (url.pathname === "/badge") {
        return json({
          schemaVersion: 1,
          label: "driverdex-check",
          message: "up",
          color: "brightgreen",
        });
      }

      if (url.pathname === "/" || url.pathname === "/api") {
        return json({
          service: "driverdex-check",
          endpoints: [
            "/api/search?q=&category=&provider=&arch=&os=&enabledOnly=1&includeNoHwid=1&page=&pageSize=",
            "/api/driver/:driver_id",
            "/api/driver/:driver_id/versions",
            "/api/hwid/:hwid",
            "/api/stats",
            "/api/facets",
            "POST /api/install/create  { driver_id }",
            "POST /api/install/create-bulk  { driver_ids: [...] }",
          ],
        });
      }

      return errorResponse("Not found", 404);
    } catch (err) {
      console.error("driverdex-check worker error:", err);
      return errorResponse("Internal error", 500);
    }
  },
};
