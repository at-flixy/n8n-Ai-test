// Express + Google Sheets (Service Account) + n8n + Registry tools
const path = require('path')
const fs = require('fs')
const express = require('express')
const cors = require('cors')
const { google } = require('googleapis')

require('dotenv').config({ path: path.join(__dirname, '.env') })

const {
	PORT = 5500,
	CORS_ORIGIN = '',
	API_KEY = '',

	// Registry location
	REGISTRY_SPREADSHEET_ID,
	REGISTRY_SHEET = 'Registry',

	// Service Account
	SERVICE_ACCOUNT_FILE = path.join(__dirname, 'service-account.json'),
	GCP_SA_JSON = '',

	// n8n
	N8N_DEV_WEBHOOK_URL = '',
	N8N_DEV_WEBHOOK_HEADER_NAME = 'X-Webhook-Token',
	N8N_DEV_WEBHOOK_TOKEN = '',
	N8N_PROD_WEBHOOK_URL = '',
	N8N_PROD_WEBHOOK_HEADER_NAME = 'X-Webhook-Token',
	N8N_PROD_WEBHOOK_TOKEN = '',
} = process.env

if (!REGISTRY_SPREADSHEET_ID) {
	console.warn('[WARN] REGISTRY_SPREADSHEET_ID is not set.')
}

const app = express()

/* ---------------- CORS ---------------- */
const corsAllow = (CORS_ORIGIN || '')
	.split(',')
	.map(s => s.trim())
	.filter(Boolean)
app.use(
	cors({
		origin(origin, cb) {
			if (!origin) return cb(null, true)
			if (corsAllow.length === 0 || corsAllow.includes(origin))
				return cb(null, true)
			cb(new Error('CORS not allowed: ' + origin))
		},
		credentials: true,
	})
)

/* ---------------- JSON ---------------- */
app.use(express.json({ limit: '1mb' }))

/* -------- Optional x-api-key --------- */
app.use('/api', (req, res, next) => {
	if (!API_KEY) return next()
	const key = req.get('x-api-key') || req.get('X-Api-Key') || ''
	if (key && key === API_KEY) return next()
	return res
		.status(401)
		.json({ ok: false, error: 'Unauthorized (x-api-key mismatch)' })
})

/* ---------------- Health -------------- */
app.get('/api/health', (req, res) => res.json({ ok: true }))

/* ============== Google Auth (SA) ============== */
let _authCache = null
async function getAuthClient() {
	if (_authCache) return _authCache
	let creds
	if (GCP_SA_JSON) {
		const json = Buffer.from(GCP_SA_JSON, 'base64').toString('utf8')
		creds = JSON.parse(json)
	} else {
		const p = path.isAbsolute(SERVICE_ACCOUNT_FILE)
			? SERVICE_ACCOUNT_FILE
			: path.join(__dirname, SERVICE_ACCOUNT_FILE)
		if (!fs.existsSync(p))
			throw new Error(`Service account file not found: ${p}`)
		creds = JSON.parse(fs.readFileSync(p, 'utf8'))
	}
	const scopes = [
		'https://www.googleapis.com/auth/spreadsheets',
		'https://www.googleapis.com/auth/drive.readonly',
	]
	const jwt = new google.auth.JWT(
		creds.client_email,
		null,
		creds.private_key,
		scopes,
		null
	)
	_authCache = jwt
	return jwt
}

const sheetsAPI = google.sheets('v4')

/* ================= Utils ================= */
function slugify(...parts) {
	return parts
		.map(s =>
			String(s || '')
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '_')
		)
		.filter(Boolean)
		.join('_')
		.replace(/^_+|_+$/g, '')
}
function colLetter(n) {
	let s = '',
		num = n
	while (num > 0) {
		const m = (num - 1) % 26
		s = String.fromCharCode(65 + m) + s
		num = Math.floor((num - 1) / 26)
	}
	return s
}
function buildRowByHeader(header, obj) {
	return header.map(h =>
		Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : ''
	)
}

