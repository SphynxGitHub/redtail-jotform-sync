// api/relay.js
// VERSION: 2026-09-25-v4 (raw key, no client-side base64 encoding)
//
// Vercel serverless function that looks up a Redtail contact by ID and
// returns clean JSON for the JotForm widget to consume.
//
// Usage: POST /api/relay  with JSON body { "value": "12345", "key": "APIKey:Password" }
//
// The Redtail credentials come from the JotForm widget's own settings
// (filled in per-form by whoever builds it in JotForm's widget builder),
// same pattern as the Wealthbox relay — but sent as a POST body instead of
// a URL query param so the key never lands in a URL, browser history, or
// server access log.

const REDTAIL_BASE = 'https://smf.crm3.redtailtechnology.com/api/public/v1';
// !! VERIFY: "smf" is your firm's Redtail subdomain, taken from the bulk-
// updater project. Confirm this is still correct before relying on it.

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

  // TESTING: sending the key AS-IS (no re-encoding), in case Redtail issues
  // API keys that are already Base64 — re-encoding would double-encode it.
  const authHeader = `Userkey ${key}`;

  try {
    const rtRes = await fetch(`${REDTAIL_BASE}/contacts/${contactId}`, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

    const text = await rtRes.text();

    if (!rtRes.ok) {
      res.status(rtRes.status).json({
        error: `Redtail returned HTTP ${rtRes.status}`,
        detail: text.slice(0, 500),
        _version: '2026-09-25-v4',
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

    // Normalize into the flat shape the widget expects
    const normalized = {
      id: contact.id,
      first_name: contact.first_name || '',
      middle_name: contact.middle_name || '',
      last_name: contact.last_name || '',
      prefix: contact.prefix || contact.salutation || '',
      suffix: contact.suffix || '',
      job_title: contact.job_title || contact.occupation || '',
      category_name: contact.category_name || contact.category || '',
      status_name: contact.status_name || contact.status || '',
      addresses: (contact.addresses || []).map(a => ({
        street_address: a.street_address || a.street_line_1 || '',
        street_address_2: a.street_address_2 || a.street_line_2 || '',
        city: a.city || '',
        state: a.state || '',
        zip: a.zip || a.zip_code || '',
        country: a.country || '',
        address_type: a.address_type || a.type || a.kind || '',
        is_primary: !!(a.is_primary || a.primary),
      })),
      phones: (contact.phones || []).map(p => ({
        number: p.number || p.phone || '',
        phone_type: p.phone_type || p.type || p.kind || '',
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
