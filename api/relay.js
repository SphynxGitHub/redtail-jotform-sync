// api/relay.js
// VERSION: 2026-09-25-v6 (defensive string coercion for object-shaped fields)
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
        _version: '2026-09-25-v6',
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
      addresses: (contact.addresses || []).map(a => ({
        street_address: a.street_address || a.street_line_1 || '',
        street_address_2: a.street_address_2 || a.street_line_2 || '',
        city: a.city || '',
        state: asText(a.state),
        zip: a.zip || a.zip_code || '',
        country: asText(a.country),
        address_type: asText(a.address_type) || asText(a.type) || asText(a.kind),
        is_primary: !!(a.is_primary || a.primary),
      })),
      phones: (contact.phones || []).map(p => ({
        number: p.number || p.phone || '',
        phone_type: asText(p.phone_type) || asText(p.type) || asText(p.kind),
        is_primary: !!(p.is_primary || p.primary),
      })),
      emails: (contact.emails || []).map(e => ({
        address: e.address || e.email || '',
        is_primary: !!(e.is_primary || e.primary),
      })),
      tags: contact.tags || [],
      custom_fields: contact.custom_fields || [],
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