async function ensureModelsSheetAndHeader({
	spreadsheetId,
	sheetName,
	header,
}) {
	const auth = await getAuthClient()
	// open
	let meta
	try {
		meta = await sheetsAPI.spreadsheets.get({ auth, spreadsheetId })
	} catch (e) {
		throw new Error(
			`Cannot open spreadsheet ${spreadsheetId}. ${e.message || e}`
		)
	}
	// sheet exists?
	const exists = (meta.data.sheets || []).some(
		sh => sh.properties && sh.properties.title === sheetName
	)
	if (!exists) {
		await sheetsAPI.spreadsheets.batchUpdate({
			auth,
			spreadsheetId,
			requestBody: {
				requests: [{ addSheet: { properties: { title: sheetName } } }],
			},
		})
	}
	// header
	let currentHeader = []
	try {
		const r = await sheetsAPI.spreadsheets.values.get({
			auth,
			spreadsheetId,
			range: `${sheetName}!1:1`,
		})
		currentHeader = (r.data.values && r.data.values[0]) || []
	} catch {}
	if (!currentHeader.length) {
		await sheetsAPI.spreadsheets.values.update({
			auth,
			spreadsheetId,
			range: `${sheetName}!A1`,
			valueInputOption: 'RAW',
			requestBody: { values: [header] },
		})
	}
}

async function upsertByKey({
	spreadsheetId,
	sheetName,
	header,
	obj,
	keyField = 'Key',
}) {
	const auth = await getAuthClient()
	// ensure header
	let hdrRes = await sheetsAPI.spreadsheets.values.get({
		auth,
		spreadsheetId,
		range: `${sheetName}!1:1`,
	})
	let hdr = (hdrRes.data.values && hdrRes.data.values[0]) || []
	if (!hdr.length) {
		await sheetsAPI.spreadsheets.values.update({
			auth,
			spreadsheetId,
			range: `${sheetName}!A1`,
			valueInputOption: 'RAW',
			requestBody: { values: [header] },
		})
		hdr = header.slice()
	}
	const keyIdx = hdr.indexOf(keyField)
	if (keyIdx === -1) throw new Error(`Header has no "${keyField}" column`)

	const lastCol = colLetter(hdr.length)
	const valuesRes = await sheetsAPI.spreadsheets.values.get({
		auth,
		spreadsheetId,
		range: `${sheetName}!A2:${lastCol}`,
	})
	const rows = valuesRes.data.values || []

	const keyValue = String(obj[keyField] ?? '').trim()
	let foundRowNumber = null
	for (let i = 0; i < rows.length; i++) {
		const cell = (rows[i] || [])[keyIdx] || ''
		if (String(cell).trim() === keyValue && keyValue) {
			foundRowNumber = i + 2
			break
		}
	}
	const rowValues = buildRowByHeader(hdr, obj)

	if (foundRowNumber) {
		await sheetsAPI.spreadsheets.values.update({
			auth,
			spreadsheetId,
			range: `${sheetName}!A${foundRowNumber}:${lastCol}${foundRowNumber}`,
			valueInputOption: 'USER_ENTERED',
			requestBody: { values: [rowValues] },
		})
		return { upsert: 'update', row: foundRowNumber }
	} else {
		await sheetsAPI.spreadsheets.values.append({
			auth,
			spreadsheetId,
			range: `${sheetName}!A1`,
			valueInputOption: 'USER_ENTERED',
			insertDataOption: 'INSERT_ROWS',
			requestBody: { values: [rowValues] },
		})
		return { upsert: 'insert' }
	}
}

/* ---------- n8n helpers ---------- */
function getN8NConfig(env = 'dev') {
	if (env === 'prod') {
		return {
			url: process.env.N8N_PROD_WEBHOOK_URL,
			headerName: process.env.N8N_PROD_WEBHOOK_HEADER_NAME || 'X-Webhook-Token',
			token: process.env.N8N_PROD_WEBHOOK_TOKEN,
		}
	}
	return {
		url: process.env.N8N_DEV_WEBHOOK_URL,
		headerName: process.env.N8N_DEV_WEBHOOK_HEADER_NAME || 'X-Webhook-Token',
		token: process.env.N8N_DEV_WEBHOOK_TOKEN,
	}
}
async function triggerN8N(env, target) {
	const { url, headerName, token } = getN8NConfig(env)
	if (!url) return { skipped: true, reason: 'no_url' }
	const headers = { 'Content-Type': 'application/json' }
	if (headerName && token) headers[headerName] = token
	const body = {
		spreadsheet_id: target.spreadsheetId,
		sheet_name: target.sheetName,
	}
	const res = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(8000),
	})
	const text = await res.text().catch(() => '')
	return { ok: res.ok, status: res.status, body: text.slice(0, 300) }
}

