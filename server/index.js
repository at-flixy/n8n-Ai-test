import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'fs'
import { google } from 'googleapis'

dotenv.config()

const {
	PORT = 5500,
	CORS_ORIGIN = '',
	REGISTRY_SPREADSHEET_ID,
	REGISTRY_SHEET = 'Registry',
	SERVICE_ACCOUNT_FILE = './service-account.json',
	GCP_SA_JSON,
	API_KEY = '',
	N8N_URL,
} = process.env

if (!REGISTRY_SPREADSHEET_ID) {
	throw new Error('REGISTRY_SPREADSHEET_ID is not set')
}

const corsOrigins = CORS_ORIGIN.split(',').filter(Boolean)
const app = express()

// принимаем простые JSON-строки (например, "Test")
app.use(express.json({ strict: false }))
app.use(
	cors({
		origin: (origin, callback) => {
			if (!origin || corsOrigins.includes(origin)) return callback(null, true)
			return callback(new Error('Not allowed by CORS'))
		},
		credentials: true,
	})
)

const scopes = ['https://www.googleapis.com/auth/spreadsheets']
const sheetsAPI = google.sheets({ version: 'v4' })

async function getAuthClient() {
	let credentials
	if (GCP_SA_JSON) {
		credentials = JSON.parse(
			Buffer.from(GCP_SA_JSON, 'base64').toString('utf8')
		)
	} else {
		credentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'))
	}
	const jwt = new google.auth.JWT(
		credentials.client_email,
		null,
		credentials.private_key,
		scopes
	)
	await jwt.authorize()
	return jwt
}

// чтение Registry
async function readRegistry() {
	const auth = await getAuthClient()
	const response = await sheetsAPI.spreadsheets.values.get({
		auth,
		spreadsheetId: REGISTRY_SPREADSHEET_ID,
		range: `${REGISTRY_SHEET}!A:Z`,
	})
	const rows = response.data.values || []
	if (!rows.length) return []
	const [header, ...data] = rows
	return data.map(row => {
		const obj = {}
		header.forEach((k, i) => {
			obj[k] = row[i]
		})
		return obj
	})
}

// преобразование schema->шапка
function schemaToHeaders(schema) {
	if (!schema || typeof schema !== 'object') {
		return ['Key', 'Manufacturer', 'Model', 'Year', 'Category']
	}
	const props = schema.properties || {}
	const required = schema.required || []
	const keys = [...new Set([...required, ...Object.keys(props)])]
	return [
		'Key',
		'Manufacturer',
		'Model',
		'Year',
		'Category',
		...keys,
		'sources',
		'confidence',
		'parse_error',
		'created_at',
		'updated_at',
	]
}

// создать или обновить лист и проставить шапку
async function provisionSheet({ spreadsheetId, sheetName, header }) {
	const auth = await getAuthClient()
	const meta = await sheetsAPI.spreadsheets.get({ auth, spreadsheetId })
	const exists = meta.data.sheets.some(sh => sh.properties.title === sheetName)
	if (!exists) {
		await sheetsAPI.spreadsheets.batchUpdate({
			auth,
			spreadsheetId,
			requestBody: {
				requests: [{ addSheet: { properties: { title: sheetName } } }],
			},
		})
	}
	await sheetsAPI.spreadsheets.values.update({
		auth,
		spreadsheetId,
		range: `${sheetName}!A1`,
		valueInputOption: 'RAW',
		requestBody: { values: [header] },
	})
	return { created: !exists, updated: true }
}

// добавление строки с метаданными (Pending)
async function appendRow({ spreadsheetId, sheetName, row }) {
	const auth = await getAuthClient()
	const now = new Date().toISOString()
	await sheetsAPI.spreadsheets.values.append({
		auth,
		spreadsheetId,
		range: `${sheetName}!A1`,
		valueInputOption: 'RAW',
		insertDataOption: 'INSERT_ROWS',
		requestBody: { values: [[...row, '', '', '', now, now]] },
	})
}

