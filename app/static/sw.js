/**
 * Plataforma Íris — Service Worker (PWA / uso offline).
 *
 * Servido em /sw.js (rota em app/__init__.py) para controlar o site inteiro.
 *
 * Objetivo: sem internet, a página de adaptação continua abrindo e a barra de leitura e as
 * ferramentas visuais (fonte, contraste, tipografia, régua, foco, leitura em voz alta, simulador)
 * seguem funcionando sobre o último material adaptado. Adaptar, importar e exportar exigem conexão.
 *
 * Caches:
 *   iris-estatico-<versão>  CSS/JS/imagens locais + bibliotecas de CDN (Tailwind, marked, DOMPurify).
 *   iris-fontes-<versão>    CSS e arquivos das fontes Inter, Atkinson Hyperlegible e OpenDyslexic.
 *   iris-runtime            O que é carregado sob demanda (MathJax, Mermaid, pictogramas ARASAAC).
 *   iris-paginas            A página /inclusao/ do professor logado — apagada no logout e quando a
 *                           sessão expira (tem o nome do professor e o token CSRF).
 *
 * Nunca entram em cache: /api/* (dados de alunos e do professor), impressão, relatório AEE,
 * login/cadastro e qualquer requisição que não seja GET.
 *
 * Ao publicar mudanças nos arquivos estáticos, incremente VERSAO para renovar o pré-cache.
 */

const VERSAO = "v1";
const CACHE_ESTATICO = `iris-estatico-${VERSAO}`;
const CACHE_FONTES = `iris-fontes-${VERSAO}`;
const CACHE_RUNTIME = "iris-runtime";
const CACHE_PAGINAS = "iris-paginas";
const LIMITE_RUNTIME = 200;

const PAGINA_OFFLINE = "/static/offline.html";
const PAGINAS_OFFLINE = ["/inclusao/"]; // navegações que podem ser servidas do cache

const PRECACHE_LOCAL = [
  PAGINA_OFFLINE,
  "/manifest.webmanifest",
  "/static/css/inclusao.css",
  "/static/css/impressao.css",
  "/static/js/inclusao.js",
  "/static/js/empatia.js",
  "/static/js/audio_graph.js",
  "/static/js/apoio_cognitivo.js",
  "/static/js/iris-voz.js",
  "/static/js/impressao.js",
  "/static/js/pwa.js",
  "/static/js/aee_analytics.js",
  "/static/img/logo-web.png",
  "/static/img/favicon.ico",
  "/static/img/favicon-32.png",
  "/static/img/apple-touch-icon.png",
  "/static/img/icon-192.png",
  "/static/img/icon-512.png",
];

const PRECACHE_CDN = [
  "https://cdn.tailwindcss.com",
  "https://cdn.jsdelivr.net/npm/marked@15/marked.min.js",
  "https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js",
];

// Folhas de estilo de fontes: o CSS é guardado e os arquivos .woff2 citados nele são baixados já na
// instalação — o navegador só baixa uma fonte quando ela é usada, e sem isso a OpenDyslexic
// escolhida pela primeira vez offline não apareceria.
const PRECACHE_FONTES = [
  "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=Inter:wght@400;500;600;700&display=swap",
  "https://cdn.jsdelivr.net/npm/@fontsource/opendyslexic@5.3.0/400.css",
  "https://cdn.jsdelivr.net/npm/@fontsource/opendyslexic@5.3.0/700.css",
];
const SUBCONJUNTOS_IGNORADOS = /^(cyrillic|greek|vietnamese|hebrew|math|symbols)/i;

const HOSTS_CDN = new Set(["cdn.tailwindcss.com", "cdn.jsdelivr.net", "fonts.googleapis.com"]);
const HOSTS_IMUTAVEIS = new Set(["fonts.gstatic.com", "static.arasaac.org"]);
const ROTAS_SEM_CACHE = /^\/(api\/|inclusao\/imprimir|inclusao\/relatorio-aee|login|register|logout|sw\.js)/;

/* ------------------------------------------------------------------ utilitários */

