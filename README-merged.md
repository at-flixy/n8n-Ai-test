# Merged Intake (Service Account, no Google OAuth)

This is a merged project:
- Base: **Ai 2** (server + proxy auth via Service Account)
- UI/logic: **project-local-latest** (app.js, style.css)

## Structure
- `assets/` — static frontend (index.html, bulk.html, registry.html)
- `assets/js/api-gis.js` — calls backend via `/api/*` using a `google.script.run`-like proxy
- `server/` — Node.js server using `googleapis` with Service Account (JWT)

## .env example (server/.env)
PORT=5500
CORS_ORIGIN=http://localhost:3000,http://127.0.0.1:3000
REGISTRY_SPREADSHEET_ID=YOUR_SHEET_ID
REGISTRY_SHEET=Registry
SERVICE_ACCOUNT_FILE=./service-account.json
# OR pass key as base64 (one of the two must be set):
# GCP_SA_JSON=BASE64_ENCODED_SERVICE_ACCOUNT_JSON

# Optional
API_KEY=
N8N_URL=https://your-n8n-host/webhook/whatever

> Make sure the Google Sheet is **shared** with the service account email (Editor).

## Run
cd server
npm i
npm run dev  # starts http://localhost:5500

# In another terminal (from the project root)
npx serve .     # or any static server to serve index.html on http://localhost:3000

## Notes
- Frontend sends requests to `window.__REGISTRY_PROXY_BASE__` (set in HTML files) and optional `window.__REGISTRY_PROXY_KEY__` for x-api-key.
- All buttons (Validate, Provision, Add Model, Bulk Add) call the backend which reads/writes Sheets via the Service Account.
- `/api/n8n-intake` proxies payloads to `N8N_URL` using `application/x-www-form-urlencoded` with field `payload`.