//N8N
function getN8NConfig(env = 'dev') {
	const url =
		env === 'prod'
			? process.env.N8N_PROD_WEBHOOK_URL
			: process.env.N8N_DEV_WEBHOOK_URL
	const headerName =
		env === 'prod'
			? process.env.N8N_PROD_WEBHOOK_HEADER_NAME
			: process.env.N8N_DEV_WEBHOOK_HEADER_NAME
	const token =
		env === 'prod'
			? process.env.N8N_PROD_WEBHOOK_TOKEN
			: process.env.N8N_DEV_WEBHOOK_TOKEN
	return { url, headerName: headerName || 'X-Webhook-Token', token }
}

async function triggerN8N(env, target) {
	const { url, headerName, token } = getN8NConfig(env)
	if (!url) return { skipped: true, reason: 'no_url' }

	const headers = { 'Content-Type': 'application/json' }
	if (headerName && token) headers[headerName] = token // Header Auth в n8n :contentReference[oaicite:1]{index=1}

	const body = {
		spreadsheet_id: target.spreadsheetId,
		sheet_name: target.sheetName,
	}

	const res = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		// удобный таймаут Web API (Node 18+) — оборвёт, если n8n не ответит вовремя
		signal: AbortSignal.timeout(8000),
	})
	const text = await res.text().catch(() => '')
	return { ok: res.ok, status: res.status, body: text.slice(0, 200) }
}

// helper: делаем slug для Key
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

// helper: аппенд по шапке листа
async function appendByHeader({ spreadsheetId, sheetName, obj }) {
	const auth = await getAuthClient()
	const hdrRes = await sheetsAPI.spreadsheets.values.get({
		auth,
		spreadsheetId,
		range: `${sheetName}!1:1`,
	})
	const header = (hdrRes.data.values && hdrRes.data.values[0]) || []
	const row = header.map(h =>
		Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : ''
	)
	await sheetsAPI.spreadsheets.values.append({
		auth,
		spreadsheetId,
		range: `${sheetName}!A1`,
		valueInputOption: 'USER_ENTERED',
		insertDataOption: 'INSERT_ROWS',
		requestBody: { values: [row] },
	})
}

// ensure: spreadsheet доступен, лист существует, шапка выставлена
async function ensureModelsSheetAndHeader({
	spreadsheetId,
	sheetName,
	header,
}) {
	const auth = await getAuthClient()

	// 1) доступ к книге и наличие листа
	let meta
	try {
		meta = await sheetsAPI.spreadsheets.get({ auth, spreadsheetId })
	} catch (e) {
		const msg = String((e && e.message) || e)
		// это и есть тот случай "Requested entity was not found." когда нет доступа или id неверный
		throw new Error(`Cannot open spreadsheet ${spreadsheetId}. ${msg}`)
	}

	const exists = (meta.data.sheets || []).some(
		sh => sh.properties.title === sheetName
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

	// 2) читаем шапку
	let currentHeader = []
	try {
		const r = await sheetsAPI.spreadsheets.values.get({
			auth,
			spreadsheetId,
			range: `${sheetName}!1:1`,
		})
		currentHeader = (r.data.values && r.data.values[0]) || []
	} catch (e) {
		// если только что создали лист — запроса могло не быть, просто поставим шапку
		currentHeader = []
	}

	// 3) если шапки нет — записываем дефолтную
	const needHeader = !currentHeader || currentHeader.length === 0
	if (needHeader) {
		await sheetsAPI.spreadsheets.values.update({
			auth,
			spreadsheetId,
			range: `${sheetName}!A1`,
			valueInputOption: 'RAW',
			requestBody: { values: [header] },
		})
	}

	return true
}

// Middleware для API‑ключа
app.use((req, res, next) => {
	if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
		return res.status(401).json({ ok: false, error: 'API key required' })
	}
	next()
})

// healthcheck
app.get('/api/health', (_req, res) => {
	res.json({
		ok: true,
		service: 'registry-tools-proxy-authless',
		time: new Date().toISOString(),
	})
})

// список категорий
app.get('/api/registry/categories', async (_req, res) => {
	try {
		const rows = await readRegistry()
		const cats = rows.map(r => r.category).filter(Boolean)
		res.json({ ok: true, categories: [...new Set(cats)] })
	} catch (err) {
		res.status(500).json({ ok: false, error: String(err) })
	}
})

