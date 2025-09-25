/* assets/js/app.js
   Single page: статусы, загрузка категорий, Add (TEST) / Add Prod,
   идемпотентные бинды и формирование нужных полей (Key/Status/CreatedAt) */

const __BASE = window.__REGISTRY_PROXY_BASE__ || ''
const __APIKEY = window.__REGISTRY_PROXY_KEY__ || ''

const $ = s => document.querySelector(s)
const EL = {
	mfr: $('#manufacturer'),
	mdl: $('#model'),
	year: $('#year'),
	cat: $('#categorySelect'),
	addBtn: $('#addBtn'),
	addProdBtn: $('#addProdBtn'),
	status: $('#status') || $('#msg'),
	debug: $('#debug'),
}

function now() {
	const d = new Date()
	return d.toLocaleTimeString()
}
function setStatus(msg, type = 'info') {
	if (EL.status)
		EL.status.innerHTML = `<span class="badge msg">${now()}</span> ${msg}`
	console[type === 'error' ? 'error' : 'log'](`[${type}] ${msg}`)
}
function setDebug(obj) {
	if (!EL.debug) return
	try {
		EL.debug.textContent =
			typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
	} catch (e) {
		EL.debug.textContent = String(obj)
	}
}

function makeKey(mfr, model, year, cat) {
	return [mfr, model, year, cat]
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

async function apiGET(path) {
	const headers = __APIKEY ? { 'x-api-key': __APIKEY } : {}
	const r = await fetch(`${__BASE}${path}`, { headers })
	if (!r.ok) {
		const t = await r.text().catch(() => r.statusText)
		throw new Error(`HTTP ${r.status}: ${t}`)
	}
	return r.json()
}

// Универсальный вызов server.method через google.script.run (прокси в api-gis.js)
function fireN8N(env, payload) {
  const EP = (window.N8N_ENDPOINTS && window.N8N_ENDPOINTS[env]) || '';
  if (!EP) return Promise.resolve({ ok:false, status:0, body:'N8N endpoint not configured' });
  return fetch(EP, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(async r => ({ ok:r.ok, status:r.status, body: await r.text().catch(()=> '') }));
}

function runGoogle(method, payload) {
	return new Promise((resolve, reject) => {
		try {
			google.script.run
				.withSuccessHandler(resolve)
				.withFailureHandler(reject)
				[method](payload)
		} catch (e) {
			reject(e)
		}
	})
}

async function loadCategoriesIfNeeded() {
	if (!EL.cat || EL.cat.tagName !== 'SELECT') return
	setStatus('Loading categories…')
	try {
		const data = await apiGET('/api/registry/categories')
		const cats = Array.isArray(data?.categories) ? data.categories : []
		if (!cats.length) throw new Error('No categories in Registry')
		EL.cat.innerHTML = cats
			.map(c => `<option value="${c}">${c}</option>`)
			.join('')
		setStatus(`Loaded ${cats.length} categories ✓`)
	} catch (e) {
		setStatus('Failed to load categories', 'error')
		setDebug(e)
		EL.cat.innerHTML = '<option disabled selected>Failed to load</option>'
	}
}

async function addSingle(env = 'dev') {
  const EP = (window.N8N_ENDPOINTS && window.N8N_ENDPOINTS[env]) || ''
  console.log(`[n8n] env=${env} → ${EP}`)
	const Manufacturer = String(EL.mfr?.value || '').trim()
	const Model = String(EL.mdl?.value || '').trim()
	const Year = String(EL.year?.value || '').trim()
	const Category = String(EL.cat?.value || '').trim() || 'Tractors'

	if (!Manufacturer || !Model) {
		setStatus('Fill Manufacturer and Model', 'error')
		setDebug({ Manufacturer, Model, Year, Category })
		return
	}

	const payload = {
		env,
		Manufacturer,
		Model,
		Year,
		Category,
		Key: makeKey(Manufacturer, Model, Year, Category),
		Status: 'Pending',
		CreatedAt: new Date().toISOString(),
	}

	const method = env === 'prod' ? 'addModelProd' : 'addModel'
	setStatus(env === 'prod' ? 'Adding to PROD…' : 'Adding…')

	if (EL.addBtn) EL.addBtn.disabled = true
	try {
		const res = await runGoogle(method, payload);
		const n8n = await fireN8N(env, payload);
		res.n8n = n8n
		setStatus(
			(res.ok ? 'Model added ✓' : 'Add finished') +
				(res.n8n?.ok ? ' + n8n ✓' : ' + n8n…')
		)
		setDebug(res)
		// опционально чистим поля после успеха
		if (res.ok && env === 'dev') {
			if (EL.mfr) EL.mfr.value = ''
			if (EL.mdl) EL.mdl.value = ''
			if (EL.year) EL.year.value = ''
		}
	} catch (err) {
		setStatus('Add failed', 'error')
		setDebug(err)
	} finally {
		if (EL.addBtn) EL.addBtn.disabled = false
	}
}

/* ===== Идемпотентная привязка кнопок (чтобы слушатели не дублировались) ===== */
;(function bindSingleButtonsOnce() {
	if (window.__ADD_SINGLE_BOUND__) return
	window.__ADD_SINGLE_BOUND__ = true

	if (EL.addBtn) EL.addBtn.addEventListener('click', () => addSingle('dev'))
	if (EL.addProdBtn)
		EL.addProdBtn.addEventListener('click', () => addSingle('prod'))
})()

/* ===== Init ===== */
function init() {
	setStatus('Ready')
	loadCategoriesIfNeeded()
}
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init)
} else {
	init()
}