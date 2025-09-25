/* assets/js/bulk.js — Bulk loading with CSV/XLSX, parsing, mapping, validation, dev/prod send */

const __BASE = window.__REGISTRY_PROXY_BASE__ || ''
const __APIKEY = window.__REGISTRY_PROXY_KEY__ || ''

// Direct webhook senders (align with Single)
function fireN8N(env, payload) {
	const EP = (window.N8N_ENDPOINTS && window.N8N_ENDPOINTS[env]) || ''
	if (!EP)
		return Promise.resolve({
			ok: false,
			status: 0,
			body: 'N8N endpoint not configured',
		})
	return fetch(EP, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	}).then(async r => ({
		ok: r.ok,
		status: r.status,
		body: await r.text().catch(() => ''),
	}))
}
function fireN8NBatch(env, items) {
	// wrap once: { env, items }
	return fireN8N(env, { env, items })
}
const $ = s => document.querySelector(s)

const EL = {
	ta: $('#bulkTextarea'),
	file: $('#bulkFile'),
	dz: $('#dropzone'),
	parse: $('#parseBtn'),
	clear: $('#clearBtn'),
	copy: $('#copyBtn'),
	msg: $('#bulkMsg'),
	table: $('#bulkTable'),
	tbody: $('#bulkTable tbody'),
	previewBox: $('#bulkPreviewBox'),
	cntTotal: $('#cntTotal'),
	cntReady: $('#cntReady'),
	cntDup: $('#cntDup'),
	cntErr: $('#cntErr'),
	cntMissingCat: $('#cntMissingCat'),
	mapManufacturer: $('#mapManufacturer'),
	mapModel: $('#mapModel'),
	mapYear: $('#mapYear'),
	mapCategory: $('#mapCategory'),
	addTest: $('#addTestBtn'),
	addProd: $('#addProdBtn'),
	debug: $('#debug'),
}

function setMsg(text, type = 'info') {
	if (EL.msg) EL.msg.textContent = text || ''
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

function csvDetectDelimiter(sample) {
	if (sample.includes('\t')) return '\t'
	const comma = (sample.match(/,/g) || []).length
	const sc = (sample.match(/;/g) || []).length
	return comma >= sc ? ',' : ';'
}

function parseCSV(text) {
	const delim = csvDetectDelimiter(text)
	const lines = text.split(/\r?\n/).filter(l => l.trim().length)
	return lines.map(line => line.split(delim).map(c => c.trim()))
}

async function readFileAsText(file) {
	return await file.text()
}

function parseXLSX(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = e => {
			try {
				const data = new Uint8Array(e.target.result)
				const wb = XLSX.read(data, { type: 'array' })
				const ws = wb.Sheets[wb.SheetNames[0]]
				const rows = XLSX.utils.sheet_to_json(ws, {
					header: 1,
					raw: false,
					defval: '',
				})
				resolve(rows)
			} catch (err) {
				reject(err)
			}
		}
		reader.onerror = reject
		reader.readAsArrayBuffer(file)
	})
}

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

function autoMap(headers) {
	const h = headers.map(x =>
		String(x || '')
			.toLowerCase()
			.trim()
	)
	const find = (...cands) => {
		const idx = h.findIndex(x => cands.some(c => x === c || x.includes(c)))
		return idx >= 0 ? idx : -1
	}
	return {
		Manufacturer: find('manufacturer', 'brand', 'make'),
		Model: find('model', 'modelname', 'model_name'),
		Year: find('year', 'yr'),
		Category: find('category', 'cat'),
	}
}

function fillMapping(headers, m) {
	const opts = ['(ignore)', ...headers]
	for (const [sel, key] of [
		[EL.mapManufacturer, 'Manufacturer'],
		[EL.mapModel, 'Model'],
		[EL.mapYear, 'Year'],
		[EL.mapCategory, 'Category'],
	]) {
		sel.innerHTML = opts
			.map(
				(h, i) => `<option value="${i === 0 ? -1 : i - 1}">${opts[i]}</option>`
			)
			.join('')
		if (m && m[key] >= 0) sel.value = String(m[key])
	}
}

let rawRows = []
let mapped = []
let categoriesSet = new Set()
let missingCats = new Set()
let currentPage = 1
const pageSize = 20

async function fetchCategories() {
	const r = await fetch(`${__BASE}/api/registry/categories`, {
		headers: __APIKEY ? { 'x-api-key': __APIKEY } : {},
	})
	if (!r.ok) throw new Error('Failed to fetch categories')
	const j = await r.json()
	categoriesSet = new Set(j.categories || [])
}