/** Busca com CORS (resposta legível, sem "padding" de cota); se o CDN não permitir, cai para no-cors. */
async function buscarRecurso(url) {
  try {
    const resposta = await fetch(url, { mode: "cors", credentials: "omit" });
    if (resposta.ok) return resposta;
  } catch { /* tenta no-cors abaixo */ }
  const opaca = await fetch(url, { mode: "no-cors", credentials: "omit" });
  if (opaca.type === "opaque" || opaca.ok) return opaca;
  throw new Error(`Falha ao baixar ${url}`);
}

async function guardar(cache, url) {
  const resposta = await buscarRecurso(url);
  await cache.put(url, resposta.clone());
  return resposta;
}

async function precacheFontes() {
  const cache = await caches.open(CACHE_FONTES);
  await Promise.allSettled(PRECACHE_FONTES.map(async (urlCss) => {
    const resposta = await guardar(cache, urlCss);
    if (resposta.type === "opaque") return;
    const css = await resposta.text();
    // Cada @font-face do Google vem precedido de /* latin */, /* greek */ etc.
    const regra = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*{[^}]*?url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
    const arquivos = new Set();
    for (const [, subconjunto, url] of css.matchAll(regra)) {
      if (subconjunto && SUBCONJUNTOS_IGNORADOS.test(subconjunto)) continue;
      arquivos.add(new URL(url, urlCss).href);
    }
    await Promise.allSettled([...arquivos].map((url) => guardar(cache, url)));
  }));
}

async function limitarCache(nome, maximo) {
  const cache = await caches.open(nome);
  const chaves = await cache.keys();
  await Promise.all(chaves.slice(0, Math.max(chaves.length - maximo, 0)).map((k) => cache.delete(k)));
}

const correspondencia = (requisicao, nome) => caches.open(nome).then((c) => c.match(requisicao, { ignoreVary: true, ignoreSearch: false }));

/* ------------------------------------------------------------------ ciclo de vida */