/* ============== Registry ============== */
async function readRegistry() {
	const spreadsheetId = process.env.REGISTRY_SPREADSHEET_ID
	const sheetName = process.env.REGISTRY_SHEET || 'Registry'
	if (!spreadsheetId) throw new Error('REGISTRY_SPREADSHEET_ID is not set')

	const auth = await getAuthClient()
	const res = await sheetsAPI.spreadsheets.values.get({
		auth,
		spreadsheetId,
		range: `${sheetName}!A1:Z`,
	})
	const values = res.data.values || []
	if (values.length === 0) return []

	const headers = (values[0] || []).map(h => String(h || '').trim())
	const hmap = {}
	headers.forEach((h, idx) => {
		hmap[h.toLowerCase()] = idx
	})

	const idx = (name, ...aliases) => {
		const key = String(name).toLowerCase()
		if (key in hmap) return hmap[key]
		for (const a of aliases) {
			const k = String(a).toLowerCase()
			if (k in hmap) return hmap[k]
		}
		return -1
	}

	const rows = values
		.slice(1)
		.map(r => {
			const get = (name, def = '', ...aliases) => {
				const i = idx(name, ...aliases)
				return i >= 0 ? r[i] ?? def : def
			}
			return {
				key: get('key'),
				category: get('category'),
				system_prompt: get('system_prompt'),
				user_prompt: get('user_prompt'),
				search_queries: get('search_queries'),
				json_schema: get('json_schema'),
				confidence_threshold: get('confidence_threshold'),

				target_spreadsheet_id_models: get('target_spreadsheet_id_models', ''),
				target_spreadsheet_id_category: get(
					'target_spreadsheet_id_category',
					''
				),
				target_spreadsheet_id_review: get('target_spreadsheet_id_review', ''),

				models_sheet: get('models_sheet', 'Models'),
				category_sheet: get('category_sheet', 'Category'),
				review_sheet: get('review_sheet', 'Review'),
			}
		})
		.filter(r => r.category || r.key)

	return rows
}

/* ---- helpers needed by registry routes ---- */
function findRegistryRow(items, { category, key }) {
	if (!Array.isArray(items)) return null
	if (category)
		return (
			items.find(
				r => String(r.category || '').trim() === String(category).trim()
			) || null
		)
	if (key)
		return (
			items.find(r => String(r.key || '').trim() === String(key).trim()) || null
		)
	return null
}

function parseSchemaColumns(schema) {
	const base = [
		'Manufacturer',
		'Model',
		'Year',
		'Category',
		'Key',
		'Status',
		'CreatedAt',
		'Sources',
	]
	const required = Array.isArray(schema?.required) ? schema.required : []
	const props = schema && schema.properties ? schema.properties : {}
	const order = Object.keys(props)
	const isBase = new Set(base.map(s => s.toLowerCase()))
	const cols = [...base]

	const toHeader = name =>
		isBase.has(String(name).toLowerCase())
			? base.find(b => b.toLowerCase() === String(name).toLowerCase())
			: name

	// required (без дублей)
	for (const r of required) {
		if (!props[r]) continue
		const h = toHeader(r)
		if (!cols.some(c => c.toLowerCase() === h.toLowerCase())) cols.push(h)
	}
	// остальные по порядку объявления
	for (const k of order) {
		const h = toHeader(k)
		if (!cols.some(c => c.toLowerCase() === h.toLowerCase())) cols.push(h)
	}
	return { columns: cols, base, required, properties: order }
}

async function ensureSheetExists({ spreadsheetId, sheetName }) {
	const auth = await getAuthClient()
	const doc = await sheetsAPI.spreadsheets.get({ auth, spreadsheetId })
	const sheet = (doc.data.sheets || []).find(
		s => s.properties && s.properties.title === sheetName
	)
	if (sheet) return { created: false }
	await sheetsAPI.spreadsheets.batchUpdate({
		auth,
		spreadsheetId,
		requestBody: {
			requests: [{ addSheet: { properties: { title: sheetName } } }],
		},
	})
	return { created: true }
}

async function writeHeader({ spreadsheetId, sheetName, header }) {
	const auth = await getAuthClient()
	await sheetsAPI.spreadsheets.values.update({
		auth,
		spreadsheetId,
		range: `${sheetName}!A1`,
		valueInputOption: 'USER_ENTERED',
		requestBody: { values: [header] },
	})
}
async function readHeader({ spreadsheetId, sheetName }) {
	const auth = await getAuthClient()
	const res = await sheetsAPI.spreadsheets.values.get({
		auth,
		spreadsheetId,
		range: `${sheetName}!1:1`,
	})
	return (res.data.values && res.data.values[0]) || []
}