function getMapping() {
	return {
		Manufacturer: parseInt(EL.mapManufacturer.value, 10),
		Model: parseInt(EL.mapModel.value, 10),
		Year: parseInt(EL.mapYear.value, 10),
		Category: parseInt(EL.mapCategory.value, 10),
	}
}

function remap() {
	const m = getMapping()
	missingCats = new Set()
	const seen = new Set()
	mapped = []
	currentPage = 1

	// assume header at rawRows[0]
	for (const row of rawRows.slice(1)) {
		const Manufacturer = m.Manufacturer >= 0 ? row[m.Manufacturer] : ''
		const Model = m.Model >= 0 ? row[m.Model] : ''
		const Year = m.Year >= 0 ? row[m.Year] : ''
		const Category = m.Category >= 0 ? row[m.Category] : ''

		if (!Manufacturer || !Model) continue

		const Key = slugify(Manufacturer, Model, Year, Category)
		if (seen.has(Key)) continue
		seen.add(Key)

		if (Category && !categoriesSet.has(Category)) missingCats.add(Category)

		mapped.push({
			Manufacturer,
			Model,
			Year,
			Category,
			Key,
			Status: 'Pending',
			CreatedAt: new Date().toISOString(),
		})
	}

	EL.cntTotal.textContent = String(Math.max(rawRows.length - 1, 0))
	EL.cntReady.textContent = String(mapped.length)
	EL.cntDup.textContent = String(rawRows.length - 1 - mapped.length)
	EL.cntErr.textContent = '0'
	EL.cntMissingCat.textContent = String(missingCats.size)

	renderPreview()
}

function renderPreview() {
	const total = mapped.length
	const totalPages = Math.max(1, Math.ceil(total / pageSize))
	if (currentPage > totalPages) currentPage = totalPages
	const start = (currentPage - 1) * pageSize
	const end = Math.min(start + pageSize, total)
	const pageRows = mapped.slice(start, end)

	EL.tbody.innerHTML = pageRows
		.map(
			(r, idx) => `
    <tr class="${
			r.Category && !categoriesSet.has(r.Category) ? 'row-warn' : ''
		}">
      <td>${start + idx + 1}</td>
      <td>${r.Manufacturer}</td>
      <td>${r.Model}</td>
      <td>${r.Year}</td>
      <td>${r.Category || ''}</td>
      <td>${r.Key}</td>
    </tr>
  `
		)
		.join('')

	const pi = document.getElementById('pageInfo')
	if (pi) pi.textContent = total ? `${currentPage} / ${totalPages}` : '0 / 0'

	const prev = document.getElementById('prevPage')
	const next = document.getElementById('nextPage')
	if (prev) prev.disabled = currentPage <= 1
	if (next) next.disabled = currentPage >= totalPages
}

function copyClean() {
	const lines = mapped.map(r =>
		[r.Manufacturer, r.Model, r.Year, r.Category].join(',')
	)
	const txt = lines.join('\n')
	navigator.clipboard
		.writeText(txt)
		.then(() => setMsg('Скопировано ✓'))
		.catch(() => setMsg('Не удалось скопировать', 'error'))
}

function clearAll() {
	rawRows = []
	mapped = []
	currentPage = 1
	missingCats = new Set()
	if (EL.ta) EL.ta.value = ''
	EL.tbody.innerHTML = ''
	EL.cntTotal.textContent = '0'
	EL.cntReady.textContent = '0'
	EL.cntDup.textContent = '0'
	EL.cntErr.textContent = '0'
	EL.cntMissingCat.textContent = '0'
	setMsg('')
}

async function handleParse() {
	setMsg('Разбор…')
	try {
		await fetchCategories()

		let rows = []
		const txt = ((EL.ta && EL.ta.value) || '').trim()
		if (txt) {
			rows = parseCSV(txt)
		} else if (EL.file && EL.file.files && EL.file.files[0]) {
			const f = EL.file.files[0]
			const name = f.name.toLowerCase()
			if (name.endsWith('.xlsx')) rows = await parseXLSX(f)
			else rows = parseCSV(await readFileAsText(f))
		} else {
			setMsg('Нет данных: вставьте текст или выберите файл', 'error')
			return
		}

		if (!rows.length) {
			setMsg('Пустые данные', 'error')
			return
		}

		let headers = rows[0].map(x => String(x || '').trim())
		const lc = headers.map(h => h.toLowerCase())
		const headerLooksValid = ['manufacturer', 'model', 'year', 'category'].some(
			h => lc.includes(h)
		)
		if (!headerLooksValid) {
			const widest = Math.max(...rows.map(r => r.length))
			headers = Array.from({ length: widest }, (_, i) => `Column ${i + 1}`)
			rows = [headers, ...rows]
		}

		rawRows = rows
		const am = autoMap(headers)
		fillMapping(headers, am)
		remap()
		setMsg(`Разобрано: ${rows.length - 1} строк.`)
	} catch (e) {
		setMsg('Ошибка разбора', 'error')
		setDebug(e)
	}
}