self.addEventListener("install", (evento) => {
  evento.waitUntil((async () => {
    const cache = await caches.open(CACHE_ESTATICO);
    // allSettled: um CDN fora do ar não impede a instalação; o recurso entra no cache no próximo uso.
    await Promise.allSettled([
      ...PRECACHE_LOCAL.map((url) => cache.add(new Request(url, { cache: "reload" }))),
      ...PRECACHE_CDN.map((url) => guardar(cache, url)),
      precacheFontes(),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil((async () => {
    const validos = new Set([CACHE_ESTATICO, CACHE_FONTES, CACHE_RUNTIME, CACHE_PAGINAS]);
    for (const nome of await caches.keys()) {
      if (nome.startsWith("iris-") && !validos.has(nome)) await caches.delete(nome);
    }
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener("message", (evento) => {
  const tipo = evento.data?.tipo;
  if (tipo === "limpar-dados-sessao") {
    evento.waitUntil(caches.delete(CACHE_PAGINAS));
  } else if (tipo === "status-cache") {
    evento.waitUntil((async () => {
      const fontes = await caches.open(CACHE_FONTES).then((c) => c.keys());
      const estatico = await caches.open(CACHE_ESTATICO).then((c) => c.keys());
      evento.source?.postMessage({ tipo: "status-cache", arquivos: estatico.length, fontes: fontes.length, versao: VERSAO });
    })());
  }
});

/* ------------------------------------------------------------------ estratégias */

/** Página do professor: rede primeiro (conteúdo e sessão sempre atuais); cache só quando offline. */
async function navegacao(evento) {
  const url = new URL(evento.request.url);
  const chave = url.origin + url.pathname; // sem ?query: uma cópia por página
  try {
    const resposta = (await evento.preloadResponse) || (await fetch(evento.request));
    const destino = new URL(resposta.url || url.href);
    if (destino.pathname.startsWith("/login")) {
      await caches.delete(CACHE_PAGINAS); // sessão expirou: a cópia offline não vale mais
    } else if (resposta.ok && PAGINAS_OFFLINE.includes(destino.pathname) && !resposta.redirected) {
      const cache = await caches.open(CACHE_PAGINAS);
      await cache.put(chave, resposta.clone());
    }
    return resposta;
  } catch {
    return (await correspondencia(chave, CACHE_PAGINAS))
      || (await correspondencia(PAGINA_OFFLINE, CACHE_ESTATICO))
      || new Response("Sem conexão.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

async function semCache(evento) {
  try {
    return (await evento.preloadResponse) || (await fetch(evento.request));
  } catch {
    return (await correspondencia(PAGINA_OFFLINE, CACHE_ESTATICO)) || Response.error();
  }
}

/** Devolve o cache na hora e atualiza em segundo plano. */
async function cacheAtualizando(evento, nomeCache) {
  const emCache = await correspondencia(evento.request, nomeCache);
  const daRede = fetch(evento.request).then(async (resposta) => {
    if (resposta.ok || resposta.type === "opaque") {
      const cache = await caches.open(nomeCache);
      await cache.put(evento.request, resposta.clone());
    }
    return resposta;
  });
  if (emCache) {
    evento.waitUntil(daRede.catch(() => null));
    return emCache;
  }
  return daRede;
}

/** Arquivos imutáveis (fontes, pictogramas): cache primeiro. */
async function cachePrimeiro(evento, nomeCache) {
  const emCache = (await correspondencia(evento.request, CACHE_FONTES)) || (await correspondencia(evento.request, nomeCache));
  if (emCache) return emCache;
  const resposta = await fetch(evento.request);
  if (resposta.ok || resposta.type === "opaque") {
    const cache = await caches.open(nomeCache);
    await cache.put(evento.request, resposta.clone());
    if (nomeCache === CACHE_RUNTIME) evento.waitUntil(limitarCache(CACHE_RUNTIME, LIMITE_RUNTIME));
  }
  return resposta;
}

/** Rede primeiro, com cópia de reserva (busca de pictogramas, bibliotecas carregadas sob demanda). */
async function redePrimeiro(evento, nomeCache) {
  try {
    const resposta = await fetch(evento.request);
    if (resposta.ok || resposta.type === "opaque") {
      const cache = await caches.open(nomeCache);
      await cache.put(evento.request, resposta.clone());
      evento.waitUntil(limitarCache(nomeCache, LIMITE_RUNTIME));
    }
    return resposta;
  } catch (erro) {
    const emCache = await correspondencia(evento.request, nomeCache);
    if (emCache) return emCache;
    throw erro;
  }
}

self.addEventListener("fetch", (evento) => {
  const { request } = evento;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (ROTAS_SEM_CACHE.test(url.pathname)) {
      // Rede direto, sem cópia; offline, uma navegação (ex.: /login) mostra a página explicativa.
      if (request.mode === "navigate") evento.respondWith(semCache(evento));
      return;
    }
    if (request.mode === "navigate") { evento.respondWith(navegacao(evento)); return; }
    if (url.pathname.startsWith("/static/") || url.pathname === "/manifest.webmanifest") {
      evento.respondWith(cacheAtualizando(evento, CACHE_ESTATICO));
    }
    return;
  }

  if (HOSTS_IMUTAVEIS.has(url.hostname)) {
    evento.respondWith(cachePrimeiro(evento, url.hostname === "fonts.gstatic.com" ? CACHE_FONTES : CACHE_RUNTIME));
  } else if (url.hostname === "fonts.googleapis.com" || url.pathname.startsWith("/npm/@fontsource/")) {
    evento.respondWith(cacheAtualizando(evento, CACHE_FONTES));
  } else if (url.hostname === "cdn.jsdelivr.net" && /\/npm\/(mathjax|mermaid)@/.test(url.pathname)) {
    // Grandes e com versão maior fixada na URL: baixados uma vez, no primeiro uso.
    evento.respondWith(cachePrimeiro(evento, CACHE_RUNTIME));
  } else if (HOSTS_CDN.has(url.hostname)) {
    evento.respondWith(cacheAtualizando(evento, CACHE_ESTATICO));
  } else if (url.hostname === "api.arasaac.org") {
    evento.respondWith(redePrimeiro(evento, CACHE_RUNTIME));
  }
  // Demais origens (VLibras, APIs de terceiros): comportamento normal do navegador.
});