// валидация категории
app.post('/api/ValidateRegistryRow', async (req, res) => {
	try {
		const category = typeof req.body === 'string' ? req.body : req.body.category
		const rows = await readRegistry()
		const rec = rows.find(r => r.category === category)
		if (!rec)
			return res
				.status(404)
				.json({ ok: false, error: `Category ${category} not found` })
		let schema = null
		try {
			schema = rec.json_schema ? JSON.parse(rec.json_schema) : null
		} catch {}
		const header = schemaToHeaders(schema)
		res.json({
			ok: true,
			registry_row: rec,
			modelsTarget: {
				spreadsheetId: rec.target_spreadsheet_id_models,
				sheetName: rec.models_sheet,
			},
			catTarget: {
				spreadsheetId: rec.target_spreadsheet_id_category,
				sheetName: rec.category_sheet || category,
			},
			reviewTarget: {
				spreadsheetId: rec.target_spreadsheet_id_review,
				sheetName: rec.review_sheet,
			},
			header,
		})
	} catch (err) {
		res.status(500).json({ ok: false, error: String(err) })
	}
})

// Provision Category
app.post('/api/ProvisionOneByCategory', async (req, res) => {
	try {
		const category = typeof req.body === 'string' ? req.body : req.body.category
		const rows = await readRegistry()
		const rec = rows.find(r => r.category === category)
		if (!rec)
			return res
				.status(404)
				.json({ ok: false, error: `Category ${category} not found` })
		let schema = null
		try {
			schema = rec.json_schema ? JSON.parse(rec.json_schema) : null
		} catch {}
		const header = schemaToHeaders(schema)
		const target = {
			spreadsheetId: rec.target_spreadsheet_id_category,
			sheetName: rec.category_sheet || category,
		}
		const result = await provisionSheet({ ...target, header })
		res.json({ ok: true, ...result, target, header })
	} catch (err) {
		res.status(500).json({ ok: false, error: String(err) })
	}
})

// Provision all categories
app.post('/api/ProvisionAllFromRegistry', async (_req, res) => {
	try {
		const rows = await readRegistry()
		const results = []
		for (const rec of rows) {
			let schema = null
			try {
				schema = rec.json_schema ? JSON.parse(rec.json_schema) : null
			} catch {}
			const header = schemaToHeaders(schema)
			const target = {
				spreadsheetId: rec.target_spreadsheet_id_category,
				sheetName: rec.category_sheet || rec.category,
			}
			const r = await provisionSheet({ ...target, header })
			results.push({ ok: true, ...r, target, header })
		}
		res.json({ ok: true, results })
	} catch (err) {
		res.status(500).json({ ok: false, error: String(err) })
	}
})

// Добавить одну модель в Models
// Добавить одну модель в Models (строго по колонкам листа)
// Добавить одну модель в Models (строго по колонкам листа)
app.post('/api/addModel', async (req, res) => {
	try {
		const data = req.body
		const rows = await readRegistry()
		const rec = rows.find(r => r.category === data.Category)
		if (!rec) {
			return res
				.status(404)
				.json({ ok: false, error: `Category ${data.Category} not found` })
		}

		const target = {
			spreadsheetId: rec.target_spreadsheet_id_models,
			sheetName: rec.models_sheet || 'Models',
		}
		// Дефолтная шапка для листа Models
		const header = [
			'Manufacturer',
			'Model',
			'Year',
			'Category',
			'Key',
			'Status',
			'CreatedAt',
		]

		// гарантируем доступ/наличие листа/шапки; если доступа нет — получим осмысленную ошибку
		await ensureModelsSheetAndHeader({ ...target, header })

		const obj = {
			Manufacturer: data.Manufacturer ?? '',
			Model: data.Model ?? '',
			Year: data.Year ?? '',
			Category: data.Category ?? '',
			Key:
				(data.Key && data.Key.trim()) ||
				slugify(data.Manufacturer, data.Model, data.Year, data.Category),
			Status: data.Status ?? 'Pending',
			CreatedAt: data.CreatedAt ?? new Date().toISOString(),
		}

		await appendByHeader({ ...target, obj })
		res.json({ ok: true, target })
	} catch (err) {
		// Разворачиваем ошибку Google более дружелюбно
		const msg = String((err && err.message) || err)
		// Дадим ясный хинт про доступ сервис-аккаунта
		if (/Requested entity was not found|Cannot open spreadsheet/i.test(msg)) {
			return res.status(500).json({
				ok: false,
				error: `Requested entity was not found. Проверьте:
- корректность spreadsheetId для Models в Registry,
- что лист с именем из Registry существует (или будет создан),
- и что книга расшарена на e-mail сервисного аккаунта (Editor).`,
			})
		}
		res.status(500).json({ ok: false, error: msg })
	}
})

