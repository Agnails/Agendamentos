/* ==========================================================================
   Agnails - sw.js (v2)

   Mudanças de segurança/robustez em relação à v1:
   - Lista de arquivos pré-cacheados atualizada para os nomes atuais do
     projeto (a v1 ainda cacheava "/adm.html" como se fosse o painel da
     manicure, e não incluía login.html, cobranca.html, manicures.html
     nem agendamentos.html — o app renomeou esses arquivos e o
     Service Worker antigo ficou desatualizado).
   - HTML e JS do próprio app agora usam estratégia "network-first": o
     navegador sempre tenta buscar a versão mais nova primeiro, e só cai
     para o cache se estiver offline. Isso evita que uma correção de
     segurança fique "presa" em cache por tempo indefinido em quem já
     tinha instalado o app como PWA — o problema mais comum de Service
     Workers em produção. Assets estáticos (fontes, ícone) continuam
     cache-first, já que não mudam com frequência e não carregam lógica
     de segurança.
   - self.skipWaiting() + clients.claim() para que uma nova versão do
     Service Worker assuma o controle imediatamente, sem depender de o
     usuário fechar todas as abas do app.
   ========================================================================== */
const CACHE_NAME = 'agnail-cache-v2';
const ASSETS_ESTATICOS = [
  'assets/logo.png',
  'https://fonts.googleapis.com/css2?family=Nunito:wght@300;400;500;600;700&family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];
const PAGINAS_APP = [
  '/',
  'index.html',
  'login.html',
  'cobranca.html',
  'manicures.html',
  'agendamentos.html',
  'adm.html'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_ESTATICOS.concat(PAGINAS_APP)))
      .catch(err => console.log('Falha ao cachear recursos:', err))
  );
});

self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => Promise.all(
      cacheNames.map(cacheName => {
        if (!cacheWhitelist.includes(cacheName)) {
          return caches.delete(cacheName);
        }
      })
    )).then(() => self.clients.claim())
  );
});

function ehCodigoDoApp(url) {
  // HTML e JS de mesma origem (não CDNs externas) carregam a lógica do
  // app, inclusive a de segurança — nunca devem "grudar" em cache velho.
  return url.origin === self.location.origin &&
    (url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname === '/');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // nunca interceptar POST/escrita
  const url = new URL(req.url);

  if (ehCodigoDoApp(url)) {
    // Network-first: tenta a rede; só usa o cache como fallback offline.
    event.respondWith(
      fetch(req)
        .then(resp => {
          if (resp && resp.status === 200) {
            const copia = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, copia));
          }
          return resp;
        })
        .catch(() => caches.match(req).then(cached => cached || new Response(
          'Conteúdo indisponível offline', { status: 503, statusText: 'Offline' }
        )))
    );
    return;
  }

  // Cache-first para assets estáticos (fontes, ícones, CDNs).
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copia = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copia));
        }
        return resp;
      }).catch(() => new Response('Conteúdo indisponível offline', { status: 503, statusText: 'Offline' }));
    })
  );
});