/* ============== Routes (Registry) ============== */
app.get('/api/registry/categories', async (req, res) => {
	try {
		const rows = await readRegistry()
		const set = new Set()
		rows.forEach(r => {
			if (r.category) set.add(r.category)
		})
		res.json({ ok: true, categories: Array.from(set) })
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e) })
	}
})

app.get('/api/registry/list', async (req, res) => {
	try {
		res.json({ ok: true, items: await readRegistry() })
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e) })
	}
})

app.post('/api/registry/parse-schema', async (req, res) => {
	try {
		const { category, key } = req.body || {}
		const items = await readRegistry()
		const row = findRegistryRow(items, { category, key })
		if (!row) return res.status(404).json({ ok: false, error: 'Not found' })
		let schema = {}
		try {
			schema = JSON.parse(row.json_schema || '{}')
		} catch {}
		const parsed = parseSchemaColumns(schema)
		res.json({
			ok: true,
			schema,
			...parsed,
			target: {
				spreadsheetId: row.target_spreadsheet_id_category,
				sheetName: row.category_sheet || 'Category',
			},
		})
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e) })
	}
})

app.post('/api/registry/provision-category', async (req, res) => {
	try {
		const { category, key } = req.body || {}
		const items = await readRegistry()
		const row = findRegistryRow(items, { category, key })
		if (!row) return res.status(404).json({ ok: false, error: 'Not found' })

		let schema = {}
		try {
			schema = JSON.parse(row.json_schema || '{}')
		} catch {}
		const { columns } = parseSchemaColumns(schema)

		const target = {
			spreadsheetId: row.target_spreadsheet_id_category,
			sheetName: row.category_sheet || 'Category',
		}
		if (!target.spreadsheetId) {
			return res.status(400).json({
				ok: false,
				error:
					'Missing target_spreadsheet_id_category (empty in Registry row or header name mismatch)',
			})
		}

		await ensureSheetExists(target)
		await writeHeader({ ...target, header: columns })
		res.json({ ok: true, target, columnsCount: columns.length })
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e) })
	}
})

app.post('/api/registry/validate-category', async (req, res) => {
	try {
		const { category, key } = req.body || {}
		const items = await readRegistry()
		const row = findRegistryRow(items, { category, key })
		if (!row) return res.status(404).json({ ok: false, error: 'Not found' })

		let schema = {}
		try {
			schema = JSON.parse(row.json_schema || '{}')
		} catch {}
		const { columns } = parseSchemaColumns(schema)

		const target = {
			spreadsheetId: row.target_spreadsheet_id_category,
			sheetName: row.category_sheet || 'Category',
		}
		if (!target.spreadsheetId) {
			return res.status(400).json({
				ok: false,
				error:
					'Missing target_spreadsheet_id_category (empty in Registry row or header name mismatch)',
			})
		}

		await ensureSheetExists(target)
		const header = await readHeader(target)
		const valid =
			Array.isArray(header) &&
			header.length === columns.length &&
			header.every((v, i) => String(v).trim() === String(columns[i]).trim())
		res.json({ ok: true, valid, expected: columns, header })
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e) })
	}
})

app.post('/api/registry/test-access', async (req, res) => {
	try {
		const { category, key } = req.body || {}
		const items = await readRegistry()
		const row = findRegistryRow(items, { category, key })
		if (!row) return res.status(404).json({ ok: false, error: 'Not found' })

		const target = {
			spreadsheetId: row.target_spreadsheet_id_category,
			sheetName: row.category_sheet || 'Category',
		}
		if (!target.spreadsheetId)
			return res
				.status(400)
				.json({ ok: false, error: 'Missing target_spreadsheet_id_category' })

		const header = await readHeader(target) // простая попытка чтения
		res.json({ ok: true, canRead: true, header })
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e) })
	}
})

app.post('/api/registry/provision-all', async (req, res) => {
	try {
		const items = await readRegistry()
		const rows = items.filter(r => r.target_spreadsheet_id_category)
		let done = 0,
			errors = []
		for (const r of rows) {
			try {
				let schema = {}
				try {
					schema = JSON.parse(r.json_schema || '{}')
				} catch {}
				const { columns } = parseSchemaColumns(schema)
				const target = {
					spreadsheetId: r.target_spreadsheet_id_category,
					sheetName: r.category_sheet || 'Category',
				}
				await ensureSheetExists(target)
				await writeHeader({ ...target, header: columns })
				done++
			} catch (e) {
				errors.push({ category: r.category, error: String(e) })
			}
		}
		res.json({ ok: true, total: rows.length, done, errors })
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e) })
	}
})

