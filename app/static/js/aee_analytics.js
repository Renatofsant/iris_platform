/**
 * Plataforma Íris — Histórico e Trajetória AEE.
 *
 *   1. Telemetria anônima: observa os controles de acessibilidade já existentes (sem alterá-los)
 *      e registra recurso + valor + perfil do material. Nada de aluno, texto ou nome.
 *      Os eventos ficam numa fila no navegador e são enviados em lote a /api/inclusao/aee/eventos;
 *      offline, a fila espera a conexão voltar (com o horário original de cada uso).
 *   2. Painel (modal #iris-aee): estatísticas por recurso, trajetória semanal e sugestões para o PEI.
 *
 * Evento ouvido no document:
 *   iris:exportacao  detail.formato — "braille" | "docx" | "impressao"
 */
(() => {
  const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
  const ENDPOINT_EVENTOS = "/api/inclusao/aee/eventos";
  const ENDPOINT_RESUMO = "/api/inclusao/aee/resumo";
  const CHAVE_FILA = "iris:aee-fila:v1";
  const CHAVE_PREFERENCIAS = "iris:preferencias-leitura:v1"; // gravada por inclusao.js
  const TAMANHO_LOTE = 50;
  const MAXIMO_FILA = 500;
  const INTERVALO_ENVIO_MS = 20_000;

  if (!$("#iris-aee")) return;

  /* =======================================================================
   * 1. Telemetria
   * ==================================================================== */

  const ler = (chave) => { try { return JSON.parse(localStorage.getItem(chave)); } catch { return null; } };
  const gravar = (chave, valor) => { try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* modo privado */ } };

  let fila = Array.isArray(ler(CHAVE_FILA)) ? ler(CHAVE_FILA) : [];
  let enviando = false;

  // Perfil do material na tela (inclusao.js grava em #iris-leitor[data-perfil]); sem material, o do formulário.
  const perfilAtual = () => $("#iris-leitor")?.dataset.perfil || $('input[name="perfil"]:checked')?.value || "";

  function registrar(recurso, valor) {
    if (valor == null || valor === "") return;
    fila.push({ recurso, valor: String(valor), perfil: perfilAtual(), quando: new Date().toISOString() });
    if (fila.length > MAXIMO_FILA) fila = fila.slice(-MAXIMO_FILA);
    gravar(CHAVE_FILA, fila);
  }

  async function enviarFila({ aoSair = false } = {}) {
    if (enviando || !fila.length || !navigator.onLine) return;
    enviando = true;
    const lote = fila.slice(0, TAMANHO_LOTE);
    try {
      const resposta = await fetch(ENDPOINT_EVENTOS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventos: lote }),
        keepalive: aoSair, // permite concluir o envio enquanto a página fecha
      });
      // 4xx (exceto sessão expirada) = lote rejeitado: descarta para não repetir para sempre.
      if (resposta.ok || (resposta.status >= 400 && resposta.status < 500 && resposta.status !== 401)) {
        fila = fila.slice(lote.length);
        gravar(CHAVE_FILA, fila);
      }
    } catch { /* offline ou servidor fora: tenta de novo depois */ } finally {
      enviando = false;
    }
    if (!aoSair && fila.length >= TAMANHO_LOTE) enviarFila();
  }

  window.setInterval(enviarFila, INTERVALO_ENVIO_MS);
  window.addEventListener("online", () => enviarFila());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") enviarFila({ aoSair: true }); });

  // --- Controles de escolha
  document.addEventListener("change", (e) => {
    const alvo = e.target;
    if (alvo.matches('input[name="tema"]')) registrar("contraste", alvo.value);
    else if (alvo.matches('input[name="tipografia"]')) registrar("tipografia", alvo.value);
    else if (alvo.id === "iris-tts-velocidade") registrar("velocidade_voz", alvo.value);
    else if (alvo.id === "iris-pausa-intervalo" && alvo.value !== "0") registrar("pausa", alvo.value);
    else if (alvo.id === "iris-sonificacao-faixa") registrar("sonificacao", alvo.value);
  });

  // --- Fonte e entrelinhas: só o valor final, depois que o ajuste "assenta" (evita um evento por clique).
  let ultimaLeitura = ler(CHAVE_PREFERENCIAS) || {};
  let temporizadorLeitura = null;
  function agendarLeituraPreferencias() {
    window.clearTimeout(temporizadorLeitura);
    temporizadorLeitura = window.setTimeout(() => {
      const atual = ler(CHAVE_PREFERENCIAS) || {};
      if (atual.fonte !== ultimaLeitura.fonte) registrar("fonte", atual.fonte);
      if (atual.entrelinhas !== ultimaLeitura.entrelinhas) registrar("entrelinhas", Number(atual.entrelinhas).toFixed(1));
      ultimaLeitura = atual;
    }, 2000);
  }
  ["#iris-fonte-slider", "#iris-fonte-menos", "#iris-fonte-mais", "#iris-fonte-resetar", "#iris-espacamento"].forEach((s) => {
    $(s)?.addEventListener("click", agendarLeituraPreferencias);
  });
  $("#iris-fonte-slider")?.addEventListener("change", agendarLeituraPreferencias);
  document.addEventListener("keydown", (e) => { if (e.target.id === "iris-fonte-slider") agendarLeituraPreferencias(); });

  // --- Liga/desliga: lê o estado ANTES do clique (fase de captura) e registra quando é ligado.
  const INTERRUPTORES = {
    "iris-regua": ["regua", "aria-checked"],
    "iris-foco-minimo": ["foco_minimo", "aria-checked"],
    "iris-termos-libras": ["termos_libras", "aria-checked"],
    "iris-mapa-simples": ["mapa_simples", "aria-pressed"],
    "iris-vlibras": ["vlibras", "aria-pressed"],
  };
  document.addEventListener("click", (e) => {
    const botao = e.target.closest?.("button");
    if (!botao || botao.disabled) return;
    const config = INTERRUPTORES[botao.id];
    if (config && botao.getAttribute(config[1]) !== "true") registrar(config[0], "ativado");
    if (botao.id === "iris-tts" && /Ouvir/.test($("#iris-tts-rotulo")?.textContent || "")) {
      registrar("leitura_voz", $("#iris-tts-velocidade")?.value || "1");
    }
  }, true);

  document.addEventListener("iris:exportacao", (e) => registrar("exportacao", e.detail?.formato));

  /* =======================================================================
   * 2. Painel "Histórico e Trajetória AEE"
   * ==================================================================== */

  const dialogo = $("#iris-aee");
  const conteudo = $("#aee-conteudo");
  const status = $("#aee-status");
  const filtroDias = $("#aee-dias");
  const filtroPerfil = $("#aee-perfil");
  const filtroEscopo = $("#aee-escopo");
  let ultimoResumo = null;

  const nomesPerfil = Object.fromEntries(
    [...filtroPerfil.options].filter((o) => o.value).map((o) => [o.value, o.textContent.trim()]),
  );
  nomesPerfil.SEM_PERFIL = "Sem material aberto";

  function el(tag, atributos = {}, ...filhos) {
    const elemento = document.createElement(tag);
    for (const [nome, valor] of Object.entries(atributos)) {
      if (valor === false || valor == null) continue;
      if (nome === "class") elemento.className = valor;
      else elemento.setAttribute(nome, valor === true ? "" : String(valor));
    }
    for (const filho of filhos.flat()) {
      if (filho == null || filho === false) continue;
      elemento.append(filho instanceof Node ? filho : document.createTextNode(String(filho)));
    }
    return elemento;
  }

  const numero = (n) => Number(n).toLocaleString("pt-BR");
  const porcento = (n) => `${Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  const dataCurta = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

  function bloco(titulo, ...filhos) {
    return el("section", { class: "rounded-xl border border-slate-200 bg-white p-4" },
      el("h3", { class: "text-sm font-semibold text-slate-900" }, titulo), ...filhos);
  }

  /** Barras horizontais: uma cor (magnitude), rótulo e valor sempre em texto. */
  function barras(itens, { rotuloTotal = "usos" } = {}) {
    const maximo = Math.max(...itens.map((i) => i.total), 1);
    return el("ul", { class: "mt-3 space-y-2" }, itens.map((item) =>
      el("li", { class: "grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-sm", title: `${item.rotulo}: ${numero(item.total)} ${rotuloTotal}${item.pct != null ? ` (${porcento(item.pct)})` : ""}` },
        el("span", { class: "truncate text-slate-700" }, item.rotulo),
        el("span", { class: "h-3 rounded-r bg-slate-100", "aria-hidden": "true" },
          el("span", { class: "block h-3 rounded-r bg-indigo-600", style: `width:${Math.max((item.total / maximo) * 100, 2)}%` })),
        el("span", { class: "tabular-nums text-slate-900" },
          numero(item.total), item.pct != null ? el("span", { class: "ml-1 text-xs text-slate-500" }, `(${porcento(item.pct)})`) : null),
      )));
  }

  /** Trajetória semanal: colunas de uma cor, dica ao passar o mouse/foco e tabela equivalente. */
  function trajetoria(semanas) {
    const maximo = Math.max(...semanas.map((s) => s.total), 1);
    const dica = el("p", { class: "mt-2 min-h-[1.25rem] text-xs text-slate-600", "aria-live": "polite" });
    const colunas = el("div", { class: "mt-3 flex h-36 items-end gap-1 border-b border-slate-300", role: "list", "aria-label": "Interações por semana" },
      semanas.map((s) => {
        const texto = `Semana de ${dataCurta(s.semana)}: ${numero(s.total)} interações`;
        const coluna = el("div", { class: "group relative flex h-full flex-1 cursor-default items-end rounded-t focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500", role: "listitem", tabindex: 0, "aria-label": texto },
          el("span", {
            class: "block w-full rounded-t bg-indigo-600 group-hover:bg-indigo-800 group-focus:bg-indigo-800",
            style: `height:${s.total ? Math.max((s.total / maximo) * 100, 3) : 0}%`,
          }));
        const mostrar = () => { dica.textContent = texto; };
        coluna.addEventListener("mouseenter", mostrar);
        coluna.addEventListener("focus", mostrar);
        return coluna;
      }));
    const eixo = el("div", { class: "mt-1 flex gap-1 text-[10px] text-slate-500", "aria-hidden": "true" },
      semanas.map((s, i) => el("span", { class: "flex-1 text-center" }, i % 2 === semanas.length % 2 ? "" : dataCurta(s.semana))));
    const tabela = el("details", { class: "mt-2 text-sm" },
      el("summary", { class: "cursor-pointer text-indigo-700 underline-offset-2 hover:underline" }, "Ver como tabela"),
      el("table", { class: "mt-2 w-full text-left text-xs" },
        el("thead", {}, el("tr", {}, el("th", { class: "py-1" }, "Semana de"), el("th", {}, "Total"), el("th", {}, "Visual"), el("th", {}, "Auditivo"), el("th", {}, "Atenção"), el("th", {}, "Libras"))),
        el("tbody", {}, semanas.map((s) => el("tr", { class: "border-t border-slate-100" },
          el("td", { class: "py-1" }, dataCurta(s.semana)), el("td", {}, numero(s.total)),
          el("td", {}, s.por_categoria.visual), el("td", {}, s.por_categoria.auditivo),
          el("td", {}, s.por_categoria.cognitivo), el("td", {}, s.por_categoria.linguagem)))),
      ));
    return [colunas, eixo, dica, tabela];
  }

  function textoPei(resumo) {
    const perfil = resumo.perfil == null ? "todos os perfis" : (nomesPerfil[resumo.perfil || "SEM_PERFIL"] || resumo.perfil);
    const linhas = [
      `Histórico de uso dos recursos de acessibilidade — Plataforma Íris`,
      `Período: últimos ${resumo.periodo_dias} dias · Perfil: ${perfil} · ${resumo.total_eventos} interações registradas (dados anônimos).`,
      "",
      "Recursos mais utilizados:",
      ...resumo.recursos.map((r) => `- ${r.rotulo}: ${r.valores.slice(0, 3).map((v) => `${v.rotulo} (${porcento(v.pct)})`).join(", ")}`),
    ];
    if (resumo.sugestoes_pei.length) linhas.push("", "Indícios para o PEI (avaliar com a equipe do AEE):", ...resumo.sugestoes_pei.map((s) => `- ${s}`));
    return linhas.join("\n");
  }

  function renderizar(resumo) {
    ultimoResumo = resumo;
    if (!resumo.total_eventos) {
      conteudo.replaceChildren(el("div", { class: "rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600" },
        el("p", { class: "font-semibold text-slate-800" }, "Ainda não há uso registrado neste período."),
        el("p", { class: "mt-1" }, "As estatísticas aparecem conforme as ferramentas de leitura (contraste, voz, tipografia, régua…) são usadas com os materiais adaptados.")));
      return;
    }
    const recursoTopo = resumo.recursos[0];
    const categoriaTopo = [...resumo.por_categoria].sort((a, b) => b.total - a.total)[0];
    const bloco_kpi = (rotulo, valor, detalhe) => el("div", { class: "rounded-xl border border-slate-200 bg-white p-3" },
      el("p", { class: "text-xs font-medium text-slate-600" }, rotulo),
      el("p", { class: "mt-1 text-xl font-semibold tabular-nums text-slate-900" }, valor),
      detalhe ? el("p", { class: "text-xs text-slate-500" }, detalhe) : null);

    const sugestoes = resumo.sugestoes_pei.length
      ? el("ul", { class: "mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-800" }, resumo.sugestoes_pei.map((s) => el("li", {}, s)))
      : el("p", { class: "mt-2 text-sm text-slate-600" }, "Ainda sem padrão claro de uso (são precisos alguns registros de cada recurso).");
    const copiar = el("button", { type: "button", class: "mt-3 inline-flex h-9 items-center rounded-lg border border-indigo-200 bg-indigo-50 px-3 text-sm font-semibold text-indigo-800 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" }, "Copiar resumo para o PEI");
    copiar.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(textoPei(ultimoResumo));
        status.textContent = "Resumo copiado. Cole no documento do PEI.";
      } catch {
        status.textContent = "Não foi possível copiar automaticamente neste navegador.";
      }
    });

    conteudo.replaceChildren(
      el("div", { class: "grid gap-3 sm:grid-cols-4" },
        bloco_kpi("Interações", numero(resumo.total_eventos), `últimos ${resumo.periodo_dias} dias`),
        bloco_kpi("Recurso mais usado", recursoTopo?.rotulo || "—", recursoTopo ? `${numero(recursoTopo.total)} usos` : null),
        bloco_kpi("Área predominante", categoriaTopo?.rotulo || "—", categoriaTopo ? porcento(categoriaTopo.pct) : null),
        bloco_kpi("Fonte na tela (mediana)", resumo.fonte_mediana_px ? `${resumo.fonte_mediana_px} px` : "—",
          resumo.fonte_mediana_px ? `≈ ${Math.round(resumo.fonte_mediana_px * 0.75)} pt no papel` : null)),
      el("section", { class: "rounded-xl border border-violet-200 bg-violet-50/60 p-4" },
        el("h3", { class: "text-sm font-semibold text-violet-950" }, "Indícios para o PEI"),
        el("p", { class: "text-xs text-violet-900" }, "Geradas a partir das frequências de uso: apoio à conversa com a equipe do AEE, não diagnóstico."),
        sugestoes, copiar),
      bloco("Trajetória semanal", ...trajetoria(resumo.trajetoria)),
      el("div", { class: "grid gap-3 md:grid-cols-2" },
        bloco("Por área de apoio", barras(resumo.por_categoria.filter((c) => c.total))),
        resumo.perfil == null && resumo.por_perfil.length > 1
          ? bloco("Por perfil do material", barras(resumo.por_perfil.map((p) => ({ rotulo: nomesPerfil[p.perfil] || p.perfil, total: p.total }))))
          : null,
        ...resumo.recursos.map((r) => bloco(`${r.rotulo} · ${numero(r.total)}`, barras(r.valores.slice(0, 6))))),
    );
  }

  async function carregar() {
    const parametros = new URLSearchParams({ dias: filtroDias.value });
    if (filtroPerfil.value) parametros.set("perfil", filtroPerfil.value);
    if (filtroEscopo?.checked) parametros.set("escopo", "todos");
    conteudo.setAttribute("aria-busy", "true");
    status.textContent = "Carregando…";
    try {
      await enviarFila(); // inclui o uso mais recente antes de consultar
      const resposta = await fetch(`${ENDPOINT_RESUMO}?${parametros}`, { headers: { Accept: "application/json" } });
      const json = await resposta.json().catch(() => null);
      if (!resposta.ok || !json?.sucesso) throw new Error(json?.erro?.mensagem || `Erro ${resposta.status}`);
      renderizar(json.dados);
      status.textContent = `${numero(json.dados.total_eventos)} interações no período.`;
    } catch (erro) {
      status.textContent = navigator.onLine
        ? `Não foi possível carregar o histórico. ${erro.message || ""}`
        : "Sem conexão: o histórico fica disponível quando a internet voltar. O uso de agora está guardado e será enviado depois.";
    } finally {
      conteudo.setAttribute("aria-busy", "false");
    }
  }

  $("#iris-aee-abrir").addEventListener("click", () => { dialogo.showModal(); carregar(); });
  [filtroDias, filtroPerfil, filtroEscopo].forEach((f) => f?.addEventListener("change", carregar));
  dialogo.querySelectorAll("[data-fechar-aee]").forEach((b) => b.addEventListener("click", () => dialogo.close()));
  dialogo.addEventListener("click", (e) => { if (e.target === dialogo) dialogo.close(); });
})();
