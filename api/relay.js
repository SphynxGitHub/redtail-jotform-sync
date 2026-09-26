// api/relay.js
//
// Vercel serverless function that looks up a Redtail contact by ID and
// returns clean JSON for the JotForm widget to consume.
//
// Usage: POST /api/relay  with JSON body { "value": "12345", "key": "YOUR_REDTAIL_KEY" }
//
// Auth: the Redtail key goes directly into the Authorization header,
// unmodified (no "Userkey"/"Basic" scheme prefix, no Base64 encoding) —
// confirmed against a working integration on this account.
//
// The key comes from the JotForm widget's own settings (RedtailAPIKey,
// filled in per-form in JotForm's widget builder), sent as a POST body
// field rather than a URL query param so it never lands in a URL, browser
// history, or access log.

const REDTAIL_BASE = 'https://smf.crm3.redtailtechnology.com/api/public/v1';

// Phone/address "type" fields are fixed system-wide enums on this account
// (confirmed via Redtail's own API reference, not a fetchable /lists
// endpoint — every /lists/phone_types-style path 404s).
const PHONE_TYPE_MAP = {
  1: 'Home', 2: 'Work', 3: 'Mobile', 4: 'Fax', 5: 'Other',
  6: 'Direct Dial', 7: 'Toll Free',
};
const ADDRESS_TYPE_MAP = {
  1: 'Home', 2: 'Work', 3: 'Mailing', 4: 'Other',
};

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
    res.status(400).json({ error: 'Missing "key" (Redtail API key).' });
    return;
  }

  const contactId = String(value).trim();
  if (!/^\d+$/.test(contactId)) {
    res.status(400).json({ error: 'Contact ID must be numeric.' });
    return;
  }

  const authHeader = key;

  // Generic authenticated GET, tolerant of 404s/errors — many contacts
  // won't have data at every one of these sub-endpoints (financial info,
  // identifications, etc.), and a missing one shouldn't break the whole
  // lookup.
  async function fetchJson(path) {
    try {
      const r = await fetch(`${REDTAIL_BASE}${path}`, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  // Fetch the UDF (custom field) definitions — contact.custom_fields
  // entries reference these by id and don't carry their own name.
  async function fetchUdfMap() {
    const j = await fetchJson('/lists/contact_udfs?page=1');
    if (!j) return {};
    const arr = Array.isArray(j) ? j : (j.udfs || j.data || j.items || []);
    const map = {};
    for (const item of (Array.isArray(arr) ? arr : [])) {
      const id = item.id;
      const name = item.name || item.label || item.description;
      if (id !== undefined && name) map[id] = name;
    }
    return map;
  }

  // Pull the array out of whatever wrapper key a list-style endpoint uses.
  function unwrapArray(j, ...keys) {
    if (!j) return [];
    if (Array.isArray(j)) return j;
    for (const k of keys) if (Array.isArray(j[k])) return j[k];
    // fall back: first array value found on the object
    for (const v of Object.values(j)) if (Array.isArray(v)) return v;
    return [];
  }

  try {
    const [
      rtRes, udfMap,
      roleData, employmentsData, assetsData, liabilitiesData,
      taxData, identificationsData, personalProfileData, importantInfoData,
      udfValuesData, samData,
    ] = await Promise.all([
      fetch(`${REDTAIL_BASE}/contacts/${contactId}`, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          include: 'emails,addresses,phones,family,family.members',
        },
      }),
      fetchUdfMap(),
      fetchJson(`/contacts/${contactId}/role`),
      fetchJson(`/contacts/${contactId}/employments?page=1`),
      fetchJson(`/contacts/${contactId}/assets`),
      fetchJson(`/contacts/${contactId}/liabilities`),
      fetchJson(`/contacts/${contactId}/tax`),
      fetchJson(`/contacts/${contactId}/identifications?page=1`),
      fetchJson(`/contacts/${contactId}/personal_profile`),
      fetchJson(`/contacts/${contactId}/important_information`),
      fetchJson(`/contacts/${contactId}/udfs`),
      fetchJson(`/contacts/${contactId}/sam`),
    ]);

    const text = await rtRes.text();

    if (!rtRes.ok) {
      res.status(rtRes.status).json({
        error: `Redtail returned HTTP ${rtRes.status}`,
        detail: text.slice(0, 500),
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
    // (e.g. { "contact": {...} }).
    const contact = data.contact || data;

    if (!contact || !contact.id) {
      res.status(404).json({ error: 'No record found.' });
      return;
    }

    // Some fields can come back as a plain string or an object like
    // { id: 2, name: "Home" } — pulls a usable string out of either shape.
    const asText = (val) => {
      if (val === null || val === undefined) return '';
      if (typeof val === 'string' || typeof val === 'number') return String(val);
      if (typeof val === 'object') return val.name || val.label || val.value || '';
      return '';
    };

    const asId = (val) => {
      if (val === null || val === undefined) return null;
      if (typeof val === 'number') return val;
      if (typeof val === 'object') return val.id ?? null;
      if (typeof val === 'string' && /^\d+$/.test(val.trim())) return Number(val);
      return null;
    };

    // Pass through EVERY scalar (string/number/boolean) top-level field
    // Redtail returns — not just a hand-picked list — so the widget's
    // generic label-matching loop can pick up fields we haven't explicitly
    // named (Contact Source, Servicing/Writing Advisor, Company Name, CSA,
    // Occupation Start Date, etc.), same pattern as the Wealthbox relay.
    const passthrough = {};
    for (const k of Object.keys(contact)) {
      const v = contact[k];
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        passthrough[k] = v;
      } else if (typeof v === 'object' && !Array.isArray(v) && (v.name || v.label)) {
        // e.g. { id: 2, name: "Home" } shaped fields — flatten to their text
        passthrough[k] = v.name || v.label;
      }
    }

    // Same scalar-flattening treatment for the single-object sub-endpoints
    // (role, tax, personal_profile, important_information) — merged into
    // the same passthrough bucket so the widget's generic loop can match
    // them by label too, e.g. "Client Risk Tolerance" or "Client Tax Rate".
    function unwrapSingle(j) {
      if (!j) return {};
      if (Array.isArray(j)) return j[0] || {};
      const keys = Object.keys(j);
      // If the payload is just one wrapper key holding an object, unwrap it
      // (e.g. { role: {...} }, { tax_info: {...} }).
      if (keys.length === 1 && typeof j[keys[0]] === 'object' && !Array.isArray(j[keys[0]])) {
        return j[keys[0]] || {};
      }
      return j;
    }
    function flattenScalars(obj, prefix) {
      const out = {};
      for (const k of Object.keys(obj || {})) {
        const v = obj[k];
        if (v === null || v === undefined) continue;
        const key = prefix ? `${prefix}_${k}` : k;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          out[key] = v;
        } else if (typeof v === 'object' && !Array.isArray(v) && (v.name || v.label)) {
          out[key] = v.name || v.label;
        }
      }
      return out;
    }

    Object.assign(passthrough, flattenScalars(unwrapSingle(roleData), 'role'));
    Object.assign(passthrough, flattenScalars(unwrapSingle(taxData), 'tax'));
    Object.assign(passthrough, flattenScalars(unwrapSingle(personalProfileData), 'personal_profile'));
    Object.assign(passthrough, flattenScalars(unwrapSingle(importantInfoData), 'important_info'));

    // A handful of fields match common Redtail form field names directly
    // (as seen on the actual JotForm), better than the generic role_/
    // employer-prefixed auto-labels — expose them unprefixed too so the
    // widget's label matching hits on the first try.
    const roleObj = unwrapSingle(roleData);
    if (roleObj.associate_advisor) passthrough.associate_advisor = asText(roleObj.associate_advisor);
    if (roleObj.csa) passthrough.csa = asText(roleObj.csa);
    if (roleObj.advisor) passthrough.advisor = asText(roleObj.advisor);

    // Personal Profile: prefer the readable *_description fields over raw
    // ids, and expose them unprefixed to match the form's actual labels
    // ("Maiden Name", "Citizenship", "Country for Alien Citizenship").
    const profileObj = unwrapSingle(personalProfileData);
    if (profileObj.maiden_name) passthrough.maiden_name = asText(profileObj.maiden_name);
    if (profileObj.citizenship_description) passthrough.citizenship = asText(profileObj.citizenship_description);
    if (profileObj.alien_country) passthrough.country_for_alien_citizenship = asText(profileObj.alien_country);
    if (profileObj.birth_place) passthrough.birth_place = asText(profileObj.birth_place);

    // Strategic Allocation Model (SAM) — Time Horizon / Risk Tolerance /
    // Objective, same "prefer the description field" treatment.
    const samObj = unwrapSingle(samData);
    if (samObj.time_horizon_description) passthrough.time_horizon = asText(samObj.time_horizon_description);
    if (samObj.risk_tolerance_description) passthrough.risk_tolerance = asText(samObj.risk_tolerance_description);
    if (samObj.objective) passthrough.investment_objective = asText(samObj.objective);

    // Important Information is a free-text HTML note — strip tags for a
    // clean plain-text value.
    const importantInfoObj = unwrapSingle(importantInfoData);
    if (importantInfoObj.content) {
      passthrough.important_information = asText(importantInfoObj.content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    const employmentsArr = unwrapArray(employmentsData, 'employments', 'data');
    const primaryEmployment = employmentsArr[0] || null;
    if (primaryEmployment) {
      if (primaryEmployment.occupation) passthrough.occupation_name = primaryEmployment.occupation;
      if (primaryEmployment.occupation_start_date) passthrough.occupation_start_date = primaryEmployment.occupation_start_date;
      if (primaryEmployment.retirement_date) passthrough.retirement_date = primaryEmployment.retirement_date;
      if (primaryEmployment.gai) passthrough.gross_annual_income = primaryEmployment.gai;
    }

    // Normalize into the flat shape the widget expects. Passthrough fields
    // go first so the explicit overrides below (readable type names, nicer
    // fallbacks) win where both exist.
    const normalized = {
      ...passthrough,
      id: contact.id,
      first_name: contact.first_name || '',
      middle_name: contact.middle_name || '',
      last_name: contact.last_name || '',
      prefix: asText(contact.prefix) || asText(contact.salutation),
      suffix: asText(contact.suffix),
      job_title: asText(contact.job_title) || asText(contact.occupation),
      category_name: asText(contact.category_name) || asText(contact.category),
      status_name: asText(contact.status_name) || asText(contact.status),
      gender: asText(contact.gender),
      gender_id: asId(contact.gender_id),
      marital_status: asText(contact.marital_status),
      marital_status_id: asId(contact.marital_status_id),
      nickname: asText(contact.nickname),
      dob: asText(contact.dob),
      client_since: asText(contact.client_since),
      anniversary: asText(contact.marital_date),
      addresses: (contact.addresses || []).map(a => {
        const typeId = asId(a.address_type ?? a.type ?? a.kind);
        const typeName = (typeId !== null && ADDRESS_TYPE_MAP[typeId]) || asText(a.address_type);
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
        const typeId = asId(p.phone_type ?? p.type ?? p.kind);
        const typeName = (typeId !== null && PHONE_TYPE_MAP[typeId]) || asText(p.phone_type);
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
      custom_fields: unwrapArray(
        (contact.custom_fields && contact.custom_fields.length) ? contact.custom_fields : udfValuesData,
        'custom_fields', 'contact_udfs', 'udfs', 'data'
      ).map(cf => ({
        id: cf.id,
        name: cf.contact_udf_field_name || cf.name || udfMap[cf.id] || `Custom Field ${cf.id}`,
        value: cf.field_value ?? cf.value ?? cf.data ?? '',
      })),
      employments: employmentsArr.map(x => flattenScalars(x)),
      assets: unwrapArray(assetsData, 'assets', 'data').map(x => flattenScalars(x)),
      liabilities: unwrapArray(liabilitiesData, 'liabilities', 'data').map(x => flattenScalars(x)),
      identifications: unwrapArray(identificationsData, 'identifications', 'data').map(x => flattenScalars(x)),
    };

    res.status(200).json(normalized);
  } catch (err) {
    res.status(500).json({ error: 'Relay error', detail: String(err) });
  }
}