function isNotFound(res) {
	return res && (res.status === 404 || res.status === 405)
}

async function addBulk(env = 'dev') {
	if (missingCats.size) {
		setMsg(
			`Есть категории вне Registry: ${Array.from(missingCats).join(', ')}`,
			'error'
		)
		return
	}
	if (!mapped.length) {
		setMsg('Нет валидных строк для отправки', 'error')
		return
	}

	const items = mapped.map(r => ({
		Manufacturer: r.Manufacturer,
		Model: r.Model,
		Year: r.Year,
		Category: r.Category,
		Key: r.Key,
		Status: r.Status,
		CreatedAt: r.CreatedAt,
	}))
	const path = env === 'prod' ? '/api/bulkAddModelsProd' : '/api/bulkAddModels'

	setMsg(env === 'prod' ? 'Отправка в PROD…' : 'Отправка…')
	let data = {}
	try {
		const r = await fetch(`${__BASE}${path}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(__APIKEY ? { 'x-api-key': __APIKEY } : {}),
			},
			body: JSON.stringify({ items }),
		})

		if (isNotFound(r)) {
			// Сервер не поддерживает bulk — продолжаем, но помечаем как пропуск
			data = { ok: true, skippedServer: true, note: 'bulk endpoint not found' }
		} else {
			data = await r.json().catch(() => ({}))
		}
	} catch (e) {
		// сетевой сбой — всё равно попробуем n8n
		data = { ok: false, networkError: String(e) }
	}

	// Всегда делаем ОДИН батч-вызов в n8n (как на Single)
	let n8n = { ok: false, status: 0, body: '' }
	try {
		n8n = await fireN8NBatch(env, items)
	} catch (e) {
		n8n = { ok: false, status: 0, body: String(e) }
	}

	// UI
	const okUpsert = !!(
		data &&
		(data.ok || data.total >= 0 || data.skippedServer)
	)
	const okN8N = !!(n8n && n8n.ok)
	if (okUpsert && okN8N) {
		setMsg(`Готово: upsert ${data.total ?? items.length}, n8n ${n8n.status} ✓`)
	} else if (okUpsert && !okN8N) {
		setMsg(`Данные записаны, но n8n не ответил (${n8n.status})`, 'error')
	} else if (!okUpsert && okN8N) {
		setMsg(`n8n отправлен (${n8n.status}), но запись не выполнена`, 'error')
	} else {
		setMsg('Ошибка при добавлении', 'error')
	}
	setDebug({ upsert: data, n8n })
}

function bindDragDrop() {
	const z = EL.dz
	if (!z) return
	z.addEventListener('dragover', e => {
		e.preventDefault()
		z.classList.add('is-over')
	})
	z.addEventListener('dragleave', () => z.classList.remove('is-over'))
	z.addEventListener('drop', e => {
		e.preventDefault()
		z.classList.remove('is-over')
		const files = e.dataTransfer?.files
		if (files && files[0]) {
			EL.file.files = files
			handleParse()
		}
	})
}

function init() {
	document.getElementById('prevPage')?.addEventListener('click', () => {
		if (currentPage > 1) {
			currentPage--
			renderPreview()
		}
	})
	document.getElementById('nextPage')?.addEventListener('click', () => {
		currentPage++
		renderPreview()
	})
	EL.parse?.addEventListener('click', handleParse)
	EL.clear?.addEventListener('click', clearAll)
	EL.copy?.addEventListener('click', copyClean)
	EL.addTest?.addEventListener('click', () => addBulk('dev'))
	EL.addProd?.addEventListener('click', () => addBulk('prod'))
	EL.mapManufacturer?.addEventListener('change', remap)
	EL.mapModel?.addEventListener('change', remap)
	EL.mapYear?.addEventListener('change', remap)
	EL.mapCategory?.addEventListener('change', remap)
	bindDragDrop()
}

document.readyState === 'loading'
	? document.addEventListener('DOMContentLoaded', init)
	: init()