// Добавить множество моделей в Models

// Bulk add (TEST): accepts { items: [...] } or direct array
app.post('/api/bulkAddModels', async (req, res) => {
  try {
    const rows = await readRegistry()
    const items = Array.isArray(req.body?.items) ? req.body.items : (Array.isArray(req.body) ? req.body : [])
    if (!items.length) return res.json({ ok: true, total: 0, perTarget: [], missingCategories: [] })

    // Build category -> target map
    const map = new Map()
    for (const r of rows) {
      if (r.category && r.target_spreadsheet_id_models) {
        map.set(r.category, { spreadsheetId: r.target_spreadsheet_id_models, sheetName: r.models_sheet || 'Models' })
      }
    }

    const missing = new Set()
    // Group by target
    const groups = new Map()
    for (const item of items) {
      const cat = String(item.Category || '').trim()
      const tgt = map.get(cat)
      if (!tgt) { missing.add(cat); continue }
      const key = `${tgt.spreadsheetId}||${tgt.sheetName}`
      if (!groups.has(key)) groups.set(key, { target: tgt, items: [] })
      groups.get(key).items.push(item)
    }

    // Process each group
    const header = ['Manufacturer','Model','Year','Category','Key','Status','CreatedAt']
    const perTarget = []
    for (const { target } of groups.values()) {
      await ensureModelsSheetAndHeader({ ...target, header })
    }
    for (const [key, group] of groups.entries()) {
      const { target, items: gi } = group
      let inserted = 0, updated = 0, errors = []
      for (const it of gi) {
        const obj = {
          Manufacturer: it.Manufacturer ?? '',
          Model:        it.Model ?? '',
          Year:         it.Year ?? '',
          Category:     it.Category ?? '',
          Key:          (it.Key && String(it.Key).trim()) || 
                        (String(it.Manufacturer||'')||String(it.Model||'')||String(it.Year||'')||String(it.Category||'')) 
                          ? [it.Manufacturer,it.Model,it.Year,it.Category].map(s=>String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_')).filter(Boolean).join('_').replace(/^_+|_+$/g,'') : '',
          Status:       it.Status ?? 'Pending',
          CreatedAt:    it.CreatedAt ?? new Date().toISOString(),
        }
        try {
          const up = await upsertByKey({ ...target, header, obj, keyField: 'Key' })
          if (up.upsert === 'insert') inserted++; else updated++;
        } catch (e) {
          errors.push(String(e && e.message || e))
        }
      }
      // trigger n8n for this target (dev)
      let n8n = {}
      try { n8n = await triggerN8N('dev', target) } catch(e){ n8n = { ok:false, error:String(e) } }
      perTarget.push({ target, counts: { inserted, updated }, n8n, errors })
    }

    res.json({ ok: true, env: 'dev', total: items.length, missingCategories: Array.from(missing).filter(Boolean), perTarget })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// Bulk add (PROD)
app.post('/api/bulkAddModelsProd', async (req, res) => {
  try {
    const rows = await readRegistry()
    const items = Array.isArray(req.body?.items) ? req.body.items : (Array.isArray(req.body) ? req.body : [])
    if (!items.length) return res.json({ ok: true, total: 0, perTarget: [], missingCategories: [] })

    const map = new Map()
    for (const r of rows) {
      if (r.category && r.target_spreadsheet_id_models) {
        map.set(r.category, { spreadsheetId: r.target_spreadsheet_id_models, sheetName: r.models_sheet || 'Models' })
      }
    }

    const missing = new Set()
    const groups = new Map()
    for (const item of items) {
      const cat = String(item.Category || '').trim()
      const tgt = map.get(cat)
      if (!tgt) { missing.add(cat); continue }
      const key = `${tgt.spreadsheetId}||${tgt.sheetName}`
      if (!groups.has(key)) groups.set(key, { target: tgt, items: [] })
      groups.get(key).items.push(item)
    }

    const header = ['Manufacturer','Model','Year','Category','Key','Status','CreatedAt']
    const perTarget = []
    for (const { target } of groups.values()) {
      await ensureModelsSheetAndHeader({ ...target, header })
    }
    for (const [key, group] of groups.entries()) {
      const { target, items: gi } = group
      let inserted = 0, updated = 0, errors = []
      for (const it of gi) {
        const obj = {
          Manufacturer: it.Manufacturer ?? '',
          Model:        it.Model ?? '',
          Year:         it.Year ?? '',
          Category:     it.Category ?? '',
          Key:          (it.Key && String(it.Key).trim()) || 
                        (String(it.Manufacturer||'')||String(it.Model||'')||String(it.Year||'')||String(it.Category||'')) 
                          ? [it.Manufacturer,it.Model,it.Year,it.Category].map(s=>String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_')).filter(Boolean).join('_').replace(/^_+|_+$/g,'') : '',
          Status:       it.Status ?? 'Pending',
          CreatedAt:    it.CreatedAt ?? new Date().toISOString(),
        }
        try {
          const up = await upsertByKey({ ...target, header, obj, keyField: 'Key' })
          if (up.upsert === 'insert') inserted++; else updated++;
        } catch (e) {
          errors.push(String(e && e.message || e))
        }
      }
      let n8n = {}
      try { n8n = await triggerN8N('prod', target) } catch(e){ n8n = { ok:false, error:String(e) } }
      perTarget.push({ target, counts: { inserted, updated }, n8n, errors })
    }

    res.json({ ok: true, env: 'prod', total: items.length, missingCategories: Array.from(missing).filter(Boolean), perTarget })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})
app.post('/api/n8n-intake', async (req, res) => {
	try {
		if (!N8N_URL)
			return res
				.status(500)
				.json({ ok: false, error: 'N8N_URL not set in .env' })
		const fetch = (await import('node-fetch')).default
		const result = await fetch(N8N_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ payload: JSON.stringify(req.body) }),
		})
		const text = await result.text()
		res.status(result.status).send(text)
	} catch (err) {
		res.status(500).json({ ok: false, error: String(err) })
	}
})

app.listen(PORT, () => {
	console.log(`Authless Sheets Proxy on http://localhost:${PORT}`)
})
// Build row by header
function buildRowByHeader(header, obj) {
  return header.map(h => Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : '')
}

// A<->1 column helper
function colLetter(n) {
  let s = '', num = n
  while (num > 0) { const m = (num - 1) % 26; s = String.fromCharCode(65 + m) + s; num = Math.floor((num - 1) / 26) }
  return s
}

// UPSERT by Key field
async function upsertByKey({ spreadsheetId, sheetName, header, obj, keyField = 'Key' }) {
  const auth = await getAuthClient()

  // ensure header exists
  let hdrRes = await sheetsAPI.spreadsheets.values.get({
    auth, spreadsheetId, range: `${sheetName}!1:1`,
  })
  let hdr = (hdrRes.data.values && hdrRes.data.values[0]) || []
  if (!hdr.length) {
    await sheetsAPI.spreadsheets.values.update({
      auth, spreadsheetId, range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    })
    hdr = header.slice()
  }
  const keyIdx = hdr.indexOf(keyField)
  if (keyIdx === -1) throw new Error(`Header has no "${keyField}" column`)

  const lastCol = colLetter(hdr.length)
  const valuesRes = await sheetsAPI.spreadsheets.values.get({
    auth, spreadsheetId, range: `${sheetName}!A2:${lastCol}`,
  })
  const rows = valuesRes.data.values || []

  const keyValue = String(obj[keyField] ?? '').trim()
  let foundRowNumber = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || []
    const cell = row[keyIdx] || ''
    if (String(cell).trim() === keyValue && keyValue) {
      foundRowNumber = i + 2 // + header
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
      auth, spreadsheetId, range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowValues] },
    })
    return { upsert: 'insert' }
  }
}