/* ============== Add Model (dev/prod) — без дублей ============== */
app.post('/api/addModel', async (req, res) => {
	try {
		const data = req.body
		const rows = await readRegistry()
		const rec = rows.find(r => r.category === data.Category)
		if (!rec)
			return res
				.status(404)
				.json({ ok: false, error: `Category ${data.Category} not found` })

		const target = {
			spreadsheetId: rec.target_spreadsheet_id_models,
			sheetName: rec.models_sheet || 'Models',
		}
		const header = [
			'Manufacturer',
			'Model',
			'Year',
			'Category',
			'Key',
			'Status',
			'CreatedAt',
		]
		await ensureModelsSheetAndHeader({ ...target, header })

		const obj = {
			Manufacturer: data.Manufacturer ?? '',
			Model: data.Model ?? '',
			Year: data.Year ?? '',
			Category: data.Category ?? '',
			Key:
				(data.Key && String(data.Key).trim()) ||
				slugify(data.Manufacturer, data.Model, data.Year, data.Category),
			Status: data.Status ?? 'Pending',
			CreatedAt: data.CreatedAt ?? new Date().toISOString(),
		}

		const upsert = await upsertByKey({
			...target,
			header,
			obj,
			keyField: 'Key',
		})
		const n8n = await triggerN8N('dev', target).catch(e => ({
			ok: false,
			error: String(e),
		}))
		console.log('[n8n] env=dev ->', getN8NConfig('dev').url || 'none')
		res.json({ ok: true, env: 'dev', target, upsert, n8n })
	} catch (err) {
		const msg = String((err && err.message) || err)
		return res.status(500).json({ ok: false, error: msg })
	}
})

app.post('/api/addModelProd', async (req, res) => {
	try {
		const data = req.body
		const rows = await readRegistry()
		const rec = rows.find(r => r.category === data.Category)
		if (!rec)
			return res
				.status(404)
				.json({ ok: false, error: `Category ${data.Category} not found` })

		const target = {
			spreadsheetId: rec.target_spreadsheet_id_models,
			sheetName: rec.models_sheet || 'Models',
		}
		const header = [
			'Manufacturer',
			'Model',
			'Year',
			'Category',
			'Key',
			'Status',
			'CreatedAt',
		]
		await ensureModelsSheetAndHeader({ ...target, header })

		const obj = {
			Manufacturer: data.Manufacturer ?? '',
			Model: data.Model ?? '',
			Year: data.Year ?? '',
			Category: data.Category ?? '',
			Key:
				(data.Key && String(data.Key).trim()) ||
				slugify(data.Manufacturer, data.Model, data.Year, data.Category),
			Status: data.Status ?? 'Pending',
			CreatedAt: data.CreatedAt ?? new Date().toISOString(),
		}

		const upsert = await upsertByKey({
			...target,
			header,
			obj,
			keyField: 'Key',
		})
		const n8n = await triggerN8N('prod', target).catch(e => ({
			ok: false,
			error: String(e),
		}))
		console.log('[n8n] env=prod ->', getN8NConfig('prod').url || 'none')
		res.json({ ok: true, env: 'prod', target, upsert, n8n })
	} catch (err) {
		return res
			.status(500)
			.json({ ok: false, error: String((err && err.message) || err) })
	}
})



