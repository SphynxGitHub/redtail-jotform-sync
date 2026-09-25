// api/relay.js
// VERSION: 2026-09-25-v12 (robust list parser ported from bulk-updater; fixed anniversary field name)
//
// Vercel serverless function that looks up a Redtail contact by ID and
// returns clean JSON for the JotForm widget to consume.
//
// Usage: POST /api/relay  with JSON body { "value": "12345", "key": "YOUR_REDTAIL_KEY" }
//
// The Redtail credentials come from the JotForm widget's own settings
// (filled in per-form by whoever builds it in JotForm's widget builder),
// same pattern as the Wealthbox relay — but sent as a POST body instead of
// a URL query param so the key never lands in a URL, browser history, or
// server access log.

const REDTAIL_BASE = 'https://smf.crm3.redtailtechnology.com/api/public/v1';

export default async function handler(req, res) {
  // CORS — JotForm embeds run on jotform.com / jotform domains
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { value, key } = req.body || {};

  if (!value) {
    res.status(400).json({ error: 'Missing "value" (Redtail Contact ID).' });
    return;
  }
  if (!key) {
    res.status(400).json({ error: 'Missing "key" (Redtail credentials, as "APIKey:Password").' });
    return;
  }

  const contactId = String(value).trim();
  if (!/^\d+$/.test(contactId)) {
    res.status(400).json({ error: 'Contact ID must be numeric.' });
    return;
  }

  // TEMPORARY DEBUG — remove once auth is working.
  console.log('DEBUG key received — length:', key.length);

  // Confirmed from a working integration: the key goes directly into the
  // Authorization header, unmodified — no "Userkey"/"Basic" scheme prefix,
  // no Base64 encoding.
  const authHeader = key;

  // ── Lookup lists ────────────────────────────────────────────────────────
  // Address/phone/gender/marital "type" fields come back as account-specific
  // numerical IDs, so we fetch Redtail's own lookup lists instead of
  // guessing a mapping. Parsing logic ported from your working bulk-updater
  // project (findObjectArray_ / toItem_), which handles Redtail's varying
  // response shapes (nested wrapper keys, different id/name field names,
  // or a flat {"1":"Active"} map) far more reliably than a single guess.

  /** Finds the first array of objects anywhere in the response (up to 3 levels deep). */
  function findObjectArray(v, depth) {
    if (v === null || v === undefined || depth > 3) return null;
    if (Array.isArray(v)) {
      return (v.length && v[0] !== null && typeof v[0] === 'object' && !Array.isArray(v[0])) ? v : null;
    }
    if (typeof v !== 'object') return null;
    const keys = Object.keys(v);
    const preferred = ['data', 'items', 'results', 'list', 'values'];
    const ordered = preferred.filter(k => keys.includes(k)).concat(keys.filter(k => !preferred.includes(k)));
    for (const k of ordered) {
      const hit = findObjectArray(v[k], depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  /** Turns one list entry into { id, name }, tolerating different property names. */
  function toItem(o) {
    let id = null;
    for (const k of ['id', 'value', 'code', 'key', 'list_id']) {
      if (typeof o[k] === 'number' || (typeof o[k] === 'string' && o[k] !== '')) { id = o[k]; break; }
    }
    if (id === null) {
      for (const k of Object.keys(o)) {
        if (/(^|_)id$/i.test(k) && typeof o[k] === 'number') { id = o[k]; break; }
      }
    }
    let name = null;
    for (const k of ['name', 'description', 'label', 'display_name', 'displayName', 'title', 'text', 'full_name']) {
      if (typeof o[k] === 'string' && o[k].trim()) { name = o[k]; break; }
    }
    if (id === null || name === null) return null;
    return { id, name: String(name).trim() };
  }

  function extractItems(body) {
    const arr = findObjectArray(body, 0);
    if (arr) return arr.map(toItem).filter(Boolean);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const keys = Object.keys(body);
      if (keys.length && keys.every(k => typeof body[k] === 'string' || typeof body[k] === 'number')) {
        const numericKeys = keys.every(k => /^\d+$/.test(k));
        return keys.map(k => numericKeys
          ? { id: Number(k), name: String(body[k]).trim() }
          : { id: body[k], name: k });
      }
    }
    return [];
  }

  async function tryLookupPaths(paths) {
    const attempts = [];
    for (const path of paths) {
      try {
        const r = await fetch(`${REDTAIL_BASE}${path}`, {
          headers: { Authorization: authHeader, Accept: 'application/json' },
        });
        if (!r.ok) {
          attempts.push({ path, status: r.status, ok: false });
          continue;
        }
        const j = await r.json();
        const items = extractItems(j);
        const map = {};
        for (const it of items) map[it.id] = it.name;
        const mapSize = items.length;
        attempts.push({ path, status: r.status, ok: true, mapSize, sampleKeys: Object.keys(j).slice(0, 8) });
        if (mapSize > 0) return { map, attempts };
      } catch (e) {
        attempts.push({ path, error: String(e) });
      }
    }
    return { map: {}, attempts };
  }

  const PHONE_TYPE_PATHS = [
    '/lists/phone_types', '/lists/contact_phone_types', '/lists/phonetypes',
    '/lists/phone_type', '/phone_types',
  ];
  const ADDRESS_TYPE_PATHS = [
    '/lists/address_types', '/lists/contact_address_types', '/lists/addresstypes',
    '/lists/address_type', '/address_types',
  ];
  // Confirmed correct from your working bulk-updater project's
  // LOOKUP_ENDPOINTS — no guessing needed for these two.
  const GENDER_PATHS = ['/lists/genders'];
  const MARITAL_STATUS_PATHS = ['/lists/marital_statuses'];

  const [phoneResult, addressResult, genderResult, maritalResult] = await Promise.all([
    tryLookupPaths(PHONE_TYPE_PATHS),
    tryLookupPaths(ADDRESS_TYPE_PATHS),
    tryLookupPaths(GENDER_PATHS),
    tryLookupPaths(MARITAL_STATUS_PATHS),
  ]);
  const phoneTypeMap = phoneResult.map;
  const addressTypeMap = addressResult.map;
  const genderListMap = genderResult.map;
  const maritalListMap = maritalResult.map;

  try {
    const rtRes = await fetch(`${REDTAIL_BASE}/contacts/${contactId}`, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        include: 'emails,addresses,phones,family,family.members',
      },
    });

    const text = await rtRes.text();

    if (!rtRes.ok) {
      res.status(rtRes.status).json({
        error: `Redtail returned HTTP ${rtRes.status}`,
        detail: text.slice(0, 500),
        _version: '2026-09-25-v12',
      });
      return;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      res.status(502).json({ error: 'Redtail response was not valid JSON.', detail: text.slice(0, 500) });
      return;
    }

    // Redtail wraps the contact in a top-level key on some endpoints
    // (e.g. { "contact": {...} }). !! VERIFY the actual shape your account
    // returns and adjust this unwrap if needed.
    const contact = data.contact || data;

    if (!contact || !contact.id) {
      res.status(404).json({ error: 'No record found.' });
      return;
    }

    // Some Redtail fields (address_type, phone_type, job_title, category,
    // status, etc.) can come back as either a plain string or an object
    // like { id: 2, name: "Home" }, depending on account/list settings.
    // This pulls a usable string out of either shape.
    const asText = (val) => {
      if (val === null || val === undefined) return '';
      if (typeof val === 'string' || typeof val === 'number') return String(val);
      if (typeof val === 'object') return val.name || val.label || val.value || '';
      return '';
    };

    // Gender and Marital Status come back from Redtail as account-specific
    // numerical IDs, so we look them up against the real lists fetched
    // above (/lists/genders, /lists/marital_statuses) rather than guessing
    // — the earlier hardcoded 1/2/3/4 guess was confirmed wrong for this
    // account (ID 3 is "Married" here, not "Divorced").

    // Pull a numeric id out of a raw value, an object ({id,...}), or a
    // numeric string.
    const asId = (val) => {
      if (val === null || val === undefined) return null;
      if (typeof val === 'number') return val;
      if (typeof val === 'object') return val.id ?? null;
      if (typeof val === 'string' && /^\d+$/.test(val.trim())) return Number(val);
      return null;
    };

    const genderId = asId(contact.gender_id) ?? asId(contact.gender);
    const genderText = (genderId !== null && genderListMap[genderId]) || asText(contact.gender) || '';

    const maritalId = asId(contact.marital_status_id) ?? asId(contact.marital_status);
    const maritalText = (maritalId !== null && maritalListMap[maritalId]) || asText(contact.marital_status) || '';

    // Normalize into the flat shape the widget expects
    const normalized = {
      id: contact.id,
      first_name: contact.first_name || '',
      middle_name: contact.middle_name || '',
      last_name: contact.last_name || '',
      prefix: asText(contact.prefix) || asText(contact.salutation),
      suffix: asText(contact.suffix),
      job_title: asText(contact.job_title) || asText(contact.occupation),
      category_name: asText(contact.category_name) || asText(contact.category),
      status_name: asText(contact.status_name) || asText(contact.status),
      gender: genderText,
      gender_id: genderId,
      marital_status: maritalText,
      marital_status_id: maritalId,
      nickname: asText(contact.nickname),
      dob: asText(contact.dob) || asText(contact.date_of_birth) || asText(contact.birthdate),
      client_since: asText(contact.client_since) || asText(contact.clientSince) || asText(contact.date_became_client),
      anniversary: asText(contact.marital_date) || asText(contact.anniversary) || asText(contact.anniversary_date),
      addresses: (contact.addresses || []).map(a => {
        const rawType = a.address_type ?? a.type ?? a.kind;
        const typeId = asId(rawType);
        const typeName = (typeId !== null && addressTypeMap[typeId]) || asText(rawType);
        return {
          street_address: a.street_address || a.street_line_1 || '',
          street_address_2: a.street_address_2 || a.street_line_2 || '',
          city: a.city || '',
          state: asText(a.state),
          zip: a.zip || a.zip_code || '',
          country: asText(a.country),
          address_type: typeName,
          is_primary: !!(a.is_primary || a.primary),
        };
      }),
      phones: (contact.phones || []).map(p => {
        const rawType = p.phone_type ?? p.type ?? p.kind;
        const typeId = asId(rawType);
        const typeName = (typeId !== null && phoneTypeMap[typeId]) || asText(rawType);
        return {
          number: asText(p.number) || asText(p.phone),
          phone_type: typeName,
          is_primary: !!(p.is_primary || p.primary),
        };
      }),
      emails: (contact.emails || []).map(e => ({
        address: e.address || e.email || '',
        is_primary: !!(e.is_primary || e.primary),
      })),
      tags: contact.tags || [],
      custom_fields: contact.custom_fields || [],
      _debug_lookup_lists: {
        phone_type_map: phoneTypeMap,
        address_type_map: addressTypeMap,
        gender_map: genderListMap,
        marital_status_map: maritalListMap,
      },
      _debug_lookup_attempts: {
        phone: phoneResult.attempts,
        address: addressResult.attempts,
        gender: genderResult.attempts,
        marital: maritalResult.attempts,
      },
      _debug_raw_contact_keys: Object.keys(contact),
    };

    res.status(200).json(normalized);
  } catch (err) {
    res.status(500).json({ error: 'Relay error', detail: String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// NOTE on the API key: the Redtail credentials are passed in on every
// request from the JotForm widget's own settings (per-form, entered by
// whoever builds the JotForm), same pattern as your Wealthbox relay — just
// carried in the POST body instead of the URL so it never appears in a
// query string, browser history, or access log.
// ─────────────────────────────────────────────────────────────────────────
