# Redtail JotForm Relay

Small Vercel serverless function that looks up a Redtail contact by ID and
returns clean JSON, for use by the Redtail JotForm custom widget.

## Deploy

1. Push this repo to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new) and import the repo.
   No build settings needed — Vercel auto-detects the `api/` folder.
3. Deploy. Your relay will be live at:
   `https://<your-project-name>.vercel.app/api/relay`

## Usage

```
GET /api/relay?value=12345&key=YOUR_REDTAIL_USERKEY
```

- `value` — the Redtail Contact ID (numeric)
- `key` — your Redtail Userkey (the part after `userkey:` in your API key)

Returns the contact as flat JSON, or a 404 if not found.

## Before going live — verify these

- **`REDTAIL_BASE` subdomain** in `api/relay.js` — currently set to
  `smf.crm3.redtailtechnology.com` based on your bulk-updater project.
  Confirm that's still your firm's subdomain.
- **Response shape** — the `contact.addresses` / `phones` / `emails` field
  names in the normalizer are best guesses based on common Redtail API
  shapes. Hit the relay with a real contact ID and compare against what
  actually comes back, then adjust the normalizer in `api/relay.js` if
  field names differ.
- **CORS** is wide open (`*`) since JotForm embeds run on jotform.com
  domains you don't control. If you want to lock it down, restrict
  `Access-Control-Allow-Origin` to JotForm's actual embed domain.

## Once deployed

Update `RELAY_URL` at the top of the widget script in
`redtail-jotform-widget.html` to point to your new relay's
`/api/relay` URL, then push the widget to GitHub Pages.