/* ================= Bulk Helpers ================= */
async function upsertManyByKey({ spreadsheetId, sheetName, header, items, keyField = 'Key' }) {
	const auth = await getAuthClient();

	// Ensure header exists and fetch it
	let hdrRes = await sheetsAPI.spreadsheets.values.get({
		auth, spreadsheetId, range: `${sheetName}!1:1`
	});
	let hdr = (hdrRes.data.values && hdrRes.data.values[0]) || [];
	if (!hdr.length) {
		await sheetsAPI.spreadsheets.values.update({
			auth, spreadsheetId, range: `${sheetName}!A1`,
			valueInputOption: 'RAW', requestBody: { values: [header] }
		});
		hdr = header.slice();
	}
	const keyIdx = hdr.indexOf(keyField);
	if (keyIdx === -1) throw new Error(`Header has no "${keyField}" column`);

	// Read existing keys map
	const lastCol = colLetter(hdr.length);
	const valuesRes = await sheetsAPI.spreadsheets.values.get({
		auth, spreadsheetId, range: `${sheetName}!A2:${lastCol}`
	});
	const rows = valuesRes.data.values || [];
	const keyToRow = new Map();
	for (let i = 0; i < rows.length; i++) {
		const cell = (rows[i] || [])[keyIdx] || '';
		if (cell) keyToRow.set(String(cell).trim(), i + 2); // row number
	}

	// Prepare updates & inserts
	const dataUpdates = [];
	const inserts = [];
	let updated = 0, inserted = 0;

	for (const obj of items) {
		const rowValues = buildRowByHeader(hdr, obj);
		const keyValue = String(obj[keyField] ?? '').trim();
		const rowNumber = keyToRow.get(keyValue);
		if (rowNumber) {
			dataUpdates.push({
				range: `${sheetName}!A${rowNumber}:${lastCol}${rowNumber}`,
				values: [rowValues]
			});
			updated++;
		} else {
			inserts.push(rowValues);
			inserted++;
		}
	}

	if (dataUpdates.length) {
		await sheetsAPI.spreadsheets.values.batchUpdate({
			auth, spreadsheetId,
			requestBody: {
				valueInputOption: 'USER_ENTERED',
				data: dataUpdates
			}
		});
	}
	if (inserts.length) {
		await sheetsAPI.spreadsheets.values.append({
			auth, spreadsheetId, range: `${sheetName}!A1`,
			valueInputOption: 'USER_ENTERED',
			insertDataOption: 'INSERT_ROWS',
			requestBody: { values: inserts }
		});
	}
	return { updated, inserted, total: updated + inserted };
}


/* ============== Bulk Add Models (dev/prod) ============== */
function normalizeModelItem(data) {
	return {
		Manufacturer: data.Manufacturer ?? '',
		Model: data.Model ?? '',
		Year: data.Year ?? '',
		Category: data.Category ?? '',
		Key: (data.Key && String(data.Key).trim()) || slugify(data.Manufacturer, data.Model, data.Year, data.Category),
		Status: data.Status ?? 'Pending',
		CreatedAt: data.CreatedAt ?? new Date().toISOString(),
	};
}

async function bulkProcess(items, env = 'dev') {
	if (!Array.isArray(items) || !items.length) return { groups: [], total: 0 };
	// group by Category (to pick target from Registry), preserve only valid categories
	const rows = await readRegistry();
	const byCat = new Map();
	for (const raw of items) {
		const cat = String(raw.Category || '').trim();
		const rec = rows.find(r => r.category === cat);
		if (!rec) continue;
		const t = { spreadsheetId: rec.target_spreadsheet_id_models, sheetName: rec.models_sheet || 'Models' };
		const key = `${t.spreadsheetId}::${t.sheetName}`;
		if (!byCat.has(key)) byCat.set(key, { category: cat, target: t, list: [] });
		byCat.get(key).list.push(normalizeModelItem(raw));
	}

	const header = ['Manufacturer','Model','Year','Category','Key','Status','CreatedAt'];
	const groups = [];
	for (const { category, target, list } of byCat.values()) {
		await ensureModelsSheetAndHeader({ ...target, header });
		const upsert = await upsertManyByKey({ ...target, header, items: list, keyField: 'Key' });
		const n8n = await triggerN8N(env, target).catch(e => ({ ok:false, error:String(e) }));
		console.log(`[n8n] env=${env} ->`, (getN8NConfig(env).url || 'none'));
		groups.push({ category, target, upsert, n8n });
	}
	const total = groups.reduce((s,g)=> s + (g.upsert?.total || 0), 0);
	return { groups, total };
}

app.post('/api/bulkAddModels', async (req, res) => {
	try {
		const { items = [] } = req.body || {};
		const result = await bulkProcess(items, 'dev');
		res.json({ ok: true, env:'dev', ...result });
	} catch (e) {
		res.status(500).json({ ok:false, error: String(e) });
	}
});

app.post('/api/bulkAddModelsProd', async (req, res) => {
	try {
		const { items = [] } = req.body || {};
		const result = await bulkProcess(items, 'prod');
		res.json({ ok: true, env:'prod', ...result });
	} catch (e) {
		res.status(500).json({ ok:false, error: String(e) });
	}
});

app.listen(PORT, () => {
	console.log(`Authless Sheets Proxy on http://localhost:${PORT}`)
})
