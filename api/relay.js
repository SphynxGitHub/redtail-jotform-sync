// api/relay.js
//
// Vercel serverless function that looks up a Redtail contact by ID and
// returns clean JSON for the JotForm widget to consume.
//
// Usage: GET /api/relay?value=12345&key=YOUR_REDTAIL_USERKEY
//
// The Redtail Userkey is passed through from the JotForm widget setting
// (RedtailAPIKey) rather than stored here, matching how the Wealthbox relay
// worked. If you'd rather keep the key server-side only, see the note at
// the bottom of this file.

const REDTAIL_BASE = 'https://smf.crm3.redtailtechnology.com/api/public/v1';
// !! VERIFY: "smf" is your firm's Redtail subdomain, taken from the bulk-
// updater project. Confirm this is still correct before relying on it.

export default async function handler(req, res) {
  // CORS — JotForm embeds run on jotform.com / jotform domains
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { value, key } = req.query;

  if (!value) {
    res.status(400).json({ error: 'Missing "value" (Redtail Contact ID).' });
    return;
  }
  if (!key) {
    res.status(400).json({ error: 'Missing "key" (Redtail Userkey).' });
    return;
  }

  const contactId = String(value).trim();
  if (!/^\d+$/.test(contactId)) {
    res.status(400).json({ error: 'Contact ID must be numeric.' });
    return;
  }

  const authHeader = `Userkey userkey:${key}`;

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
// NOTE on the API key: right now the Redtail Userkey is passed in on every
// request from the JotForm widget setting, same pattern as your Wealthbox
// relay. If you'd rather not have the key travel through the querystring
// at all, store it as a Vercel environment variable (REDTAIL_USERKEY)
// instead, drop the `key` query param, and read it with
// `process.env.REDTAIL_USERKEY` here. That's more secure but means the key
// is fixed per-deployment rather than per-widget-instance.
// ─────────────────────────────────────────────────────────────────────────
