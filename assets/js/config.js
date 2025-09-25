// настройки n8n и прокси

// Эта переменная не используется напрямую в authless режиме,
// но можно переопределить, если потребуется.


// Explicit endpoints for Single (test/prod)
window.N8N_ENDPOINTS = {
  dev: 'https://almirs-workflow.app.n8n.cloud/webhook-test/tractor-intake',
  prod:'https://almirs-workflow.app.n8n.cloud/webhook/tractor-intake',
};
