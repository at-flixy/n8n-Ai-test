/* assets/js/registry.js — UI для Registry & Provision */
const __R_BASE = window.__REGISTRY_PROXY_BASE__ || ''
const __R_APIKEY = window.__REGISTRY_PROXY_KEY__ || ''

const $ = s => document.querySelector(s)
const $$ = s => Array.from(document.querySelectorAll(s))

const UI = {
	log: $('#regLog'),
	search: $('#regSearch'),
	btnProvCat: $('#btnProvision'),
	btnValidate: $('#btnValidate'),
	btnProvAll: $('#btnProvisionAll'),
	selectCat: $('#regSelect'),
	pagerInfo: $('#regPageInfo'),
	prev: $('#regPrev'),
	next: $('#regNext'),
}

let REG = []
let FILTERED = []
let page = 1
const pageSize = 50

function log(msg, type = 'info') {
	if (!UI.log) return
	const line = document.createElement('div')
	line.className = `log-${type}`
	line.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg)
	UI.log.prepend(line)
}

async function api(path, body) {
	const opt = body
		? {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
		  }
		: {}
	if (__R_APIKEY)
		opt.headers = { ...(opt.headers || {}), 'x-api-key': __R_APIKEY }
	const r = await fetch(`${__R_BASE}${path}`, opt)
	const j = await r.json().catch(() => ({}))
	if (!r.ok) throw new Error((j && j.error) || r.statusText || 'Request failed')
	return j
}

function renderSelect() {
	if (!UI.selectCat) return
	const options = FILTERED.map(
		r => `<option value="${r.category}">${r.category}</option>`
	).join('')
	UI.selectCat.innerHTML = options
}

function renderTable() {
	const tbody = $('#regTable tbody')
	if (!tbody) return
	const total = FILTERED.length
	const totalPages = Math.max(1, Math.ceil(total / pageSize))
	if (page > totalPages) page = totalPages
	const start = (page - 1) * pageSize
	const end = Math.min(start + pageSize, total)
	const rows = FILTERED.slice(start, end)

	tbody.innerHTML = rows
		.map(
			(r, idx) => `
    <tr>
      <td>${start + idx + 1}</td>
      <td>${r.key || ''}</td>
      <td>${r.category || ''}</td>
      <td><code>${r.target_spreadsheet_id_category || ''}</code> / <code>${
				r.category_sheet || ''
			}</code></td>
      <td><code>${r.target_spreadsheet_id_models || ''}</code> / <code>${
				r.models_sheet || ''
			}</code></td>
      <td><code>${r.target_spreadsheet_id_review || ''}</code> / <code>${
				r.review_sheet || ''
			}</code></td>
      <td>
        <button class="btn-secondary" data-act="preview" data-category="${
					r.category
				}">Preview</button>
        <button class="btn-secondary" data-act="apply" data-category="${
					r.category
				}">Apply</button>
        <button class="btn-secondary" data-act="test" data-category="${
					r.category
				}">Test</button>
      </td>
    </tr>
  `
		)
		.join('')

	if (UI.pagerInfo)
		UI.pagerInfo.textContent = total ? `${page} / ${totalPages}` : '0 / 0'
	if (UI.prev) UI.prev.disabled = page <= 1
	if (UI.next) UI.next.disabled = page >= totalPages
}

async function loadRegistry() {
	const data = await api('/api/registry/list')
	REG = Array.isArray(data.items) ? data.items : []
	FILTERED = REG.slice()
	page = 1
	renderTable()
	renderSelect()
	log(`Loaded ${REG.length} registry rows.`, 'info')
}

function applyFilter() {
	const q = (UI.search?.value || '').trim().toLowerCase()
	FILTERED = !q
		? REG.slice()
		: REG.filter(
				r =>
					String(r.category || '')
						.toLowerCase()
						.includes(q) ||
					String(r.key || '')
						.toLowerCase()
						.includes(q)
		  )
	page = 1
	renderTable()
	renderSelect()
}

function bindActions() {
	UI.btnProvCat?.addEventListener('click', async () => {
		const cat = UI.selectCat?.value
		if (!cat) return log('Выберите категорию', 'warn')
		try {
			const res = await api('/api/registry/provision-category', {
				category: cat,
			})
			log(
				res.ok
					? `✓ Header applied for ${cat}`
					: res.error || 'Provision failed',
				res.ok ? 'ok' : 'error'
			)
		} catch (e) {
			log(String(e), 'error')
		}
	})

	UI.btnValidate?.addEventListener('click', async () => {
		const cat = UI.selectCat?.value
		if (!cat) return log('Выберите категорию', 'warn')
		try {
			const res = await api('/api/registry/validate-category', {
				category: cat,
			})
			if (res.ok && res.valid) log(`✓ Header is valid for ${cat}`, 'ok')
			else if (res.ok)
				log(
					{
						msg: `Header mismatch for ${cat}`,
						expected: res.expected,
						got: res.header,
					},
					'warn'
				)
			else log(res.error || 'Validate failed', 'error')
		} catch (e) {
			log(String(e), 'error')
		}
	})

	UI.btnProvAll?.addEventListener('click', async () => {
		try {
			const res = await api('/api/registry/provision-all', {})
			log(
				res.ok
					? `✓ Provisioned: ${res.done}/${res.total}`
					: res.error || 'Provision All failed',
				res.ok ? 'ok' : 'error'
			)
		} catch (e) {
			log(String(e), 'error')
		}
	})

	$('#regTable')?.addEventListener('click', async e => {
		const btn = e.target.closest('button[data-act]')
		if (!btn) return
		const category = btn.getAttribute('data-category')
		const act = btn.getAttribute('data-act')

		if (act === 'preview') {
			try {
				const res = await api('/api/registry/parse-schema', { category })
				const box = $('#schemaPreview')
				box.innerHTML = `
          <h4>${category}</h4>
          <pre>${
						res.schema && typeof res.schema === 'object'
							? JSON.stringify(res.schema, null, 2)
							: res.schema || ''
					}</pre>
          <h5>Columns:</h5>
          <ul>${(res.columns || [])
						.map(c => `<li><code>${c}</code></li>`)
						.join('')}</ul>
        `
				log(`Preview: ${category}`)
			} catch (e) {
				log(String(e), 'error')
			}
		}

		if (act === 'apply') {
			try {
				const res = await api('/api/registry/provision-category', { category })
				log(
					res.ok
						? `✓ Header applied for ${category}`
						: res.error || 'Apply failed',
					res.ok ? 'ok' : 'error'
				)
			} catch (e) {
				log(String(e), 'error')
			}
		}

		if (act === 'test') {
			try {
				const res = await api('/api/registry/test-access', { category })
				log(
					res.ok ? `✓ Access OK for ${category}` : res.error || 'Access failed',
					res.ok ? 'ok' : 'error'
				)
			} catch (e) {
				log(String(e), 'error')
			}
		}
	})

	UI.prev?.addEventListener('click', () => {
		if (page > 1) {
			page--
			renderTable()
		}
	})
	UI.next?.addEventListener('click', () => {
		page++
		renderTable()
	})
	UI.search?.addEventListener('input', applyFilter)
}

document.readyState === 'loading'
	? document.addEventListener('DOMContentLoaded', () => {
			bindActions()
			loadRegistry()
	  })
	: (bindActions(), loadRegistry())
