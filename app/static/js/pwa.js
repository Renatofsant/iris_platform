/**
 * Plataforma Íris — PWA: registra o service worker (/sw.js), avisa quando a conexão cai e
 * apaga as cópias offline da sessão no logout.
 *
 * Dispara no document:
 *   iris:conexao  detail: { online: boolean }  — outros módulos (ex.: aee_analytics.js) reagem.
 */
(() => {
  const CHAVES_SESSAO = ["iris:ultimo-material:v1", "iris:aee-fila:v1"]; // dados locais apagados no logout

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((erro) => {
        console.warn("Íris: service worker não registrado —", erro);
      });
    });
  }

  // Logout: sem isso, a página do professor (e o último material) continuariam no cache do aparelho,
  // o que importa em computadores compartilhados da escola.
  document.addEventListener("submit", (evento) => {
    const form = evento.target;
    if (!(form instanceof HTMLFormElement) || !/\/logout$/.test(new URL(form.action, location.href).pathname)) return;
    navigator.serviceWorker?.controller?.postMessage({ tipo: "limpar-dados-sessao" });
    for (const chave of CHAVES_SESSAO) {
      try { localStorage.removeItem(chave); } catch { /* modo privado */ }
    }
  }, true);

  // Faixa de aviso offline (só na página de adaptação, que tem a região #iris-status).
  const regiaoStatus = document.getElementById("iris-status");
  let faixa = null;

  function anunciar(mensagem) {
    if (!regiaoStatus) return;
    regiaoStatus.textContent = "";
    window.setTimeout(() => { regiaoStatus.textContent = mensagem; }, 60);
  }

  function atualizarConexao(anunciarMudanca) {
    const online = navigator.onLine;
    document.documentElement.dataset.conexao = online ? "online" : "offline";
    document.dispatchEvent(new CustomEvent("iris:conexao", { detail: { online } }));
    if (!regiaoStatus) return;

    if (!online && !faixa) {
      faixa = document.createElement("div");
      faixa.className = "iris-no-print iris-faixa-offline";
      faixa.innerHTML =
        '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M5 12.86a10 10 0 0 1 5.17-2.69M19 12.86a10 10 0 0 0-2-1.53M2 8.82a15 15 0 0 1 4.18-2.65M22 8.82a15 15 0 0 0-11.29-3.76M2 2l20 20"/></svg>' +
        "<p><strong>Modo offline.</strong> As ferramentas de leitura continuam funcionando; adaptar e exportar voltam quando a conexão retornar.</p>";
      document.body.prepend(faixa);
    } else if (online && faixa) {
      faixa.remove();
      faixa = null;
    }
    if (anunciarMudanca) {
      anunciar(online
        ? "Conexão restabelecida."
        : "Você está offline. As ferramentas de leitura continuam funcionando; adaptar e exportar exigem conexão.");
    }
  }

  window.addEventListener("online", () => atualizarConexao(true));
  window.addEventListener("offline", () => atualizarConexao(true));
  atualizarConexao(false);
})();
