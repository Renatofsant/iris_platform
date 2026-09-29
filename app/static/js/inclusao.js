/**
 * Plataforma Íris — página de adaptação de conteúdos.
 *
 * Módulos:
 *   1. Preferências de leitura (fonte, contraste, tipografia, entrelinhas), salvas no navegador
 *   2. Formulário e chamada à API /api/inclusao/adaptar
 *   3. Renderização segura do material adaptado
 *   4. Leitura em voz alta (Web Speech API)
 *   5. VLibras (carregado sob demanda)
 *   6. Modo edição e impressão
 */

const $ = (seletor, raiz = document) => raiz.querySelector(seletor);

// Sessão expirada: qualquer 401 da API leva de volta ao login, preservando o destino.
const fetchOriginal = window.fetch.bind(window);
window.fetch = async (...argumentos) => {
  const resposta = await fetchOriginal(...argumentos);
  if (resposta.status === 401 && new URL(resposta.url, location.href).origin === location.origin) {
    location.assign(`/login?expirou=1&next=${encodeURIComponent(location.pathname)}`);
  }
  return resposta;
};

const leitor = $("#iris-leitor");
const statusRegiao = $("#iris-status");
const estadoVazioHTML = leitor.innerHTML;

/** Cria elementos com atributos e filhos (texto é sempre inserido como texto, nunca como HTML). */
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

/** Anuncia mensagens para leitores de tela (região aria-live). */
function anunciar(mensagem) {
  statusRegiao.textContent = "";
  window.setTimeout(() => { statusRegiao.textContent = mensagem; }, 60);
}

const armazenamento = {
  ler(chave) {
    try { return JSON.parse(window.localStorage.getItem(chave)); } catch { return null; }
  },
  gravar(chave, valor) {
    try { window.localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* modo privado */ }
  },
};

/* =========================================================================
 * 1. Preferências de leitura
 * ====================================================================== */

const FONTE = { min: 14, max: 36, passo: 2, padrao: 18 };
const ENTRELINHAS = [
  { valor: 1.5, rotulo: "Normal" },
  { valor: 1.8, rotulo: "Ampliado" },
  { valor: 2.0, rotulo: "Máximo" },
];
const TEMAS = ["padrao", "alto-escuro", "alto-azul", "sepia"];
const TIPOGRAFIAS = ["padrao", "atkinson", "dyslexic"];
const NOMES_TEMA = { padrao: "padrão", "alto-escuro": "alto contraste preto e amarelo", "alto-azul": "alto contraste azul", sepia: "sépia" };
const NOMES_TIPOGRAFIA = { padrao: "padrão", atkinson: "Atkinson Hyperlegible", dyslexic: "OpenDyslexic" };
const CHAVE_PREFERENCIAS = "iris:preferencias-leitura:v1";

const controles = {
  menos: $("#iris-fonte-menos"),
  mais: $("#iris-fonte-mais"),
  slider: $("#iris-fonte-slider"),
  valor: $("#iris-fonte-valor"),
  resetar: $("#iris-fonte-resetar"),
  espacamento: $("#iris-espacamento"),
  espacamentoRotulo: $("#iris-espacamento-rotulo"),
};

const limitar = (n, min, max) => Math.min(Math.max(n, min), max);

function carregarPreferencias() {
  const salvo = armazenamento.ler(CHAVE_PREFERENCIAS) || {};
  return {
    fonte: Number.isFinite(salvo.fonte) ? limitar(Math.round(salvo.fonte), FONTE.min, FONTE.max) : FONTE.padrao,
    entrelinhas: ENTRELINHAS.some((e) => e.valor === salvo.entrelinhas) ? salvo.entrelinhas : ENTRELINHAS[0].valor,
    tema: TEMAS.includes(salvo.tema) ? salvo.tema : "padrao",
    tipografia: TIPOGRAFIAS.includes(salvo.tipografia) ? salvo.tipografia : "padrao",
  };
}

const preferencias = carregarPreferencias();

function aplicarPreferencias() {
  const { fonte, entrelinhas, tema, tipografia } = preferencias;

  document.querySelectorAll(".iris-leitor").forEach((painel) => {
    painel.style.setProperty("--iris-fonte", `${fonte}px`);
    painel.style.setProperty("--iris-altura-linha", String(entrelinhas));
    painel.dataset.tema = tema;
    painel.dataset.tipografia = tipografia;
  });

  controles.slider.value = String(fonte);
  controles.slider.setAttribute("aria-valuetext", `${fonte} pixels`);
  controles.valor.textContent = `${fonte}px`;
  // aria-disabled (e não disabled) para o foco não se perder ao atingir o limite.
  controles.menos.setAttribute("aria-disabled", String(fonte <= FONTE.min));
  controles.mais.setAttribute("aria-disabled", String(fonte >= FONTE.max));

  const atual = ENTRELINHAS.find((e) => e.valor === entrelinhas);
  controles.espacamentoRotulo.textContent = `${atual.rotulo} (${atual.valor.toFixed(1)})`;

  document.querySelectorAll('input[name="tema"]').forEach((r) => { r.checked = r.value === tema; });
  document.querySelectorAll('input[name="tipografia"]').forEach((r) => { r.checked = r.value === tipografia; });

  armazenamento.gravar(CHAVE_PREFERENCIAS, preferencias);
}

function definirFonte(novoValor, anunciarMudanca = true) {
  const valor = limitar(Math.round(novoValor), FONTE.min, FONTE.max);
  if (valor === preferencias.fonte) {
    if (anunciarMudanca) anunciar(valor === FONTE.max ? "Tamanho máximo atingido." : "Tamanho mínimo atingido.");
    return;
  }
  preferencias.fonte = valor;
  aplicarPreferencias();
  if (anunciarMudanca) anunciar(`Fonte em ${valor} pixels.`);
}

controles.menos.addEventListener("click", () => definirFonte(preferencias.fonte - FONTE.passo));
controles.mais.addEventListener("click", () => definirFonte(preferencias.fonte + FONTE.passo));
controles.resetar.addEventListener("click", () => {
  preferencias.fonte = FONTE.padrao;
  aplicarPreferencias();
  anunciar(`Fonte restaurada para ${FONTE.padrao} pixels.`);
});
// O slider já comunica o valor via aria-valuetext; não é preciso anunciar a cada passo.
controles.slider.addEventListener("input", () => definirFonte(Number(controles.slider.value), false));

controles.espacamento.addEventListener("click", () => {
  const indice = ENTRELINHAS.findIndex((e) => e.valor === preferencias.entrelinhas);
  const proximo = ENTRELINHAS[(indice + 1) % ENTRELINHAS.length];
  preferencias.entrelinhas = proximo.valor;
  aplicarPreferencias();
  anunciar(`Espaçamento entre linhas ${proximo.rotulo.toLowerCase()}, ${String(proximo.valor).replace(".", ",")}.`);
});

document.querySelectorAll('input[name="tema"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    preferencias.tema = radio.value;
    aplicarPreferencias();
    anunciar(`Contraste ${NOMES_TEMA[radio.value]} aplicado.`);
  });
});

document.querySelectorAll('input[name="tipografia"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    preferencias.tipografia = radio.value;
    aplicarPreferencias();
    anunciar(`Tipografia ${NOMES_TIPOGRAFIA[radio.value]} aplicada.`);
  });
});

aplicarPreferencias();

/* =========================================================================
 * 2. Formulário e API
 * ====================================================================== */

const form = $("#iris-form");
const campoTexto = $("#iris-texto");
const contador = $("#contador-texto");
const botaoEnviar = $("#iris-enviar");
const botaoCancelar = $("#iris-cancelar");
const LIMITE_MIN = Number(form.dataset.minimo) || 20;
const LIMITE_MAX = Number(form.dataset.maximo) || 30000;
const formatarNumero = (n) => n.toLocaleString("pt-BR");

let requisicaoAtual = null;
let ultimoResultado = null;

function atualizarContador() {
  const tamanho = campoTexto.value.length;
  contador.textContent = `${formatarNumero(tamanho)} / ${formatarNumero(LIMITE_MAX)}`;
  contador.classList.toggle("text-rose-700", tamanho > LIMITE_MAX);
  contador.classList.toggle("font-semibold", tamanho > LIMITE_MAX);
}
campoTexto.addEventListener("input", atualizarContador);
atualizarContador();

function mostrarErroCampo(campo, mensagem) {
  const alvo = form.querySelector(`[data-erro-campo="${campo}"]`);
  if (!alvo) return false;
  alvo.textContent = mensagem;
  alvo.classList.remove("hidden");
  if (campo === "texto") {
    campoTexto.setAttribute("aria-invalid", "true");
    campoTexto.focus();
  } else if (campo === "imagem") {
    $("#iris-imagem")?.focus();
  } else if (campo === "perfil") {
    (form.querySelector('input[name="perfil"]:checked') || form.querySelector('input[name="perfil"]'))?.focus();
  }
  return true;
}

function limparErros() {
  form.querySelectorAll("[data-erro-campo]").forEach((p) => { p.textContent = ""; p.classList.add("hidden"); });
  campoTexto.removeAttribute("aria-invalid");
  $("#iris-avisos").replaceChildren();
}

function definirCarregando(ativo) {
  botaoEnviar.disabled = ativo;
  botaoEnviar.querySelector('[data-estado="ocioso"]').classList.toggle("hidden", ativo);
  const carregando = botaoEnviar.querySelector('[data-estado="carregando"]');
  carregando.classList.toggle("hidden", !ativo);
  carregando.classList.toggle("inline-flex", ativo);
  botaoCancelar.classList.toggle("hidden", !ativo);
  botaoCancelar.classList.toggle("inline-flex", ativo);
  leitor.setAttribute("aria-busy", String(ativo));
  if (ativo) {
    esconderAbas();
    leitor.replaceChildren($("#iris-tpl-carregando").content.cloneNode(true));
    definirAcoesMaterial(false);
  }
}

function alerta(tipo, titulo, mensagem) {
  const estilos = {
    erro: "border-rose-200 bg-rose-50 text-rose-900",
    aviso: "border-amber-200 bg-amber-50 text-amber-900",
  };
  return el("div", { class: `mb-4 flex gap-3 rounded-xl border p-4 text-sm ${estilos[tipo]}`, role: tipo === "erro" ? "alert" : null },
    (() => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "mt-0.5 h-5 w-5 shrink-0");
      svg.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", "#i-alerta");
      svg.append(use);
      return svg;
    })(),
    el("div", {}, el("p", { class: "font-semibold" }, titulo), el("p", { class: "mt-0.5" }, mensagem)),
  );
}

function restaurarPreview() {
  if (ultimoResultado) renderizar(ultimoResultado, { focar: false });
  else leitor.innerHTML = estadoVazioHTML;
}

form.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (requisicaoAtual) return;
  limparErros();

  const dados = new FormData(form);
  if (modoEntrada() === "imagem") { await enviarImagem(dados); return; }
  const texto = String(dados.get("texto") || "").trim();
  const perfil = dados.get("perfil");

  if (!perfil) { mostrarErroCampo("perfil", "Escolha um perfil de acessibilidade."); return; }
  if (texto.length < LIMITE_MIN) {
    mostrarErroCampo("texto", texto ? `O texto precisa ter pelo menos ${LIMITE_MIN} caracteres.` : "Cole o conteúdo que deseja adaptar.");
    return;
  }
  if (texto.length > LIMITE_MAX) {
    mostrarErroCampo("texto", `O texto passou do limite de ${formatarNumero(LIMITE_MAX)} caracteres. Divida-o em partes.`);
    return;
  }

  const corpo = { texto, perfil };
  for (const campo of ["disciplina", "tema", "nivel_ensino", "ano_serie"]) {
    const valor = String(dados.get(campo) || "").trim();
    if (valor) corpo[campo] = valor;
  }

  pararLeitura();
  desativarEdicao();
  const nomePerfil = form.querySelector(`input[name="perfil"][value="${perfil}"]`)?.closest("label")?.querySelector(".font-semibold")?.textContent?.trim() || perfil;
  requisicaoAtual = new AbortController();
  definirCarregando(true);
  anunciar(`Adaptando conteúdo para o perfil ${nomePerfil}. Isso pode levar até um minuto.`);

  try {
    const resposta = await fetch(form.dataset.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpo),
      signal: requisicaoAtual.signal,
    });
    let json = null;
    try { json = await resposta.json(); } catch { /* corpo não-JSON */ }

    if (!resposta.ok || !json?.sucesso) {
      restaurarPreview();
      const erro = json?.erro;
      if (erro?.campo && mostrarErroCampo(erro.campo, erro.mensagem)) return;
      $("#iris-avisos").replaceChildren(alerta("erro", "Não foi possível adaptar o conteúdo", erro?.mensagem || `O servidor respondeu com o código ${resposta.status}.`));
      anunciar("Erro ao adaptar o conteúdo.");
      return;
    }
    ultimoResultado = json;
    guardarUltimoMaterial(json);
    renderizar(json);
  } catch (erro) {
    restaurarPreview();
    if (erro.name === "AbortError") {
      anunciar("Adaptação cancelada.");
    } else {
      $("#iris-avisos").replaceChildren(alerta("erro", "Sem conexão com o servidor", "Verifique sua conexão com a internet e tente novamente."));
      anunciar("Erro de conexão.");
    }
  } finally {
    requisicaoAtual = null;
    definirCarregando(false);
  }
});

botaoCancelar.addEventListener("click", () => {
  requisicaoAtual?.abort();
  botaoEnviar.focus();
});

$("#iris-exemplo").addEventListener("click", () => {
  campoTexto.value = TEXTO_EXEMPLO;
  $("#iris-tema").value ||= "Leis de Newton";
  atualizarContador();
  campoTexto.focus();
  anunciar("Texto de exemplo sobre as Leis de Newton inserido.");
});

async function verificarServicoIA() {
  const alvo = $("#iris-status-ia");
  const [ponto, rotulo] = alvo.children;
  const definir = (cor, texto) => { ponto.className = `h-2 w-2 rounded-full ${cor}`; rotulo.textContent = texto; };
  try {
    const resposta = await fetch(form.dataset.endpointSaude, { headers: { Accept: "application/json" } });
    const json = await resposta.json();
    const dados = json?.dados || {};
    alvo.title = dados.provedores?.length ? `Provedores: ${dados.provedores.join(" → ")}` : "";
    if (dados.simulacao) definir("bg-amber-500", "Modo simulação (sem IA)");
    else if (dados.provedores?.length) definir("bg-emerald-500", "IA disponível");
    else definir("bg-amber-500", "Sem IA (regras automáticas)");
  } catch {
    definir("bg-rose-500", "Servidor indisponível");
  }
}
verificarServicoIA();

/* =========================================================================
 * 3. Renderização do material adaptado
 * ====================================================================== */

const ORDEM_BLOCOS = {
  BAIXA_VISAO: ["conteudo", "destaques", "passos", "glossario", "checklist", "audiodescricao", "glossario_ilustrado"],
  DEFICIENCIA_VISUAL_CEGO: ["audiodescricao", "glossario", "passos", "destaques", "checklist"],
  SURDEZ_LIBRAS: ["conteudo", "glossario", "passos", "destaques", "checklist", "audiodescricao", "glossario_ilustrado"],
  TEA_SUPORTE_1_2: ["glossario_ilustrado", "passos", "glossario", "conteudo", "checklist", "destaques", "audiodescricao"],
  TDAH: ["destaques", "checklist", "conteudo", "passos", "glossario", "audiodescricao", "glossario_ilustrado"],
};
const ORDEM_PADRAO = ["conteudo", "destaques", "passos", "glossario", "checklist", "audiodescricao", "glossario_ilustrado"];

let contadorIds = 0;
function secao(chave, titulo, ...conteudo) {
  const id = `iris-bloco-${++contadorIds}`;
  return el("section", { class: "iris-bloco", "aria-labelledby": id, "data-bloco": chave }, el("h4", { id }, titulo), ...conteudo);
}

const normalizar = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** Converte Markdown em nós DOM sanitizados, ajustando a hierarquia de títulos da página. */
function markdownSeguro(markdown, tituloMaterial) {
  const conteiner = document.createElement("div");
  if (window.marked && window.DOMPurify) {
    const html = window.marked.parse(markdown, { gfm: true, breaks: false });
    conteiner.innerHTML = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  } else {
    // Sem as bibliotecas (CDN bloqueado): mostra o texto puro, em parágrafos.
    markdown.split(/\n{2,}/).forEach((bloco) => conteiner.append(el("p", {}, bloco.replace(/^#+\s*/gm, ""))));
  }

  // A página já tem h1 (página), h2 (painel) e h3 (título do material):
  // um H1 igual ao título é removido; os demais títulos descem dois níveis.
  let tituloRemovido = false;
  conteiner.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    const nivel = Number(h.tagName[1]);
    if (nivel === 1 && !tituloRemovido && normalizar(h.textContent) === normalizar(tituloMaterial)) {
      tituloRemovido = true;
      h.remove();
      return;
    }
    const novo = document.createElement(`h${Math.min(nivel + 2, 6)}`);
    novo.append(...h.childNodes);
    h.replaceWith(novo);
  });

  conteiner.querySelectorAll("table").forEach((tabela, i) => {
    const rolagem = el("div", { class: "iris-tabela", tabindex: 0, role: "region", "aria-label": `Tabela ${i + 1}` });
    tabela.replaceWith(rolagem);
    rolagem.append(tabela);
  });
  conteiner.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  // WCAG 1.1.1: imagem sem texto alternativo é sinalizada em vez de ficar muda para o leitor de tela.
  conteiner.querySelectorAll("img:not([alt])").forEach((img) => { img.alt = "Imagem sem descrição textual"; });

  return [...conteiner.childNodes];
}

const CONSTRUTORES = {
  conteudo(dados) {
    if (!dados.conteudo_markdown) return null;
    return el("div", { class: "iris-markdown", "data-bloco": "conteudo" }, markdownSeguro(dados.conteudo_markdown, dados.titulo));
  },
  destaques(dados) {
    if (!dados.destaques?.length) return null;
    return secao("destaques", "Conceitos-chave", el("ul", { class: "iris-destaques" }, dados.destaques.map((d) => el("li", {}, d))));
  },
  passos(dados) {
    if (!dados.passos?.length) return null;
    return secao("passos", `Passo a passo (${dados.passos.length} passos)`,
      el("ol", { class: "iris-passos" }, dados.passos.map((p) => {
        const tituloGenerico = !p.titulo || /^passo\s*\d+$/i.test(p.titulo.trim());
        return el("li", {}, el("div", {},
          tituloGenerico ? null : el("p", { class: "iris-passo-titulo" }, p.titulo),
          el("p", {}, p.descricao)));
      })));
  },
  glossario(dados) {
    if (!dados.glossario?.length) return null;
    return secao("glossario", "Glossário",
      el("dl", { class: "iris-glossario" }, dados.glossario.flatMap((g) => [
        el("dt", {}, g.termo),
        el("dd", {}, g.definicao, g.exemplo ? el("span", { class: "iris-exemplo" }, el("b", {}, "Exemplo: "), g.exemplo) : null),
      ])));
  },
  checklist(dados) {
    if (!dados.checklist?.length) return null;
    return secao("checklist", "Checklist para resolver problemas",
      el("ul", { class: "iris-checklist" }, dados.checklist.map((item) =>
        el("li", {}, el("label", {}, el("input", { type: "checkbox" }), el("span", {}, item))))));
  },
  glossario_ilustrado(dados) {
    if (!dados.glossario_ilustrado?.length) return null;
    return secao("glossario_ilustrado", "Glossário ilustrado",
      el("ul", { class: "iris-ilustrado" }, dados.glossario_ilustrado.map((item) =>
        el("li", { class: "iris-cartao" },
          el("div", { class: "iris-picto", "data-busca": item.pictograma_busca || null, "data-descricao": item.pictograma_descricao || item.conceito },
            el("span", { class: "iris-picto-vazio", "aria-hidden": "true" }, item.conceito.slice(0, 1).toUpperCase())),
          el("div", { class: "iris-cartao-texto" },
            el("p", { class: "iris-conceito" }, item.conceito),
            el("p", { class: "iris-frase" }, item.frase_unica),
            item.pictograma_descricao
              ? el("p", { class: "iris-sugestao" }, el("b", {}, "Imagem sugerida: "), item.pictograma_descricao)
              : null)))),
      el("p", { class: "iris-credito" }, CREDITO_ARASAAC));
  },
  audiodescricao(dados) {
    if (!dados.audiodescricao) return null;
    return secao("audiodescricao", "Audiodescrição pedagógica",
      el("div", { class: "iris-audiodescricao" },
        dados.audiodescricao.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean).map((p) => el("p", {}, p))));
  },
};

function renderizarSelos({ perfil, origem }) {
  const selo = (texto, classes) => el("span", { class: `inline-flex items-center rounded-full px-2 py-0.5 font-medium ${classes}` }, texto);
  $("#iris-selos").replaceChildren(
    selo(perfil.nome, "bg-indigo-50 text-indigo-800 ring-1 ring-inset ring-indigo-200"),
    {
      ia: () => selo("Gerado por IA", "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200"),
      simulacao: () => selo("Simulação (sem IA)", "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300"),
    }[origem]?.() || selo("Regras automáticas", "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-200"),
  );
}

const NOMES_NIVEL = { elementar: "Elementar", basico: "Básico", intermediario: "Intermediário", avancado: "Avançado" };

function renderizarGuia(guia) {
  const caixa = $("#iris-guia");
  if (!guia) { caixa.replaceChildren(); return false; }
  const lista = (titulo, itens) => itens?.length
    ? el("div", {}, el("p", { class: "font-semibold text-slate-900" }, titulo),
      el("ul", { class: "mt-1 list-disc space-y-1 pl-5" }, itens.map((i) => el("li", {}, i))))
    : null;
  const niveis = guia.nivel_original || guia.nivel_adaptado
    ? el("p", {},
      el("span", { class: "font-semibold text-slate-900" }, "Complexidade: "),
      el("span", { class: "rounded-md bg-white px-1.5 py-0.5 ring-1 ring-slate-200" }, NOMES_NIVEL[guia.nivel_original] || "—"),
      " → ",
      el("span", { class: "rounded-md bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-900 ring-1 ring-indigo-200" }, NOMES_NIVEL[guia.nivel_adaptado] || "—"),
      guia.justificativa ? el("span", { class: "mt-1 block text-slate-600" }, guia.justificativa) : null)
    : null;
  caixa.replaceChildren(...[
    niveis,
    lista("Ajustes realizados", guia.ajustes_realizados),
    lista("Sugestões de mediação", guia.sugestoes_mediacao),
    lista("Pontos de atenção", guia.pontos_de_atencao),
  ].filter(Boolean));
  return true;
}

function renderizarNotas({ dados, meta }) {
  const notas = $("#iris-notas");
  const lista = $("#iris-notas-lista");
  const temGuia = renderizarGuia(dados.guia_mediador);
  const habilidades = dados.relatorio_aee?.habilidades_bncc || [];
  if (habilidades.length) {
    $("#iris-guia").append(el("p", {},
      el("span", { class: "font-semibold text-slate-900" }, "Habilidades BNCC: "),
      habilidades.flatMap((h, i) => [i ? " " : "", el("span", {
        class: "rounded-md bg-violet-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-violet-900 ring-1 ring-violet-200",
        title: h.descricao || "Código a conferir na BNCC",
      }, h.codigo)]),
      el("span", { class: "mt-1 block text-slate-600" }, "Detalhes e justificativa no Relatório AEE / BNCC.")));
  }
  lista.replaceChildren(...(dados.observacoes_pedagogicas || []).map((n) => el("li", {}, n)));
  const partesMeta = [];
  if (meta?.modelo) partesMeta.push(`Modelo: ${meta.modelo}`);
  if (Number.isFinite(meta?.tempo_ms)) partesMeta.push(`tempo: ${(meta.tempo_ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`);
  if (meta?.id_requisicao) partesMeta.push(`requisição ${meta.id_requisicao.slice(0, 8)}`);
  $("#iris-notas-meta").textContent = partesMeta.join(" · ");
  $("#iris-notas-rotulo").hidden = !(temGuia && lista.children.length);
  notas.hidden = !temGuia && !lista.children.length && !partesMeta.length;
}

/** Aplica as recomendações mínimas do perfil (ex.: baixa visão ≥ 20px), sem reduzir escolhas do usuário. */
function aplicarRecomendacoes(apresentacao = {}) {
  const ajustes = [];
  const fonteMin = Number(apresentacao.tamanho_fonte_minimo_px);
  if (fonteMin && preferencias.fonte < fonteMin) {
    preferencias.fonte = limitar(fonteMin, FONTE.min, FONTE.max);
    ajustes.push(`fonte ${preferencias.fonte} pixels`);
  }
  const alturaMin = Number(apresentacao.altura_linha);
  if (alturaMin && preferencias.entrelinhas < alturaMin) {
    const alvo = ENTRELINHAS.find((e) => e.valor >= alturaMin) || ENTRELINHAS.at(-1);
    preferencias.entrelinhas = alvo.valor;
    ajustes.push(`espaçamento ${alvo.rotulo.toLowerCase()}`);
  }
  if (ajustes.length) aplicarPreferencias();
  return ajustes;
}

function renderizar(resultado, { focar = true } = {}) {
  if (resultado.tipo_entrada === "imagem") return renderizarImagem(resultado, { focar });
  const { dados, perfil, origem, avisos = [], apresentacao } = resultado;

  const cabecalho = el("header", {},
    el("p", { class: "iris-eyebrow" }, `Material adaptado · ${perfil.nome}`),
    el("h3", { id: "iris-titulo", class: "iris-titulo", tabindex: -1 }, dados.titulo || "Conteúdo adaptado"),
    dados.resumo ? el("p", { class: "iris-resumo", "data-bloco": "resumo" }, dados.resumo) : null,
  );
  const blocos = (ORDEM_BLOCOS[perfil.codigo] || ORDEM_PADRAO)
    .map((chave) => CONSTRUTORES[chave]?.(dados))
    .filter(Boolean);

  leitor.replaceChildren(cabecalho, ...blocos);
  renderizarConsolidacao(dados);
  carregarPictogramas();
  renderizarSelos(resultado);
  renderizarNotas(resultado);
  mostrarAvaliacao(resultado);

  const caixaAvisos = $("#iris-avisos");
  caixaAvisos.replaceChildren();
  if (origem === "fallback") {
    caixaAvisos.append(alerta("aviso", "Adaptação simplificada", avisos[0] || "A IA não respondeu; este material foi gerado por regras automáticas."));
  } else if (origem === "simulacao") {
    caixaAvisos.append(alerta("aviso", "Modo simulação", avisos[0] || "Resposta gerada localmente, sem IA."));
  }

  definirAcoesMaterial(true);
  // Termos em Libras e mapa simplificado (seções 16 e 17) se ajustam ao material novo.
  leitor.dataset.perfil = resultado.perfil?.codigo || ""; // lido pela telemetria AEE (aee_analytics.js)
  document.dispatchEvent(new CustomEvent("iris:material-renderizado"));
  if (!focar) return;

  const ajustes = aplicarRecomendacoes(apresentacao);
  const titulo = $("#iris-titulo");
  titulo.focus({ preventScroll: true });
  // scrollIntoView respeita o scroll-margin-top, então o título não fica sob a barra fixa.
  titulo.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  anunciar(
    `Material adaptado para ${perfil.nome} pronto.` +
    (origem === "fallback" ? " Atenção: gerado sem IA, revise antes de usar." : "") +
    (ajustes.length ? ` Leitura ajustada para o perfil: ${ajustes.join(" e ")}.` : ""),
  );
}

function definirAcoesMaterial(ativas) {
  $("#iris-imprimir").disabled = !ativas;
  $("#iris-relatorio").disabled = !ativas || !ultimoResultado?.dados?.relatorio_aee;
  $("#iris-editar").disabled = !ativas;
  $("#iris-mapa-simples").disabled = !ativas;
  botaoTts.disabled = !ativas || !TTS_SUPORTADO;
}

/* =========================================================================
 * 4. Leitura em voz alta (Web Speech API)
 * ====================================================================== */

const TTS_SUPORTADO = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
const botaoTts = $("#iris-tts");
const botaoTtsParar = $("#iris-tts-parar");
const rotuloTts = $("#iris-tts-rotulo");
const iconeTts = $("#iris-tts-icone");
const seletorVelocidade = $("#iris-tts-velocidade");
let estadoTts = "parado"; // parado | falando | pausado
let sessaoTts = 0;

if (!TTS_SUPORTADO) {
  botaoTts.title = "Seu navegador não oferece leitura em voz alta.";
  rotuloTts.textContent = "Voz indisponível";
  seletorVelocidade.disabled = true;
}

function definirEstadoTts(estado) {
  estadoTts = estado;
  const config = {
    parado: ["Ouvir conteúdo", "#i-play"],
    falando: ["Pausar leitura", "#i-pausa"],
    pausado: ["Continuar leitura", "#i-play"],
  }[estado];
  rotuloTts.textContent = config[0];
  iconeTts.setAttribute("href", config[1]);
  botaoTtsParar.disabled = estado === "parado";
}

function vozPortugues() {
  const vozes = window.speechSynthesis.getVoices();
  const ptBr = vozes.filter((v) => /^pt[-_]BR$/i.test(v.lang));
  return ptBr.find((v) => /natural|online|google|francisca|antonio|luciana/i.test(v.name))
    || ptBr[0]
    || vozes.find((v) => /^pt/i.test(v.lang))
    || null;
}

/** Texto do material pronto para fala: cada linha vira uma frase, com pausa. */
function textoParaFala() {
  // innerText precisa de layout: a cópia sem as fórmulas é medida fora da tela e descartada.
  const origem = painelAtivo();
  const copia = origem.cloneNode(true);
  copia.querySelectorAll("[data-tts-ignorar], mjx-container, .iris-quiz-acoes").forEach((n) => n.remove());
  copia.removeAttribute("id");
  copia.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  copia.setAttribute("aria-hidden", "true");
  copia.style.cssText = `position:absolute;left:-99999px;top:0;width:${origem.clientWidth}px`;
  document.body.append(copia);
  const texto = copia.innerText;
  copia.remove();
  return texto
    .split("\n")
    .map((linha) => linha.trim())
    .filter(Boolean)
    .map((linha) => (/[.!?:;…]$/.test(linha) ? linha : `${linha}.`))
    .join(" ");
}

/** Divide em trechos curtos: o Chrome interrompe falas longas (cerca de 15 s). */
function dividirEmTrechos(texto, limite = 220) {
  const frases = texto.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) || [texto];
  const trechos = [];
  let atual = "";
  for (const frase of frases.map((f) => f.trim())) {
    if (frase.length > limite) {
      if (atual) { trechos.push(atual); atual = ""; }
      let resto = frase;
      while (resto.length > limite) {
        const corte = Math.max(resto.lastIndexOf(",", limite), resto.lastIndexOf(" ", limite), Math.floor(limite / 2));
        trechos.push(resto.slice(0, corte + 1).trim());
        resto = resto.slice(corte + 1);
      }
      atual = resto.trim();
    } else if ((`${atual} ${frase}`).length > limite) {
      trechos.push(atual);
      atual = frase;
    } else {
      atual = atual ? `${atual} ${frase}` : frase;
    }
  }
  if (atual) trechos.push(atual);
  return trechos.filter(Boolean);
}

function iniciarLeitura() {
  const texto = textoParaFala();
  if (!texto) { anunciar("Não há conteúdo para ler."); return; }

  window.speechSynthesis.cancel();
  document.dispatchEvent(new CustomEvent("iris:leitura-inicio")); // a Íris Voice se cala
  const sessao = ++sessaoTts;
  const trechos = dividirEmTrechos(texto);
  let indice = 0;

  const falarProximo = () => {
    if (sessao !== sessaoTts) return;
    if (indice >= trechos.length) { definirEstadoTts("parado"); anunciar("Leitura concluída."); return; }
    const fala = new SpeechSynthesisUtterance(trechos[indice++]);
    fala.lang = "pt-BR";
    const voz = vozPortugues();
    if (voz) fala.voice = voz;
    fala.rate = Number(seletorVelocidade.value) || 1;
    fala.onend = falarProximo;
    fala.onerror = (evento) => {
      if (sessao !== sessaoTts || ["interrupted", "canceled"].includes(evento.error)) return;
      definirEstadoTts("parado");
      anunciar("A leitura em voz alta foi interrompida.");
    };
    window.speechSynthesis.speak(fala);
  };

  definirEstadoTts("falando");
  falarProximo();
}

function pararLeitura() {
  if (!TTS_SUPORTADO) return;
  sessaoTts++;
  window.speechSynthesis.cancel();
  definirEstadoTts("parado");
}

botaoTts.addEventListener("click", () => {
  if (!TTS_SUPORTADO) return;
  if (estadoTts === "parado") {
    iniciarLeitura();
  } else if (estadoTts === "falando") {
    window.speechSynthesis.pause();
    definirEstadoTts("pausado");
  } else {
    window.speechSynthesis.resume();
    definirEstadoTts("falando");
  }
});
botaoTtsParar.addEventListener("click", () => { pararLeitura(); anunciar("Leitura interrompida."); botaoTts.focus(); });
// A Íris Voice (static/js/iris-voz.js) vai falar: a leitura do painel para, com o botão sincronizado.
document.addEventListener("iris:voz-fala", () => { if (estadoTts !== "parado") pararLeitura(); });
if (TTS_SUPORTADO) {
  window.speechSynthesis.getVoices(); // alguns navegadores só carregam as vozes após a primeira chamada
  window.addEventListener("pagehide", () => window.speechSynthesis.cancel());
}

/* =========================================================================
 * 5. VLibras (widget oficial do Governo Federal, carregado sob demanda)
 * ====================================================================== */

const VLIBRAS_URL = "https://vlibras.gov.br/app";
const botaoVlibras = $("#iris-vlibras");
const estadoVlibras = $("#iris-vlibras-estado");
let vlibrasCarregando = null;
let observadorVlibras = null;

function atualizarBotaoVlibras(ativo) {
  botaoVlibras.setAttribute("aria-pressed", String(ativo));
  estadoVlibras.textContent = ativo ? "Ligado" : "Desligado";
}

function esperar(condicao, tempoMaximo = 8000, intervalo = 100) {
  return new Promise((resolver, rejeitar) => {
    const inicio = Date.now();
    const verificar = () => {
      const valor = condicao();
      if (valor) resolver(valor);
      else if (Date.now() - inicio > tempoMaximo) rejeitar(new Error("tempo esgotado"));
      else window.setTimeout(verificar, intervalo);
    };
    verificar();
  });
}

function carregarVlibras() {
  vlibrasCarregando ||= new Promise((resolver, rejeitar) => {
    const script = document.createElement("script");
    script.src = `${VLIBRAS_URL}/vlibras-plugin.js`;
    script.async = true;
    script.onload = () => {
      try {
        new window.VLibras.Widget(VLIBRAS_URL);
        esperar(() => typeof window.VLibrasWidget?.open === "function").then(resolver, rejeitar);
      } catch (erro) { rejeitar(erro); }
    };
    script.onerror = () => rejeitar(new Error("falha ao carregar o VLibras"));
    document.head.append(script);
  }).catch((erro) => { vlibrasCarregando = null; throw erro; });
  return vlibrasCarregando;
}

/** Mantém o botão sincronizado quando o usuário fecha o VLibras pela interface do próprio widget. */
function observarVlibras(raiz) {
  if (observadorVlibras) return;
  observadorVlibras = new MutationObserver(() => {
    const ativo = raiz.dataset.active === "true" && raiz.style.display !== "none";
    atualizarBotaoVlibras(ativo);
  });
  observadorVlibras.observe(raiz, { attributes: true, attributeFilter: ["data-active", "style"] });
}

/** Carrega (se preciso) e abre o VLibras. Usado pelo botão flutuante e pelos atalhos dos termos (seção 16). */
async function abrirVlibras() {
  const raiz = document.getElementById("vlibras-app-root");
  await carregarVlibras();
  if (raiz) raiz.style.display = "";
  window.VLibrasWidget.open();
  const raizCarregada = await esperar(() => document.getElementById("vlibras-app-root"));
  raizCarregada.style.display = "";
  observarVlibras(raizCarregada);
  atualizarBotaoVlibras(true);
}

botaoVlibras.addEventListener("click", async () => {
  const ativo = botaoVlibras.getAttribute("aria-pressed") === "true";
  const raiz = document.getElementById("vlibras-app-root");

  if (ativo) {
    if (raiz) { raiz.dataset.active = "false"; raiz.style.display = "none"; }
    atualizarBotaoVlibras(false);
    anunciar("Tradução para Libras desativada.");
    return;
  }

  botaoVlibras.setAttribute("aria-busy", "true");
  estadoVlibras.textContent = "Carregando…";
  try {
    await abrirVlibras();
    anunciar("Tradução para Libras ativada. Selecione um trecho de texto para traduzir.");
  } catch {
    atualizarBotaoVlibras(false);
    anunciar("Não foi possível carregar o VLibras. Verifique a conexão.");
  } finally {
    botaoVlibras.removeAttribute("aria-busy");
  }
});

/* =========================================================================
 * 6. Edição pelo professor e impressão
 * ====================================================================== */

const botaoEditar = $("#iris-editar");

function desativarEdicao() {
  document.querySelectorAll(".iris-leitor").forEach((painel) => {
    painel.removeAttribute("contenteditable");
    painel.removeAttribute("aria-describedby");
  });
  botaoEditar.setAttribute("aria-pressed", "false");
}

botaoEditar.addEventListener("click", () => {
  const ativar = botaoEditar.getAttribute("aria-pressed") !== "true";
  if (ativar) {
    document.querySelectorAll(".iris-leitor").forEach((painel) => {
      painel.setAttribute("contenteditable", "true");
      painel.setAttribute("aria-describedby", "dica-editar");
    });
    botaoEditar.setAttribute("aria-pressed", "true");
    anunciar("Modo edição ativado. As alterações valem para a leitura em voz alta e a impressão.");
  } else {
    desativarEdicao();
    anunciar("Modo edição desativado.");
  }
});

let tituloOriginal = document.title;
window.addEventListener("beforeprint", () => {
  tituloOriginal = document.title;
  const titulo = $("#iris-titulo")?.textContent?.trim();
  if (ultimoResultado && titulo) document.title = `${titulo} - ${ultimoResultado.perfil.nome}`; // nome do PDF
});
window.addEventListener("afterprint", () => { document.title = tituloOriginal; });

/* =========================================================================
 * 7. Exportação para impressão (modal → /inclusao/imprimir/<id>)
 * ====================================================================== */

const dialogoExportar = $("#iris-exportar");
const formExportar = $("#iris-exportar-form");
const campoExp = (nome) => formExportar.elements.namedItem(nome);
const ENDPOINT_MATERIAIS = "/api/inclusao/materiais";
const CHAVE_ULTIMO_MATERIAL = "iris:ultimo-material:v1";
const VALIDADE_ULTIMO_MATERIAL_MS = 30 * 24 * 60 * 60 * 1000;
const CHAVE_CABECALHO_ESCOLAR = "iris:cabecalho-escolar:v1"; // compartilhada com a página de impressão
const CAMPOS_CABECALHO = ["escola", "aluno", "turma", "data", "disciplina", "professor"];
const CAMPOS_LEMBRADOS = ["escola", "turma", "disciplina", "professor"]; // nome do aluno não é salvo
const NOMES_BLOCOS = {
  resumo: "Resumo",
  quiz: "Quiz & Desafios",
  curiosidades: "Curiosidades",
  exemplos: "Exemplos práticos",
  experimento: "Experimento sensorial",
  mapa: "Mapa conceitual (descrição)",
  gabarito: "Gabarito (página do professor)",
  conteudo: "Texto adaptado",
  destaques: "Conceitos-chave",
  passos: "Passo a passo",
  glossario: "Glossário",
  checklist: "Checklist",
  audiodescricao: "Audiodescrição",
  glossario_ilustrado: "Glossário ilustrado",
  equacoes: "Equações",
  significado: "Significado físico",
  variaveis: "Variáveis",
  eixos: "Eixos do gráfico",
  transcricao: "Texto da imagem",
};

function sincronizarAtalhosFonte() {
  const valor = Number(campoExp("fonte_pt").value);
  formExportar.querySelectorAll("[data-exp-fonte]").forEach((b) => {
    b.setAttribute("aria-pressed", String(Number(b.dataset.expFonte) === valor));
  });
  campoExp("colunas").querySelector('option[value="2"]').disabled = valor > 16;
  if (valor > 16) campoExp("colunas").value = "1";
}

function mostrarErroExportacao(mensagem, campo) {
  const alvo = campo && formExportar.querySelector(`[data-exp-erro="${campo}"]`);
  const caixa = alvo || $("#exp-erro-geral");
  caixa.textContent = mensagem;
  caixa.classList.remove("hidden");
  if (alvo) campoExp(campo.split(".").pop())?.focus();
}

function limparEstadoExportacao() {
  formExportar.querySelectorAll("[data-exp-erro], #exp-erro-geral").forEach((p) => { p.textContent = ""; p.classList.add("hidden"); });
  $("#exp-sucesso").classList.add("hidden");
}

function prepararExportacao() {
  limparEstadoExportacao();

  // Cabeçalho: o que foi lembrado neste navegador + data de hoje.
  const salvos = armazenamento.ler(CHAVE_CABECALHO_ESCOLAR) || {};
  for (const nome of CAMPOS_LEMBRADOS) if (salvos[nome]) campoExp(nome).value = salvos[nome];
  if (!campoExp("data").value) campoExp("data").value = new Date().toLocaleDateString("pt-BR");

  // Preferências: parte da leitura atual; para baixa visão, no mínimo 24 pt.
  const fontePt = Math.round(preferencias.fonte * 0.75);
  const minimoPerfil = ultimoResultado?.perfil?.codigo === "BAIXA_VISAO" ? 24 : 12;
  campoExp("fonte_pt").value = String(limitar(Math.max(fontePt, minimoPerfil), 12, 60));
  campoExp("tipografia").value = preferencias.tipografia;
  campoExp("entrelinhas").value = preferencias.entrelinhas.toFixed(1);
  if (alunoSelecionado) {
    campoExp("aluno").value = alunoSelecionado.nome_aluno;
    if (alunoSelecionado.turma) campoExp("turma").value = alunoSelecionado.turma;
    campoExp("fonte_pt").value = String(alunoSelecionado.tamanho_fonte_pref);
    const contraste = alunoSelecionado.contraste_pref.startsWith("alto") ? "pb-alto" : "padrao";
    formExportar.querySelector(`input[name="contraste"][value="${contraste}"]`).checked = true;
  }
  sincronizarAtalhosFonte();

  const temGuia = Boolean(ultimoResultado?.dados?.guia_mediador);
  $("#exp-guia-opcao").classList.toggle("hidden", !temGuia); // classe: "flex" venceria o atributo hidden
  formExportar.elements.namedItem("incluir_guia").checked = false;

  // Blocos presentes no material atual, todos marcados.
  const caixa = $("#exp-blocos");
  caixa.replaceChildren(...[...document.querySelectorAll(".iris-leitor [data-bloco]")].map((bloco) => {
    const chave = bloco.dataset.bloco;
    return el("label", { class: "flex items-center gap-2 text-sm text-slate-800" },
      // O gabarito é do professor: só entra na folha (em página separada) se ele marcar.
      el("input", { type: "checkbox", name: "blocos", value: chave, checked: chave !== "gabarito", class: "h-4 w-4 rounded border-slate-300 accent-indigo-600" }),
      NOMES_BLOCOS[chave] || chave);
  }));
}

/** Converte o material exibido (inclusive edições do professor) em HTML limpo para a folha. */
function serializarMaterial(blocosIncluidos) {
  const clone = leitor.cloneNode(true);
  const titulo = clone.querySelector("#iris-titulo")?.textContent.trim() || "Material adaptado";
  clone.querySelector("header")?.replaceWith(...[...clone.querySelector("header").children].filter((n) => n.matches(".iris-resumo")));
  clone.querySelectorAll("[data-bloco]").forEach((bloco) => {
    if (!blocosIncluidos.includes(bloco.dataset.bloco)) bloco.remove();
  });
  const conteiner = document.createElement("div");
  conteiner.append(...clone.childNodes);

  // Quiz e curiosidades entram na folha do aluno; o gabarito vai em página própria, marcada para o professor.
  for (const chave of ["quiz", "curiosidades", "experimento", "mapa", "gabarito"]) {
    const copia = paineis[chave].cloneNode(true);
    copia.querySelector("header")?.remove();
    copia.querySelectorAll("[data-bloco]").forEach((bloco) => {
      if (!blocosIncluidos.includes(bloco.dataset.bloco)) bloco.remove();
    });
    if (!copia.querySelector("[data-bloco]")) continue;
    const secao = el("section", { class: chave === "gabarito" ? "iris-pagina-professor" : "iris-consolidacao" });
    if (chave === "gabarito") secao.append(el("p", { class: "iris-instrucao" }, "Página do professor — não entregar ao estudante."));
    secao.append(...copia.childNodes);
    conteiner.append(secao);
  }
  prepararParaImpressao(conteiner);
  return { titulo, html: conteiner.innerHTML.trim() };
}

function prepararParaImpressao(raiz) {
  raiz.querySelectorAll(".iris-math[data-latex]").forEach((m) => {
    m.textContent = m.classList.contains("iris-math-bloco") ? `\\[${m.dataset.latex}\\]` : `\\(${m.dataset.latex}\\)`;
  });
  // Só servem na tela: imagem local, código LaTeX, botões e retorno do quiz.
  raiz.querySelectorAll(".iris-figura-upload, .iris-codigo-latex, .iris-quiz-acoes, .iris-mapa-grafico, .iris-codigo-mermaid").forEach((n) => n.remove());

  // Caixas de seleção viram quadrados para marcar à caneta.
  raiz.querySelectorAll(".iris-checklist label").forEach((rotulo) => {
    const item = el("span", { class: "iris-item" }, el("span", { class: "iris-caixa" }));
    rotulo.querySelectorAll("input").forEach((i) => i.remove());
    item.append(...rotulo.childNodes);
    rotulo.replaceWith(item);
  });
  // Quiz no papel: enunciado em parágrafo e alternativas com círculo para marcar.
  raiz.querySelectorAll(".iris-questao fieldset").forEach((grupo) => {
    const legenda = grupo.querySelector("legend");
    const enunciado = el("p", { class: "iris-enunciado" });
    enunciado.append(...legenda.childNodes);
    legenda.replaceWith(enunciado);
    grupo.replaceWith(...grupo.childNodes);
  });
  raiz.querySelectorAll(".iris-alternativas label").forEach((rotulo) => {
    rotulo.querySelector("input")?.replaceWith(el("span", { class: "iris-bolinha" }));
    rotulo.replaceWith(...rotulo.childNodes);
  });
  // Na folha, o título do material é h1: os títulos internos sobem dois níveis (h4 → h2).
  raiz.querySelectorAll("h3, h4, h5, h6").forEach((h) => {
    const novo = document.createElement(`h${Math.max(Number(h.tagName[1]) - 2, 2)}`);
    novo.append(...h.childNodes);
    h.replaceWith(novo);
  });
  // Atributos só úteis na tela (o servidor também descarta o que não estiver na lista).
  raiz.querySelectorAll("*").forEach((n) => {
    for (const { name } of [...n.attributes]) if (!["class", "href", "colspan", "rowspan", "scope", "start", "src", "alt", "width", "height"].includes(name)) n.removeAttribute(name);
  });
}

function codificarCabecalho(dados) {
  const bytes = new TextEncoder().encode(JSON.stringify(dados));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

$("#iris-imprimir").addEventListener("click", () => {
  pararLeitura();
  desativarEdicao();
  prepararExportacao();
  dialogoExportar.showModal();
});

dialogoExportar.querySelectorAll("[data-fechar-dialogo]").forEach((botao) => {
  botao.addEventListener("click", () => dialogoExportar.close());
});
// Clique no fundo escurecido fecha o modal.
dialogoExportar.addEventListener("click", (evento) => {
  if (evento.target === dialogoExportar) dialogoExportar.close();
});

formExportar.querySelectorAll("[data-exp-fonte]").forEach((botao) => {
  botao.addEventListener("click", () => {
    campoExp("fonte_pt").value = botao.dataset.expFonte;
    sincronizarAtalhosFonte();
  });
});
campoExp("fonte_pt").addEventListener("input", sincronizarAtalhosFonte);

for (const nome of CAMPOS_LEMBRADOS) {
  campoExp(nome).addEventListener("input", () => {
    const dados = armazenamento.ler(CHAVE_CABECALHO_ESCOLAR) || {};
    dados[nome] = campoExp(nome).value.trim();
    armazenamento.gravar(CHAVE_CABECALHO_ESCOLAR, dados);
  });
}

$("#exp-rapida").addEventListener("click", () => {
  dialogoExportar.close();
  window.print();
});

/** Valida o modal e grava o material no servidor. Retorna os dados do material ou null (erro já exibido). */
async function salvarMaterialParaExportar() {
  const fontePt = Number(campoExp("fonte_pt").value);
  if (!Number.isInteger(fontePt) || fontePt < 12 || fontePt > 60) {
    mostrarErroExportacao("Informe um tamanho de fonte inteiro entre 12 e 60 pt.", "preferencias.fonte_pt");
    return null;
  }
  const blocos = [...formExportar.querySelectorAll('input[name="blocos"]:checked')].map((c) => c.value);
  if (!blocos.length) {
    mostrarErroExportacao("Selecione pelo menos uma parte do material para incluir na folha.");
    return null;
  }
  const { titulo, html } = serializarMaterial(blocos);
  const resposta = await fetch(ENDPOINT_MATERIAIS, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      titulo,
      perfil: { codigo: ultimoResultado?.perfil?.codigo || "DESCONHECIDO", nome: ultimoResultado?.perfil?.nome || "" },
      conteudo_html: html,
      guia_mediador: ultimoResultado?.dados?.guia_mediador || null,
      preferencias: {
        fonte_pt: fontePt,
        contraste: formExportar.querySelector('input[name="contraste"]:checked')?.value || "pb-alto",
        tipografia: campoExp("tipografia").value,
        entrelinhas: Number(campoExp("entrelinhas").value),
        colunas: Number(campoExp("colunas").value),
        linhas_resposta: limitar(Math.round(Number(campoExp("linhas_resposta").value) || 0), 0, 30),
        incluir_guia: campoExp("incluir_guia").checked ? 1 : 0,
      },
    }),
  });
  const json = await resposta.json().catch(() => null);
  if (!resposta.ok || !json?.sucesso) {
    mostrarErroExportacao(json?.erro?.mensagem || `Erro ${resposta.status} ao salvar o material.`, json?.erro?.campo);
    return null;
  }
  return json.dados;
}

const cabecalhoExportacao = () => Object.fromEntries(CAMPOS_CABECALHO.map((nome) => [nome, campoExp(nome).value.trim()]));

/** Salva a resposta (arquivo) no computador, com o nome enviado pelo servidor. */
async function salvarDownload(resposta, nomePadrao) {
  const nome = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(resposta.headers.get("Content-Disposition") || "")?.[1] || nomePadrao;
  const url = URL.createObjectURL(await resposta.blob());
  const link = el("a", { href: url, download: decodeURIComponent(nome), hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return nome;
}

/**
 * HTML da folha → texto puro com a estrutura que importa no braille: um bloco por linha,
 * linha em branco entre seções, marcadores de lista ("- ", "1. ") e células de tabela separadas.
 */
function htmlParaTextoBraille(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const raiz = doc.body.firstElementChild;
  // Espaços do código-fonte não são quebras de linha do conteúdo.
  const caminhante = doc.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
  for (let no = caminhante.nextNode(); no; no = caminhante.nextNode()) {
    if (!no.parentElement.closest("pre")) no.nodeValue = no.nodeValue.replace(/\s+/g, " ");
  }
  raiz.querySelectorAll("img").forEach((img) => img.replaceWith(img.alt ? ` [${img.alt}] ` : " "));
  raiz.querySelectorAll(".iris-caixa, .iris-bolinha").forEach((n) => n.replaceWith("( ) "));
  raiz.querySelectorAll("ol").forEach((lista) => {
    let n = Number(lista.getAttribute("start")) || 1;
    lista.querySelectorAll(":scope > li").forEach((li) => li.prepend(`${n++}. `));
  });
  raiz.querySelectorAll("ul > li").forEach((li) => li.prepend("- "));
  raiz.querySelectorAll("td, th").forEach((celula) => { if (celula.nextElementSibling) celula.append("; "); });
  raiz.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  raiz.querySelectorAll("p, li, tr, dt, dd, blockquote, pre, figcaption, caption, div").forEach((b) => { b.prepend("\n"); b.append("\n"); });
  raiz.querySelectorAll("h1, h2, h3, h4, h5, h6, section, header, table, hr").forEach((b) => { b.prepend("\n\n"); b.append("\n\n"); });
  return raiz.textContent
    .split("\n").map((linha) => linha.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

$("#exp-braille").addEventListener("click", async () => {
  limparEstadoExportacao();
  const blocos = [...formExportar.querySelectorAll('input[name="blocos"]:checked')].map((c) => c.value);
  if (!blocos.length) {
    mostrarErroExportacao("Selecione pelo menos uma parte do material para incluir no arquivo braille.");
    return;
  }
  const botao = $("#exp-braille");
  botao.disabled = true;
  $("#exp-braille-rotulo").textContent = "Transcrevendo…";
  try {
    const { titulo, html } = serializarMaterial(blocos);
    const resposta = await fetch("/api/inclusao/braille", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titulo, texto: htmlParaTextoBraille(html), formato: "brf" }),
    });
    if (!resposta.ok) {
      const json = await resposta.json().catch(() => null);
      throw new Error(json?.erro?.mensagem || `Erro ${resposta.status} ao gerar o arquivo braille.`);
    }
    const nome = await salvarDownload(resposta, "material-braille.brf");
    $("#exp-sucesso-titulo").textContent = `Arquivo ${decodeURIComponent(nome)} baixado (braille grau 1, 40 celas × 25 linhas). Revise com o transcritor do AEE antes de imprimir.`;
    $("#exp-sucesso-link").hidden = true;
    $("#exp-sucesso").classList.remove("hidden");
    anunciar("Arquivo braille baixado.");
    document.dispatchEvent(new CustomEvent("iris:exportacao", { detail: { formato: "braille" } }));
  } catch (erro) {
    mostrarErroExportacao(navigator.onLine
      ? (erro.message || "Não foi possível gerar o arquivo braille.")
      : "Sem conexão: a transcrição braille é feita no servidor. Tente quando a internet voltar.");
  } finally {
    botao.disabled = false;
    $("#exp-braille-rotulo").textContent = "Baixar em Formato Braille (.BRF)";
  }
});

/** Baixa o .docx de um material salvo. O cabeçalho vai no corpo só para montar o arquivo. */
async function baixarDocx(urlDocx, cabecalho, preferenciasExtras = {}) {
  const resposta = await fetch(urlDocx, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cabecalho, preferencias: preferenciasExtras }),
  });
  if (!resposta.ok) throw new Error(`Erro ${resposta.status} ao gerar o Word.`);
  return salvarDownload(resposta, "material-adaptado.docx");
}

formExportar.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  limparEstadoExportacao();
  const cabecalho = cabecalhoExportacao();

  // A aba é aberta já no clique (antes do await) para não ser bloqueada como pop-up.
  const janela = window.open("", "_blank");
  if (janela) {
    janela.opener = null;
    janela.document.title = "Preparando impressão…";
    janela.document.body.textContent = "Preparando a versão para impressão…";
  }

  const botao = $("#exp-gerar");
  botao.disabled = true;
  $("#exp-gerar-rotulo").textContent = "Gerando…";
  try {
    const material = await salvarMaterialParaExportar();
    if (!material) { janela?.close(); return; }
    // O cabeçalho vai no fragmento (#): o navegador não o envia ao servidor.
    const url = `${material.url_impressao}#cab=${codificarCabecalho(cabecalho)}`;
    $("#exp-sucesso-titulo").textContent = "Versão para impressão pronta.";
    $("#exp-sucesso-link").hidden = false;
    $("#exp-link").href = url;
    $("#exp-sucesso").classList.remove("hidden");
    if (janela) janela.location.replace(url);
    document.dispatchEvent(new CustomEvent("iris:exportacao", { detail: { formato: "impressao" } }));
    anunciar(janela ? "Versão para impressão aberta em uma nova aba." : "Versão para impressão pronta. Use o link no aviso para abri-la.");
  } catch {
    janela?.close();
    mostrarErroExportacao("Sem conexão com o servidor. Tente novamente.");
  } finally {
    botao.disabled = false;
    $("#exp-gerar-rotulo").textContent = "Impressão / PDF";
  }
});

$("#exp-docx").addEventListener("click", async () => {
  limparEstadoExportacao();
  const botao = $("#exp-docx");
  botao.disabled = true;
  $("#exp-docx-rotulo").textContent = "Gerando Word…";
  try {
    const material = await salvarMaterialParaExportar();
    if (!material) return;
    const nome = await baixarDocx(material.url_docx, cabecalhoExportacao());
    $("#exp-sucesso-titulo").textContent = `Arquivo ${decodeURIComponent(nome)} baixado.`;
    $("#exp-sucesso-link").hidden = true;
    $("#exp-sucesso").classList.remove("hidden");
    anunciar("Arquivo Word baixado.");
    document.dispatchEvent(new CustomEvent("iris:exportacao", { detail: { formato: "docx" } }));
  } catch (erro) {
    mostrarErroExportacao(erro.message || "Não foi possível gerar o arquivo Word.");
  } finally {
    botao.disabled = false;
    $("#exp-docx-rotulo").textContent = "Baixar Word (.docx)";
  }
});

/* =========================================================================
 * Texto de exemplo
 * ====================================================================== */

const TEXTO_EXEMPLO = `# Leis de Newton

## Primeira Lei: Princípio da Inércia
Todo corpo permanece em seu estado de repouso ou de movimento retilíneo uniforme, a menos que seja compelido a modificar esse estado pela ação de uma força resultante não nula. Em outras palavras, a inércia é a resistência que a matéria oferece à mudança de seu estado de movimento.

## Segunda Lei: Princípio Fundamental da Dinâmica
A força resultante que atua sobre um corpo é igual ao produto de sua massa pela aceleração adquirida: F = m · a. A unidade de força no Sistema Internacional é o newton (N), que corresponde a 1 kg · m/s².

| Massa (kg) | Força resultante (N) | Aceleração (m/s²) |
|---|---|---|
| 2 | 10 | 5 |
| 4 | 10 | 2,5 |
| 5 | 20 | 4 |

## Terceira Lei: Ação e Reação
A toda ação corresponde uma reação de mesma intensidade, mesma direção e sentido oposto. As forças de ação e reação atuam em corpos diferentes e, por isso, nunca se anulam.`;

/* =========================================================================
 * 8. Imagens e equações de Física (visão + MathJax)
 * ====================================================================== */

const LIMITE_IMAGEM = Number(form.dataset.limiteImagem) || 3_750_000;
const LADO_MAXIMO_IMAGEM = 1568; // acima disso a própria API reduz a imagem: reduzir antes poupa upload
const TIPOS_ACEITOS = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const NOMES_TIPO_IMAGEM = { equacao: "Equação", grafico: "Gráfico", diagrama: "Diagrama", tabela: "Tabela", outro: "Imagem" };
const campoImagem = $("#iris-imagem");
let imagemPreparada = null; // { blob, url, nome }

const modoEntrada = () => form.querySelector('input[name="modo"]:checked')?.value || "texto";

function aplicarModoEntrada() {
  const imagem = modoEntrada() === "imagem";
  $("#iris-bloco-texto").hidden = imagem;
  $("#iris-bloco-imagem").hidden = !imagem;
  $("#iris-bloco-perfil").hidden = imagem;
  botaoEnviar.querySelector('[data-estado="ocioso"] [data-rotulo]').textContent = imagem ? "Analisar imagem" : "Adaptar conteúdo";
}
form.querySelectorAll('input[name="modo"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    aplicarModoEntrada();
    limparErros();
    anunciar(radio.value === "imagem"
      ? "Modo imagem: envie um diagrama, gráfico ou equação de Física."
      : "Modo texto: cole o conteúdo a adaptar.");
  });
});

/** Reduz imagens grandes no navegador (mantém PNG para equações nítidas). */
async function prepararImagem(arquivo) {
  if (!TIPOS_ACEITOS.includes(arquivo.type)) throw new Error("Formato não suportado. Use PNG, JPEG, GIF ou WEBP.");
  let blob = arquivo;
  try {
    const bitmap = await createImageBitmap(arquivo);
    const escala = Math.min(1, LADO_MAXIMO_IMAGEM / Math.max(bitmap.width, bitmap.height));
    if (escala < 1 || arquivo.size > LIMITE_IMAGEM) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * escala);
      canvas.height = Math.round(bitmap.height * escala);
      const ctx = canvas.getContext("2d");
      if (arquivo.type !== "image/png") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const tipo = arquivo.type === "image/png" ? "image/png" : "image/jpeg";
      blob = await new Promise((ok) => canvas.toBlob(ok, tipo, 0.92));
    }
    bitmap.close?.();
  } catch {
    /* navegador sem createImageBitmap para o formato: envia o original */
  }
  if (!blob || blob.size > LIMITE_IMAGEM) throw new Error("A imagem é grande demais mesmo após a redução. Recorte a área de interesse.");
  return blob;
}

async function selecionarImagem(arquivo) {
  limparErros();
  if (!arquivo) return;
  try {
    const blob = await prepararImagem(arquivo);
    if (imagemPreparada) URL.revokeObjectURL(imagemPreparada.url);
    imagemPreparada = { blob, url: URL.createObjectURL(blob), nome: arquivo.name };
    $("#iris-imagem-miniatura").src = imagemPreparada.url;
    $("#iris-imagem-nome").textContent = `${arquivo.name} · ${(blob.size / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} KB`;
    $("#iris-imagem-previa").hidden = false;
    $("#iris-imagem-soltar").hidden = true;
    anunciar(`Imagem ${arquivo.name} pronta para análise.`);
  } catch (erro) {
    campoImagem.value = "";
    mostrarErroCampo("imagem", erro.message);
  }
}

campoImagem.addEventListener("change", () => selecionarImagem(campoImagem.files[0]));
$("#iris-imagem-remover").addEventListener("click", () => {
  if (imagemPreparada) URL.revokeObjectURL(imagemPreparada.url);
  imagemPreparada = null;
  campoImagem.value = "";
  $("#iris-imagem-previa").hidden = true;
  $("#iris-imagem-soltar").hidden = false;
  campoImagem.focus();
  anunciar("Imagem removida.");
});
const zonaSoltar = $("#iris-imagem-soltar");
["dragenter", "dragover"].forEach((tipo) => zonaSoltar.addEventListener(tipo, (e) => {
  e.preventDefault();
  zonaSoltar.dataset.arrastando = "true";
}));
["dragleave", "drop"].forEach((tipo) => zonaSoltar.addEventListener(tipo, () => { delete zonaSoltar.dataset.arrastando; }));
zonaSoltar.addEventListener("drop", (e) => {
  e.preventDefault();
  selecionarImagem(e.dataTransfer.files[0]);
});
// Colar uma captura de tela (Ctrl+V) no modo imagem.
document.addEventListener("paste", (e) => {
  if (modoEntrada() !== "imagem") return;
  const arquivo = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (arquivo) { e.preventDefault(); selecionarImagem(arquivo); }
});

async function enviarImagem(dadosFormulario) {
  if (!imagemPreparada) { mostrarErroCampo("imagem", "Escolha, arraste ou cole uma imagem de Física."); return; }
  const corpo = new FormData();
  corpo.append("imagem", imagemPreparada.blob, imagemPreparada.nome);
  for (const campo of ["disciplina", "tema", "nivel_ensino", "ano_serie"]) {
    const valor = String(dadosFormulario.get(campo) || "").trim();
    if (valor) corpo.append(campo, valor);
  }

  pararLeitura();
  desativarEdicao();
  requisicaoAtual = new AbortController();
  definirCarregando(true);
  anunciar("Analisando a imagem. Isso pode levar até um minuto.");
  try {
    const resposta = await fetch(form.dataset.endpointImagem, { method: "POST", body: corpo, signal: requisicaoAtual.signal });
    const json = await resposta.json().catch(() => null);
    if (!resposta.ok || !json?.sucesso) {
      restaurarPreview();
      const erro = json?.erro;
      if (erro?.campo && mostrarErroCampo(erro.campo, erro.mensagem)) return;
      $("#iris-avisos").replaceChildren(alerta("erro", "Não foi possível analisar a imagem",
        (erro?.mensagem || `O servidor respondeu com o código ${resposta.status}.`) +
        (erro?.retentavel ? " Tente novamente em instantes." : "")));
      anunciar("Erro ao analisar a imagem.");
      return;
    }
    json.perfil = { codigo: "IMAGEM_EQUACAO", nome: "Imagem ou equação" };
    json.imagemUrl = imagemPreparada.url;
    ultimoResultado = json;
    await renderizarImagem(json);
  } catch (erro) {
    restaurarPreview();
    if (erro.name === "AbortError") anunciar("Análise cancelada.");
    else {
      $("#iris-avisos").replaceChildren(alerta("erro", "Sem conexão com o servidor", "Verifique sua conexão com a internet e tente novamente."));
      anunciar("Erro de conexão.");
    }
  } finally {
    requisicaoAtual = null;
    definirCarregando(false);
  }
}

/* ---------- MathJax (carregado só quando há equações) ---------- */

let mathJaxPronto = null;
function carregarMathJax() {
  mathJaxPronto ||= new Promise((resolver, rejeitar) => {
    window.MathJax = {
      tex: { inlineMath: [["\\(", "\\)"]], displayMath: [["\\[", "\\]"]] },
      options: { enableMenu: false },
      chtml: { scale: 1 },
      startup: { typeset: false },
    };
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js";
    script.async = true;
    script.onload = () => window.MathJax.startup.promise.then(resolver, rejeitar);
    script.onerror = () => { mathJaxPronto = null; rejeitar(new Error("MathJax indisponível")); };
    document.head.append(script);
  });
  return mathJaxPronto;
}

async function renderizarMatematica(raiz) {
  if (!raiz.querySelector(".iris-math")) return;
  try {
    await carregarMathJax();
    await window.MathJax.typesetPromise([raiz]);
  } catch {
    // Sem MathJax, o LaTeX continua legível como texto.
  }
}

/** Fórmula com o LaTeX original preservado (para exportar e imprimir). */
function formula(latex, bloco = true) {
  return el("span", {
    class: bloco ? "iris-math iris-math-bloco" : "iris-math",
    "data-latex": latex,
    "data-tts-ignorar": true,
  }, bloco ? `\\[${latex}\\]` : `\\(${latex}\\)`);
}

async function renderizarImagem(resultado, { focar = true } = {}) {
  esconderAbas();
  const { dados, avisos = [] } = resultado;
  const tipo = NOMES_TIPO_IMAGEM[dados.tipo] || "Imagem";

  const blocos = [];
  if (resultado.imagemUrl) {
    blocos.push(el("figure", { class: "iris-figura-upload" },
      el("img", { src: resultado.imagemUrl, alt: dados.descricao_curta || dados.titulo })));
  }
  if (dados.equacoes.length) {
    blocos.push(secao("equacoes", dados.equacoes.length > 1 ? "Equações" : "Equação",
      el("ol", { class: "iris-equacoes" }, dados.equacoes.map((eq) => el("li", {},
        formula(eq.latex),
        eq.leitura_por_extenso ? el("p", { class: "iris-leitura" }, el("b", {}, "Leitura: "), eq.leitura_por_extenso) : null,
        el("details", { class: "iris-codigo-latex", "data-tts-ignorar": true },
          el("summary", {}, "Código LaTeX"),
          el("code", {}, eq.latex)))))));
  }
  if (dados.audiodescricao) {
    blocos.push(secao("audiodescricao", "Audiodescrição pedagógica",
      el("div", { class: "iris-audiodescricao" },
        dados.audiodescricao.split(/\n+/).map((p) => p.trim()).filter(Boolean).map((p) => el("p", {}, p)))));
  }
  if (dados.significado_fisico) {
    blocos.push(secao("significado", "Significado físico", el("p", {}, dados.significado_fisico)));
  }
  if (dados.variaveis.length) {
    blocos.push(secao("variaveis", "Variáveis",
      el("dl", { class: "iris-glossario" }, dados.variaveis.flatMap((v) => [
        el("dt", {}, v.simbolo_latex ? formula(v.simbolo_latex, false) : null, v.simbolo_latex ? " — " : "", v.nome),
        el("dd", {}, [v.significado, v.unidade_si ? `Unidade: ${v.unidade_si}.` : ""].filter(Boolean).join(" ")),
      ]))));
  }
  if (dados.eixos.length) {
    blocos.push(secao("eixos", "Eixos do gráfico",
      el("ul", {}, dados.eixos.map((e) => el("li", {},
        el("b", {}, `Eixo ${e.eixo}: `),
        [e.grandeza, e.unidade && `em ${e.unidade}`, e.escala && `(${e.escala})`].filter(Boolean).join(" "))))));
  }
  if (dados.texto_transcrito) {
    blocos.push(secao("transcricao", "Texto presente na imagem", el("blockquote", {}, dados.texto_transcrito)));
  }

  leitor.replaceChildren(
    el("header", {},
      el("p", { class: "iris-eyebrow" }, `Imagem analisada · ${tipo} · confiança ${{ alta: "alta", media: "média", baixa: "baixa" }[dados.confianca]}`),
      el("h3", { id: "iris-titulo", class: "iris-titulo", tabindex: -1 }, dados.titulo),
      dados.descricao_curta ? el("p", { class: "iris-resumo", "data-bloco": "resumo" }, dados.descricao_curta) : null),
    ...blocos,
  );
  await renderizarMatematica(leitor);

  renderizarSelos(resultado);
  renderizarNotas({ dados: { observacoes_pedagogicas: dados.observacoes }, meta: resultado.meta });
  $("#iris-avisos").replaceChildren(...avisos.map((a, i) =>
    alerta("aviso", i === 0 && dados.confianca !== "alta" ? "Confira a leitura" : "Revisão recomendada", a)));
  definirAcoesMaterial(true);
  mostrarAvaliacao(resultado);
  leitor.dataset.perfil = resultado.perfil?.codigo || ""; // lido pela telemetria AEE (aee_analytics.js)
  document.dispatchEvent(new CustomEvent("iris:material-renderizado"));
  if (!focar) return;
  const titulo = $("#iris-titulo");
  titulo.focus({ preventScroll: true });
  titulo.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  anunciar(`Imagem analisada (${tipo.toLowerCase()}): ${dados.titulo}. Revise o LaTeX e a audiodescrição antes de usar.`);
}

/* =========================================================================
 * 9. Pictogramas ARASAAC (glossário ilustrado — TEA)
 * ====================================================================== */

const CREDITO_ARASAAC = "Pictogramas: Sergio Palao. Origem: ARASAAC (arasaac.org). Licença: CC BY-NC-SA. Propriedade: Governo de Aragão (Espanha).";
const cachePictogramas = new Map();

async function buscarPictograma(termo) {
  const chave = termo.trim().toLowerCase();
  if (!chave) return null;
  if (!cachePictogramas.has(chave)) {
    cachePictogramas.set(chave, (async () => {
      const controle = new AbortController();
      const limite = window.setTimeout(() => controle.abort(), 6000);
      try {
        const resposta = await fetch(`https://api.arasaac.org/v1/pictograms/pt/search/${encodeURIComponent(chave)}`, { signal: controle.signal });
        if (!resposta.ok) return null;
        const lista = await resposta.json();
        const id = Array.isArray(lista) ? lista[0]?._id : null;
        return Number.isInteger(id) ? `https://static.arasaac.org/pictograms/${id}/${id}_300.png` : null;
      } catch {
        return null;
      } finally {
        window.clearTimeout(limite);
      }
    })());
  }
  return cachePictogramas.get(chave);
}

function carregarPictogramas(raiz = leitor) {
  raiz.querySelectorAll(".iris-picto[data-busca]").forEach(async (caixa) => {
    const url = await buscarPictograma(caixa.dataset.busca);
    if (!url || !caixa.isConnected) return; // sem pictograma: fica a descrição textual
    const img = el("img", { src: url, alt: `Pictograma: ${caixa.dataset.descricao}`, width: 300, height: 300, loading: "lazy" });
    img.addEventListener("error", () => img.remove());
    caixa.replaceChildren(img);
  });
}

/* =========================================================================
 * 10. Alunos atípicos: seletor rápido e gerenciamento
 * ====================================================================== */

const ENDPOINT_ALUNOS = form.dataset.endpointAlunos;
const seletorAluno = $("#iris-aluno");
const dialogoAlunos = $("#iris-alunos");
const formAluno = $("#iris-aluno-form");
let alunos = [];
let alunoSelecionado = null;
const NOMES_CONTRASTE = { padrao: "padrão", "alto-escuro": "preto e amarelo", "alto-azul": "azul", sepia: "sépia" };

async function carregarAlunos() {
  try {
    const resposta = await fetch(ENDPOINT_ALUNOS, { headers: { Accept: "application/json" } });
    const json = await resposta.json();
    alunos = json?.dados || [];
  } catch {
    alunos = [];
  }
  renderizarSeletorAlunos();
  renderizarListaAlunos();
}

function renderizarSeletorAlunos() {
  const valorAtual = seletorAluno.value;
  const turmas = new Map();
  for (const aluno of alunos) {
    const turma = aluno.turma || "Sem turma";
    if (!turmas.has(turma)) turmas.set(turma, []);
    turmas.get(turma).push(aluno);
  }
  seletorAluno.replaceChildren(
    el("option", { value: "" }, alunos.length ? "Nenhum (preferências manuais)" : "Nenhum aluno cadastrado"),
    ...[...turmas].map(([turma, lista]) => el("optgroup", { label: turma },
      lista.map((a) => el("option", { value: a.id }, a.nome_aluno)))),
  );
  seletorAluno.value = alunos.some((a) => String(a.id) === valorAtual) ? valorAtual : "";
  if (!seletorAluno.value) alunoSelecionado = null;
}

function aplicarAluno(aluno) {
  alunoSelecionado = aluno;
  if (!aluno) { anunciar("Nenhum aluno selecionado."); return; }
  const radioPerfil = form.querySelector(`input[name="perfil"][value="${aluno.perfil_acessibilidade}"]`);
  if (radioPerfil) radioPerfil.checked = true;
  // Preferência em pt (impressão) → px na tela: 1 pt = 4/3 px.
  preferencias.fonte = limitar(Math.round(aluno.tamanho_fonte_pref * 4 / 3), FONTE.min, FONTE.max);
  preferencias.tema = TEMAS.includes(aluno.contraste_pref) ? aluno.contraste_pref : "padrao";
  aplicarPreferencias();
  const nomePerfil = radioPerfil?.closest("label")?.querySelector(".font-semibold")?.textContent?.trim() || aluno.perfil_acessibilidade;
  $("#iris-aluno-resumo").textContent =
    `${nomePerfil} · ${aluno.tamanho_fonte_pref} pt · contraste ${NOMES_CONTRASTE[aluno.contraste_pref] || aluno.contraste_pref}`;
  anunciar(`Preferências de ${aluno.nome_aluno} aplicadas: perfil ${nomePerfil}, fonte ${aluno.tamanho_fonte_pref} pontos.`);
}

seletorAluno.addEventListener("change", () => {
  const aluno = alunos.find((a) => String(a.id) === seletorAluno.value) || null;
  $("#iris-aluno-resumo").textContent = "";
  aplicarAluno(aluno);
});

/* ---------- Gerenciar alunos (modal) ---------- */

const campoAluno = (nome) => formAluno.elements.namedItem(nome);

function limparFormAluno() {
  formAluno.reset();
  campoAluno("id").value = "";
  $("#aluno-form-titulo").textContent = "Novo aluno";
  $("#aluno-salvar").textContent = "Adicionar aluno";
  $("#aluno-cancelar-edicao").hidden = true;
  formAluno.querySelectorAll("[data-aluno-erro]").forEach((p) => { p.textContent = ""; p.classList.add("hidden"); });
}

function renderizarListaAlunos() {
  const lista = $("#iris-alunos-lista");
  if (!alunos.length) {
    lista.replaceChildren(el("li", { class: "rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-600" },
      "Nenhum aluno cadastrado ainda."));
    return;
  }
  lista.replaceChildren(...alunos.map((a) => el("li", { class: "flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3" },
    el("div", { class: "min-w-0" },
      el("p", { class: "truncate text-sm font-semibold text-slate-900" }, a.nome_aluno),
      el("p", { class: "text-xs text-slate-600" },
        [a.turma, a.perfil_acessibilidade.replaceAll("_", " "), `${a.tamanho_fonte_pref} pt`].filter(Boolean).join(" · "))),
    el("div", { class: "flex shrink-0 gap-1" },
      el("button", { type: "button", "data-editar-aluno": a.id, "aria-label": `Editar ${a.nome_aluno}`,
        class: "h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" }, "Editar"),
      el("button", { type: "button", "data-excluir-aluno": a.id, "aria-label": `Excluir ${a.nome_aluno}`,
        class: "h-9 rounded-lg px-3 text-sm font-medium text-rose-700 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500" }, "Excluir")),
  )));
}

$("#iris-gerenciar-alunos").addEventListener("click", () => {
  limparFormAluno();
  renderizarListaAlunos();
  dialogoAlunos.showModal();
});
dialogoAlunos.querySelectorAll("[data-fechar-alunos]").forEach((b) => b.addEventListener("click", () => dialogoAlunos.close()));
dialogoAlunos.addEventListener("click", (e) => { if (e.target === dialogoAlunos) dialogoAlunos.close(); });
$("#aluno-cancelar-edicao").addEventListener("click", () => { limparFormAluno(); campoAluno("nome_aluno").focus(); });

$("#iris-alunos-lista").addEventListener("click", async (evento) => {
  const editar = evento.target.closest("[data-editar-aluno]");
  const excluir = evento.target.closest("[data-excluir-aluno]");
  if (editar) {
    const aluno = alunos.find((a) => String(a.id) === editar.dataset.editarAluno);
    if (!aluno) return;
    limparFormAluno();
    for (const campo of ["id", "nome_aluno", "turma", "perfil_acessibilidade", "tamanho_fonte_pref", "contraste_pref", "observacoes_pedagogicas"]) {
      campoAluno(campo).value = aluno[campo] ?? "";
    }
    $("#aluno-form-titulo").textContent = `Editar ${aluno.nome_aluno}`;
    $("#aluno-salvar").textContent = "Salvar alterações";
    $("#aluno-cancelar-edicao").hidden = false;
    campoAluno("nome_aluno").focus();
  } else if (excluir) {
    const aluno = alunos.find((a) => String(a.id) === excluir.dataset.excluirAluno);
    if (!aluno || !window.confirm(`Excluir ${aluno.nome_aluno}? Esta ação não pode ser desfeita.`)) return;
    const resposta = await fetch(`${ENDPOINT_ALUNOS}/${aluno.id}`, { method: "DELETE" }).catch(() => null);
    if (resposta?.ok) {
      await carregarAlunos();
      $("#aluno-status").textContent = `${aluno.nome_aluno} excluído.`;
      campoAluno("nome_aluno").focus();
    } else {
      $("#aluno-status").textContent = "Não foi possível excluir. Tente novamente.";
    }
  }
});

formAluno.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  formAluno.querySelectorAll("[data-aluno-erro]").forEach((p) => { p.textContent = ""; p.classList.add("hidden"); });
  const id = campoAluno("id").value;
  const corpo = {
    nome_aluno: campoAluno("nome_aluno").value.trim(),
    turma: campoAluno("turma").value.trim(),
    perfil_acessibilidade: campoAluno("perfil_acessibilidade").value,
    tamanho_fonte_pref: Number(campoAluno("tamanho_fonte_pref").value),
    contraste_pref: campoAluno("contraste_pref").value,
    observacoes_pedagogicas: campoAluno("observacoes_pedagogicas").value.trim(),
  };
  if (!corpo.nome_aluno) {
    const p = formAluno.querySelector('[data-aluno-erro="nome_aluno"]');
    p.textContent = "Informe o nome, as iniciais ou um código do aluno.";
    p.classList.remove("hidden");
    campoAluno("nome_aluno").focus();
    return;
  }
  const resposta = await fetch(id ? `${ENDPOINT_ALUNOS}/${id}` : ENDPOINT_ALUNOS, {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(corpo),
  }).catch(() => null);
  const json = await resposta?.json().catch(() => null);
  if (!resposta?.ok || !json?.sucesso) {
    const campo = json?.erro?.campo;
    const alvo = campo && formAluno.querySelector(`[data-aluno-erro="${campo}"]`);
    const mensagem = json?.erro?.mensagem || "Não foi possível salvar. Verifique a conexão.";
    if (alvo) { alvo.textContent = mensagem; alvo.classList.remove("hidden"); campoAluno(campo)?.focus(); }
    else $("#aluno-status").textContent = mensagem;
    return;
  }
  await carregarAlunos();
  if (alunoSelecionado && String(alunoSelecionado.id) === String(json.dados.id)) aplicarAluno(json.dados);
  $("#aluno-status").textContent = id ? `${json.dados.nome_aluno} atualizado.` : `${json.dados.nome_aluno} adicionado.`;
  limparFormAluno();
  campoAluno("nome_aluno").focus();
});

/* =========================================================================
 * 11. Avaliação do professor (métricas de uso)
 * ====================================================================== */

const formAvaliacao = $("#iris-avaliacao");
let metricaAtual = null;

function pintarEstrelas(valor) {
  formAvaliacao.querySelectorAll("[data-estrela]").forEach((rotulo) => {
    rotulo.dataset.ativa = String(Number(rotulo.dataset.estrela) <= valor);
  });
}

function mostrarAvaliacao(resultado) {
  metricaAtual = resultado?.meta?.metrica_id || null;
  formAvaliacao.hidden = !metricaAtual;
  if (!metricaAtual) return;
  formAvaliacao.reset();
  pintarEstrelas(0);
  $("#avaliacao-status").textContent = "";
  $("#avaliacao-enviar").textContent = "Enviar avaliação";
}

formAvaliacao.querySelectorAll('input[name="nota"]').forEach((radio) => {
  radio.addEventListener("change", () => pintarEstrelas(Number(radio.value)));
});
formAvaliacao.querySelectorAll("[data-estrela]").forEach((rotulo) => {
  rotulo.addEventListener("mouseenter", () => pintarEstrelas(Number(rotulo.dataset.estrela)));
  rotulo.addEventListener("mouseleave", () => pintarEstrelas(Number(formAvaliacao.querySelector('input[name="nota"]:checked')?.value || 0)));
});

formAvaliacao.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const status = $("#avaliacao-status");
  const nota = Number(formAvaliacao.querySelector('input[name="nota"]:checked')?.value);
  if (!nota) {
    status.textContent = "Escolha de 1 a 5 estrelas.";
    formAvaliacao.querySelector('input[name="nota"]').focus();
    return;
  }
  const minutosBrutos = formAvaliacao.elements.namedItem("minutos").value.trim();
  const minutos = minutosBrutos === "" ? null : Number(minutosBrutos);
  if (minutos !== null && (!Number.isFinite(minutos) || minutos < 0 || minutos > 1440)) {
    status.textContent = "Informe o tempo em minutos, de 0 a 1440.";
    formAvaliacao.elements.namedItem("minutos").focus();
    return;
  }
  const resposta = await fetch(`${form.dataset.endpointMetricas}/${encodeURIComponent(metricaAtual)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ nota_avaliacao_professor: nota, tempo_manual_estimado_min: minutos === null ? null : Math.round(minutos) }),
  }).catch(() => null);
  const json = await resposta?.json().catch(() => null);
  if (!resposta?.ok || !json?.sucesso) {
    status.textContent = json?.erro?.mensagem || "Não foi possível registrar a avaliação. Tente novamente.";
    return;
  }
  const poupado = json.dados.tempo_estimado_poupado_min;
  status.textContent = "Obrigado! Avaliação registrada." +
    (poupado ? ` Tempo estimado poupado: ${poupado.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} min.` : "");
  $("#avaliacao-enviar").textContent = "Atualizar avaliação";
});

aplicarModoEntrada();
carregarAlunos();

/* =========================================================================
 * 12. Histórico do professor (materiais exportados)
 * ====================================================================== */

const dialogoHistorico = $("#iris-historico-dialogo");

async function carregarHistorico() {
  const lista = $("#iris-historico-lista");
  lista.replaceChildren(el("li", { class: "text-sm text-slate-600" }, "Carregando…"));
  const resposta = await fetch(ENDPOINT_MATERIAIS, { headers: { Accept: "application/json" } }).catch(() => null);
  const json = await resposta?.json().catch(() => null);
  const materiais = json?.dados || [];
  if (!resposta?.ok) {
    lista.replaceChildren(el("li", { class: "text-sm text-rose-800" }, "Não foi possível carregar o histórico."));
    return;
  }
  if (!materiais.length) {
    lista.replaceChildren(el("li", { class: "rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-600" },
      "Você ainda não exportou nenhum material."));
    return;
  }
  const data = (iso) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  lista.replaceChildren(...materiais.map((m) => el("li", { class: "flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3" },
    el("div", { class: "min-w-0" },
      el("p", { class: "truncate text-sm font-semibold text-slate-900" }, m.titulo),
      el("p", { class: "text-xs text-slate-600" }, `${m.perfil_nome} · ${data(m.criado_em)} · expira em ${data(m.expira_em)}`)),
    el("div", { class: "flex shrink-0 gap-1" },
      el("a", { href: m.url_impressao, target: "_blank", rel: "noopener", "aria-label": `Abrir ${m.titulo} para impressão`,
        class: "inline-flex h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" }, "Abrir"),
      el("button", { type: "button", "data-excluir-material": m.id, "aria-label": `Excluir ${m.titulo}`,
        class: "h-9 rounded-lg px-3 text-sm font-medium text-rose-700 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500" }, "Excluir")),
  )));
}

$("#iris-historico").addEventListener("click", async () => {
  $("#historico-status").textContent = "";
  dialogoHistorico.showModal();
  await carregarHistorico();
});
dialogoHistorico.querySelectorAll("[data-fechar-historico]").forEach((b) => b.addEventListener("click", () => dialogoHistorico.close()));
dialogoHistorico.addEventListener("click", (e) => { if (e.target === dialogoHistorico) dialogoHistorico.close(); });

$("#iris-historico-lista").addEventListener("click", async (evento) => {
  const botao = evento.target.closest("[data-excluir-material]");
  if (!botao || !window.confirm("Excluir este material do histórico? O link de impressão deixará de funcionar.")) return;
  const resposta = await fetch(`${ENDPOINT_MATERIAIS}/${encodeURIComponent(botao.dataset.excluirMaterial)}`, { method: "DELETE" }).catch(() => null);
  $("#historico-status").textContent = resposta?.ok ? "Material excluído." : "Não foi possível excluir. Tente novamente.";
  await carregarHistorico();
  $("#iris-historico-dialogo [data-fechar-historico]").focus();
});

/* =========================================================================
 * 13. Consolidação: abas, quiz interativo, gabarito, curiosidades, experimento e mapa conceitual
 * ====================================================================== */

const LETRAS = ["A", "B", "C", "D"];
const paineis = {
  quiz: $("#iris-leitor-quiz"),
  gabarito: $("#iris-leitor-gabarito"),
  curiosidades: $("#iris-leitor-curiosidades"),
  experimento: $("#iris-leitor-experimento"),
  mapa: $("#iris-leitor-mapa"),
};
const abas = [...document.querySelectorAll('#iris-abas [role="tab"]')];
let gabaritoAtual = {};

/** Painel (article) visível na aba selecionada: é o que a voz lê e o que o modo edição altera. */
function painelAtivo() {
  const aba = abas.find((a) => a.getAttribute("aria-selected") === "true");
  return aba ? $(`#${aba.getAttribute("aria-controls")} .iris-leitor`) : leitor;
}

function selecionarAba(aba, { focar = false } = {}) {
  pararLeitura();
  for (const outra of abas) {
    const ativa = outra === aba;
    outra.setAttribute("aria-selected", String(ativa));
    outra.tabIndex = ativa ? 0 : -1;
    $(`#${outra.getAttribute("aria-controls")}`).hidden = !ativa;
  }
  if (focar) aba.focus();
}

abas.forEach((aba, indice) => {
  aba.addEventListener("click", () => selecionarAba(aba));
  // Padrão ARIA de abas: setas, Home e End movem entre as abas visíveis.
  aba.addEventListener("keydown", (evento) => {
    const visiveis = abas.filter((a) => !a.classList.contains("hidden"));
    const atual = visiveis.indexOf(aba);
    const destino = {
      ArrowRight: visiveis[(atual + 1) % visiveis.length],
      ArrowLeft: visiveis[(atual - 1 + visiveis.length) % visiveis.length],
      Home: visiveis[0],
      End: visiveis.at(-1),
    }[evento.key];
    if (destino) {
      evento.preventDefault();
      selecionarAba(destino, { focar: true });
    }
  });
});

function esconderAbas() {
  selecionarAba(abas[0]);
  $("#iris-abas").classList.add("hidden");
  Object.values(paineis).forEach((p) => p.replaceChildren());
}

/** Converte **negrito** (usado pelo perfil TDAH) em <strong>, sem interpretar HTML. */
function negritoSeguro(texto) {
  return String(texto).split(/\*\*(.+?)\*\*/g).map((parte, i) => (i % 2 ? el("strong", {}, parte) : parte));
}

function cabecalhoPainel(titulo, id, instrucao) {
  return el("header", {},
    el("p", { class: "iris-eyebrow" }, "Consolidação"),
    el("h3", { class: "iris-titulo", id, tabindex: -1 }, titulo),
    instrucao ? el("p", { class: "iris-instrucao-tela" }, instrucao) : null);
}

function renderizarQuiz({ quiz = [] }) {
  if (!quiz.length) { paineis.quiz.replaceChildren(); return 0; }
  paineis.quiz.replaceChildren(
    cabecalhoPainel("Quiz & Desafios Interativos", "titulo-quiz",
      "Escolha uma alternativa em cada questão e clique em “Conferir”. Você pode tentar de novo."),
    el("section", { class: "iris-bloco", "data-bloco": "quiz", "aria-labelledby": "secao-quiz" },
      el("h4", { id: "secao-quiz" }, "Quiz: teste o que você aprendeu"),
      el("ol", { class: "iris-quiz" }, quiz.map((q) => el("li", { class: "iris-questao" },
        el("fieldset", { "aria-describedby": `fb-${q.numero}` },
          el("legend", { class: "iris-enunciado" }, el("span", { class: "iris-num" }, `Questão ${q.numero}. `), negritoSeguro(q.enunciado)),
          el("ul", { class: "iris-alternativas" }, LETRAS.map((letra) => el("li", {},
            el("label", {},
              el("input", { type: "radio", name: `questao-${q.numero}`, value: letra }),
              el("span", { class: "iris-letra" }, `${letra})`),
              el("span", {}, negritoSeguro(q.alternativas[letra])))))),
          el("div", { class: "iris-quiz-acoes" },
            el("button", { type: "button", class: "iris-botao-conferir", "data-conferir": q.numero }, "Conferir"),
            el("p", { class: "iris-feedback", id: `fb-${q.numero}`, role: "status" }))))))),
  );
  return quiz.length;
}

function renderizarGabarito({ quiz = [], gabarito = [] }) {
  gabaritoAtual = Object.fromEntries(gabarito.map((g) => [g.numero, g]));
  if (!gabarito.length) { paineis.gabarito.replaceChildren(); return 0; }
  const enunciados = Object.fromEntries(quiz.map((q) => [q.numero, q]));
  paineis.gabarito.replaceChildren(
    cabecalhoPainel("Gabarito do Professor", "titulo-gabarito", "Uso do professor: respostas corretas com explicação simples."),
    el("section", { class: "iris-bloco", "data-bloco": "gabarito", "aria-labelledby": "secao-gabarito" },
      el("h4", { id: "secao-gabarito" }, "Gabarito comentado"),
      el("ol", { class: "iris-gabarito" }, gabarito.map((g) => {
        const questao = enunciados[g.numero];
        return el("li", {},
          el("p", { class: "iris-gabarito-resposta" },
            el("strong", {}, `Questão ${g.numero}: alternativa ${g.alternativa_correta}`),
            questao ? ` — ${questao.alternativas[g.alternativa_correta].replace(/\*\*/g, "")}` : ""),
          el("p", {}, g.comentario));
      }))),
  );
  return gabarito.length;
}

function renderizarCuriosidades({ curiosidades = [], exemplos_praticos: exemplos = [] }) {
  if (!curiosidades.length && !exemplos.length) { paineis.curiosidades.replaceChildren(); return 0; }
  paineis.curiosidades.replaceChildren(
    cabecalhoPainel("Curiosidades e Mundo Real", "titulo-curiosidades"),
    curiosidades.length ? el("section", { class: "iris-bloco", "data-bloco": "curiosidades", "aria-labelledby": "secao-curiosidades" },
      el("h4", { id: "secao-curiosidades" }, "Curiosidades & Fenômenos do Dia a Dia"),
      el("ul", { class: "iris-curiosidades" }, curiosidades.map((c) => el("li", { class: "iris-curiosidade" },
        el("p", { class: "iris-curiosidade-titulo" }, c.titulo),
        el("p", {}, c.texto))))) : null,
    exemplos.length ? el("section", { class: "iris-bloco", "data-bloco": "exemplos", "aria-labelledby": "secao-exemplos" },
      el("h4", { id: "secao-exemplos" }, "Exemplos práticos"),
      el("ul", { class: "iris-exemplos" }, exemplos.map((e) => el("li", { class: "iris-exemplo-pratico" },
        el("p", { class: "iris-curiosidade-titulo" },
          e.titulo, " ", el("span", { class: "iris-etiqueta" }, e.tipo === "experimento" ? "Experimento" : "Para imaginar")),
        el("p", {}, e.descricao),
        e.materiais.length ? el("p", {}, el("b", {}, "Materiais: "), e.materiais.join(", "), ".") : null,
        e.cuidados ? el("p", { class: "iris-cuidados" }, el("b", {}, "Cuidados: "), e.cuidados) : null)))) : null,
  );
  return curiosidades.length + exemplos.length;
}

const NOMES_SENTIDOS = { tato: "Tato", audicao: "Audição", visao: "Visão", movimento: "Movimento do corpo" };

function listaRoteiro(titulo, id, itens, ordenada = false) {
  if (!itens?.length) return null;
  return el("div", { class: "iris-roteiro-parte" },
    el("h5", { id }, titulo),
    el(ordenada ? "ol" : "ul", {}, itens.map((i) => el("li", {}, i))));
}

function renderizarExperimento({ roteiro_experimento: r }) {
  if (!r) { paineis.experimento.replaceChildren(); return 0; }
  const fichas = [
    r.duracao_minutos ? ["Duração", `cerca de ${r.duracao_minutos} min`] : null,
    r.custo_estimado ? ["Custo", r.custo_estimado] : null,
    r.sentidos.length ? ["Sentidos", r.sentidos.map((s) => NOMES_SENTIDOS[s] || s).join(", ")] : null,
  ].filter(Boolean);
  paineis.experimento.replaceChildren(
    cabecalhoPainel("Experimento Prático de Baixo Custo", "titulo-experimento",
      "Roteiro para a turma toda, com estímulos táteis, sonoros e visuais."),
    el("section", { class: "iris-bloco", "data-bloco": "experimento", "aria-labelledby": "secao-experimento" },
      el("h4", { id: "secao-experimento" }, r.titulo),
      r.conceito_fisico ? el("p", { class: "iris-cuidados" }, el("b", {}, "Conceito: "), r.conceito_fisico) : null,
      r.objetivo ? el("p", {}, el("b", {}, "Objetivo: "), r.objetivo) : null,
      fichas.length ? el("dl", { class: "iris-fichas" }, fichas.map(([rotulo, valor]) =>
        el("div", {}, el("dt", {}, rotulo), el("dd", {}, valor)))) : null,
      listaRoteiro("Materiais", "exp-materiais", r.materiais),
      listaRoteiro("Antes da aula", "exp-preparacao", r.preparacao),
      listaRoteiro("Passo a passo", "exp-passos", r.passos, true),
      listaRoteiro("O que perceber (sentir, ouvir, ver)", "exp-perceber", r.o_que_perceber),
      r.explicacao ? el("div", { class: "iris-roteiro-parte" }, el("h5", {}, "A Física por trás"), el("p", {}, r.explicacao)) : null,
      r.adaptacao_perfil ? el("p", { class: "iris-roteiro-destaque" }, el("b", {}, "Para este perfil: "), r.adaptacao_perfil) : null,
      r.seguranca ? el("p", { class: "iris-cuidados" }, el("b", {}, "Segurança: "), r.seguranca) : null),
  );
  return 1;
}

/* ---------- Mapa conceitual (Mermaid.js, importado do CDN sob demanda) ---------- */

let mermaidCarregando = null;
let renderizacaoMapa = 0;

function carregarMermaid() {
  mermaidCarregando ||= import($("#painel-mapa").dataset.mermaidSrc).then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict", // sem HTML nem cliques vindos do código gerado pela IA
      suppressErrorRendering: true,
      theme: "neutral",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    });
    return mermaid;
  }).catch((erro) => { mermaidCarregando = null; throw erro; });
  return mermaidCarregando;
}

async function desenharMapa(codigo, destino) {
  const minha = ++renderizacaoMapa;
  const id = `iris-mapa-svg-${minha}`;
  try {
    const mermaid = await carregarMermaid();
    const { svg } = await mermaid.render(id, codigo);
    if (minha !== renderizacaoMapa) return; // chegou um material mais novo
    destino.innerHTML = svg;
    const grafico = destino.querySelector("svg");
    grafico?.setAttribute("aria-hidden", "true"); // o equivalente acessível é a descrição textual
    grafico?.removeAttribute("style");
    destino.dataset.estado = "pronto";
  } catch {
    if (minha !== renderizacaoMapa) return;
    document.getElementById(`d${id}`)?.remove();
    destino.dataset.estado = "erro";
    destino.replaceChildren(
      el("p", {}, "Não foi possível desenhar o mapa. Confira a descrição abaixo ou o código Mermaid."));
  }
}

function renderizarMapa({ mapa_conceitual: mapa }) {
  renderizacaoMapa++; // descarta desenhos ainda pendentes do material anterior
  if (!mapa?.codigo_mermaid) { paineis.mapa.replaceChildren(); return 0; }
  const grafico = el("figure", { class: "iris-mapa-grafico", "data-estado": "carregando", "aria-describedby": "mapa-descricao" },
    el("p", { class: "iris-cuidados" }, "Desenhando o mapa conceitual…"));
  paineis.mapa.replaceChildren(
    cabecalhoPainel("Mapa Conceitual", "titulo-mapa",
      "Visão geral dos conceitos do conteúdo e de como eles se relacionam."),
    grafico,
    el("section", { class: "iris-bloco", "data-bloco": "mapa", "aria-labelledby": "secao-mapa" },
      el("h4", { id: "secao-mapa" }, "Descrição do mapa"),
      el("p", { id: "mapa-descricao" }, mapa.descricao_textual || "Sem descrição textual.")),
    el("details", { class: "iris-codigo-mermaid" },
      el("summary", {}, "Código Mermaid (para editar em mermaid.live)"),
      el("pre", {}, el("code", {}, mapa.codigo_mermaid))),
  );
  desenharMapa(mapa.codigo_mermaid, grafico);
  return 1;
}

/** Monta as abas extras. Sem nenhum conteúdo de consolidação, as abas ficam ocultas. */
function renderizarConsolidacao(dados) {
  const contagens = {
    quiz: renderizarQuiz(dados),
    gabarito: renderizarGabarito(dados),
    curiosidades: renderizarCuriosidades(dados),
    experimento: renderizarExperimento(dados),
    mapa: renderizarMapa(dados),
  };
  for (const aba of abas.slice(1)) {
    const chave = aba.dataset.aba;
    aba.classList.toggle("hidden", !contagens[chave]); // classe: "inline-flex" venceria o atributo hidden
    const contador = aba.querySelector("[data-contador]");
    if (contador) contador.textContent = contagens[chave] ? String(contagens[chave]) : "";
  }
  selecionarAba(abas[0]);
  const temAlgo = Object.values(contagens).some(Boolean);
  $("#iris-abas").classList.toggle("hidden", !temAlgo);
  return contagens;
}

/* ---------- Quiz interativo ---------- */

paineis.quiz.addEventListener("click", (evento) => {
  const botao = evento.target.closest("[data-conferir]");
  if (!botao) return;
  const numero = botao.dataset.conferir;
  const retorno = $(`#fb-${numero}`);
  const escolhida = paineis.quiz.querySelector(`input[name="questao-${numero}"]:checked`);
  const resposta = gabaritoAtual[numero];
  if (!escolhida) {
    retorno.dataset.estado = "aviso";
    retorno.textContent = "Escolha uma alternativa antes de conferir.";
    return;
  }
  const tentativas = Number(retorno.dataset.tentativas || 0) + 1;
  retorno.dataset.tentativas = String(tentativas);
  if (escolhida.value === resposta?.alternativa_correta) {
    retorno.dataset.estado = "certo";
    retorno.replaceChildren(el("strong", {}, "✓ Correto! "), resposta.comentario);
  } else if (tentativas < 2) {
    // Retorno encorajador, sem revelar a resposta na primeira tentativa.
    retorno.dataset.estado = "errado";
    retorno.replaceChildren(el("strong", {}, "✗ Ainda não. "), "Releia as alternativas com calma e tente de novo.");
  } else {
    retorno.dataset.estado = "errado";
    retorno.replaceChildren(el("strong", {}, `✗ A resposta é a alternativa ${resposta.alternativa_correta}. `), resposta.comentario);
  }
});

/* =========================================================================
 * 14. Importar PDF, Word ou TXT para a caixa de texto
 * ====================================================================== */

const botaoImportar = $("#iris-importar");
const campoArquivo = $("#iris-importar-arquivo");

botaoImportar.addEventListener("click", () => campoArquivo.click());
campoArquivo.addEventListener("change", async () => {
  const arquivo = campoArquivo.files[0];
  campoArquivo.value = "";
  if (!arquivo) return;
  limparErros();
  const rotulo = botaoImportar.textContent;
  botaoImportar.disabled = true;
  botaoImportar.textContent = "Importando…";
  anunciar(`Lendo o arquivo ${arquivo.name}.`);
  try {
    const corpo = new FormData();
    corpo.append("arquivo", arquivo);
    const resposta = await fetch(botaoImportar.dataset.endpoint, { method: "POST", body: corpo });
    const json = await resposta.json().catch(() => null);
    if (!resposta.ok || !json?.sucesso) {
      mostrarErroCampo("texto", json?.erro?.mensagem || "Não foi possível ler o arquivo.");
      return;
    }
    const { texto, formato, paginas, avisos } = json.dados;
    campoTexto.value = texto;
    atualizarContador();
    if (avisos.length) $("#iris-avisos").replaceChildren(alerta("aviso", "Arquivo importado com observações", avisos.join(" ")));
    campoTexto.focus();
    campoTexto.setSelectionRange(0, 0);
    campoTexto.scrollTop = 0;
    anunciar(`Arquivo ${formato} importado${paginas ? ` (${paginas} páginas)` : ""}. Revise o texto antes de adaptar.`);
  } catch {
    mostrarErroCampo("texto", "Sem conexão com o servidor. Tente novamente.");
  } finally {
    botaoImportar.disabled = false;
    botaoImportar.textContent = rotulo.trim();
  }
});

/* =========================================================================
 * 15. Relatório pedagógico BNCC & AEE (abre em nova aba, pronto para PDF)
 * ====================================================================== */

$("#iris-relatorio").addEventListener("click", () => {
  const dados = ultimoResultado?.dados;
  if (!dados?.relatorio_aee) return;
  // Cabeçalho escolar lembrado neste navegador + aluno selecionado. Nada disso é gravado no servidor.
  const cabecalho = armazenamento.ler(CHAVE_CABECALHO_ESCOLAR) || {};
  const formulario = $("#iris-relatorio-form");
  formulario.elements.namedItem("dados").value = JSON.stringify({
    relatorio_aee: dados.relatorio_aee,
    titulo: $("#iris-titulo")?.textContent.trim() || dados.titulo || "",
    perfil: ultimoResultado.perfil?.nome || "",
    escola: cabecalho.escola || "",
    professor: cabecalho.professor || "",
    disciplina: $("#iris-disciplina")?.value.trim() || cabecalho.disciplina || "",
    aluno: alunoSelecionado?.nome_aluno || "",
    turma: alunoSelecionado?.turma || cabecalho.turma || "",
    observacoes: alunoSelecionado?.observacoes_pedagogicas || "",
  });
  formulario.submit();
  anunciar("Relatório AEE e BNCC aberto em uma nova aba. Use Imprimir para salvar em PDF.");
});

/* =========================================================================
 * 16. Termos técnicos destacados, com atalho para o VLibras (bloco "Tipografia")
 *     Fonte dos termos: o glossário do próprio material (com definição e exemplo)
 *     e, como reforço, uma lista fixa de termos de Física (sem definição).
 * ====================================================================== */

const CHAVE_TERMOS = "iris:termos-libras:v1";
const botaoTermos = $("#iris-termos-libras");
const TERMOS_FISICA = [
  "aceleração da gravidade", "aceleração", "velocidade", "força resultante", "força", "massa", "inércia", "peso",
  "atrito", "gravidade", "deslocamento", "trajetória", "referencial", "movimento uniforme",
  "movimento uniformemente variado", "quantidade de movimento", "impulso", "energia cinética",
  "energia potencial", "energia mecânica", "energia", "trabalho", "potência", "pressão", "densidade",
  "temperatura", "calor", "onda", "frequência", "comprimento de onda", "amplitude", "carga elétrica",
  "corrente elétrica", "tensão elétrica", "resistência elétrica", "campo elétrico", "campo magnético", "vetor",
];
const VARIANTES_ACENTO = { a: "[aáàâã]", e: "[eéê]", i: "[ií]", o: "[oóôõ]", u: "[uúü]", c: "[cç]" };
const termosAtivos = () => botaoTermos.getAttribute("aria-checked") === "true";

/** Mapa termo normalizado → { termo, definicao?, exemplo? }; o glossário do material tem prioridade. */
function glossarioAtual() {
  const mapa = new Map();
  const dados = ultimoResultado?.dados || {};
  for (const g of dados.glossario || []) if (g.termo) mapa.set(normalizar(g.termo), { termo: g.termo, definicao: g.definicao, exemplo: g.exemplo });
  for (const g of dados.glossario_ilustrado || []) {
    if (g.conceito && !mapa.has(normalizar(g.conceito))) mapa.set(normalizar(g.conceito), { termo: g.conceito, definicao: g.frase_unica });
  }
  for (const t of TERMOS_FISICA) if (!mapa.has(normalizar(t))) mapa.set(normalizar(t), { termo: t });
  return mapa;
}

/** Uma expressão para todos os termos: aceita variação de acento e plural, sem casar dentro de palavras. */
function expressaoTermos(chaves) {
  const alternativas = [...chaves].sort((a, b) => b.length - a.length).map((chave) =>
    [...chave].map((ch) => VARIANTES_ACENTO[ch] || (ch === " " ? "\\s+" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join(""));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternativas.join("|")})(?:e?s)?(?![\\p{L}\\p{N}])`, "giu");
}

function chaveDoTermo(trecho, glossario) {
  const base = normalizar(trecho);
  return [base, base.replace(/es$/, ""), base.replace(/s$/, "")].find((c) => glossario.has(c)) || null;
}

function removerDestaques() {
  leitor.querySelectorAll(".iris-termo").forEach((botao) => botao.replaceWith(document.createTextNode(botao.textContent)));
  leitor.normalize();
}

/** Destaca a 1ª ocorrência de cada termo por parágrafo/item (todas ficariam poluídas para TDAH e TEA). */
function destacarTermos() {
  removerDestaques();
  const glossario = glossarioAtual();
  const padrao = expressaoTermos(glossario.keys());
  let total = 0;
  leitor.querySelectorAll(".iris-markdown :is(p, li, td, blockquote), .iris-resumo, .iris-audiodescricao p").forEach((bloco) => {
    const vistos = new Set();
    const caminhante = document.createTreeWalker(bloco, NodeFilter.SHOW_TEXT, {
      acceptNode: (no) => (no.parentElement.closest("code, pre, a, button, .iris-math, mjx-container") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nos = [];
    while (caminhante.nextNode()) nos.push(caminhante.currentNode);
    for (const no of nos) {
      const texto = no.nodeValue;
      const partes = document.createDocumentFragment();
      let ultimo = 0;
      for (const m of texto.matchAll(padrao)) {
        const chave = chaveDoTermo(m[0], glossario);
        if (!chave || vistos.has(chave)) continue;
        vistos.add(chave);
        partes.append(texto.slice(ultimo, m.index),
          el("button", { type: "button", class: "iris-termo", "data-termo": chave, "aria-haspopup": "dialog", "aria-expanded": "false" }, m[0]));
        ultimo = m.index + m[0].length;
      }
      if (!ultimo) continue;
      partes.append(texto.slice(ultimo));
      no.replaceWith(partes);
    }
    total += vistos.size;
  });
  return total;
}

/* ---------- Cartão do termo (não modal): definição, exemplo e atalho para Libras ---------- */

const cartaoTermo = el("div", { class: "iris-termo-cartao iris-no-print", role: "dialog", "aria-modal": "false", "aria-labelledby": "iris-termo-titulo", hidden: true });
document.body.append(cartaoTermo);
let termoAberto = null;

function fecharCartaoTermo({ devolverFoco = true } = {}) {
  if (!termoAberto) return;
  cartaoTermo.hidden = true;
  termoAberto.setAttribute("aria-expanded", "false");
  if (devolverFoco && termoAberto.isConnected) termoAberto.focus();
  termoAberto = null;
}

async function mostrarEmLibras(termo, alvo) {
  anunciar(`Abrindo o VLibras para ${termo}.`);
  try {
    if (botaoVlibras.getAttribute("aria-pressed") !== "true") await abrirVlibras();
    // O widget oficial não documenta uma API de tradução: usa-a se existir; senão, simula o clique
    // no texto do termo, que é como o VLibras ativo recebe o que deve traduzir.
    const player = window.plugin?.player;
    if (typeof player?.translate === "function") player.translate(termo);
    else alvo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    anunciar(`VLibras aberto com o termo ${termo}. Se o sinal não aparecer, clique no termo com o VLibras ligado.`);
  } catch {
    anunciar("Não foi possível carregar o VLibras. Verifique a conexão.");
  }
}

function abrirCartaoTermo(botao) {
  fecharCartaoTermo({ devolverFoco: false });
  const info = glossarioAtual().get(botao.dataset.termo) || { termo: botao.textContent };
  const titulo = el("h3", { id: "iris-termo-titulo" }, info.termo);
  const botaoLibras = el("button", { type: "button", class: "primario" }, "Ver em Libras (VLibras)");
  const botaoFechar = el("button", { type: "button" }, "Fechar");
  botaoLibras.addEventListener("click", () => mostrarEmLibras(info.termo, titulo));
  botaoFechar.addEventListener("click", () => fecharCartaoTermo());
  cartaoTermo.replaceChildren(
    titulo,
    info.definicao
      ? el("p", {}, info.definicao)
      : el("p", { class: "iris-termo-exemplo" }, "Termo de Física deste material. Pergunte à Íris Voice: “o que é " + info.termo + "?”"),
    info.exemplo ? el("p", { class: "iris-termo-exemplo" }, el("b", {}, "Exemplo: "), info.exemplo) : null,
    el("div", { class: "iris-termo-acoes" }, botaoLibras, botaoFechar),
    el("p", { class: "iris-termo-nota" }, "Sinais-termo de Física podem variar por região: combine o sinal com o intérprete."),
  );
  cartaoTermo.hidden = false;
  const caixa = botao.getBoundingClientRect();
  const largura = cartaoTermo.offsetWidth;
  cartaoTermo.style.top = `${caixa.bottom + window.scrollY + 8}px`;
  cartaoTermo.style.left = `${Math.max(8, Math.min(caixa.left, window.innerWidth - largura - 8)) + window.scrollX}px`;
  botao.setAttribute("aria-expanded", "true");
  termoAberto = botao;
  botaoLibras.focus();
}

leitor.addEventListener("click", (evento) => {
  const botao = evento.target.closest(".iris-termo");
  if (!botao || leitor.isContentEditable) return; // no modo edição, o termo é só texto
  evento.preventDefault();
  if (botao === termoAberto) fecharCartaoTermo(); else abrirCartaoTermo(botao);
});
document.addEventListener("click", (evento) => {
  if (termoAberto && !cartaoTermo.contains(evento.target) && !evento.target.closest(".iris-termo")) fecharCartaoTermo({ devolverFoco: false });
});
document.addEventListener("keydown", (evento) => {
  if (evento.key === "Escape" && termoAberto) { evento.stopPropagation(); fecharCartaoTermo(); }
}, true);

function aplicarTermos(ativo, { avisar = true } = {}) {
  botaoTermos.setAttribute("aria-checked", String(ativo));
  armazenamento.gravar(CHAVE_TERMOS, ativo);
  fecharCartaoTermo({ devolverFoco: false });
  if (!ultimoResultado) {
    if (avisar) anunciar(ativo ? "Destaque de termos ligado: vale para o próximo material adaptado." : "Destaque de termos desligado.");
    return;
  }
  const total = ativo ? destacarTermos() : (removerDestaques(), 0);
  if (avisar) {
    anunciar(ativo
      ? `${total} ${total === 1 ? "termo técnico destacado" : "termos técnicos destacados"}. Ative um termo para ver a definição e o sinal em Libras.`
      : "Destaque de termos desligado.");
  }
}

botaoTermos.addEventListener("click", () => aplicarTermos(!termosAtivos()));
botaoTermos.setAttribute("aria-checked", String(armazenamento.ler(CHAVE_TERMOS) === true));

/* =========================================================================
 * 17. Mapa conceitual simplificado: organizador visual de causa → efeito
 *     Gerado no navegador, por regras, a partir do texto adaptado (inclusive das
 *     edições do professor): nada é inventado, só reorganizado em blocos curtos.
 * ====================================================================== */

const botaoMapaSimples = $("#iris-mapa-simples");
const rotuloMapaSimples = $("#iris-mapa-simples-rotulo");
const MAX_RELACOES = 6;
const MAX_PALAVRAS_BLOCO = 16;

// Regras sobre a frase SEM acentos (mesmo comprimento da original em NFC, então os índices valem para as duas).
const REGRAS_CAUSAIS = [
  { re: /^(?:se|caso)\s+(.+?),\s*(?:entao\s+)?(.+)$/d, tipo: "condicao" },
  { re: /^quando\s+(.+?),\s*(.+)$/d, tipo: "condicao" },
  { re: /^(?:por causa d[aoe]s?|devido a[os]?|gracas a[os]?)\s+(.+?),\s*(.+)$/d, tipo: "causa" },
  { re: /^(.+?),?\s+(?:porque|pois|ja que|uma vez que)\s+(.+)$/d, tipo: "efeito_causa" },
  { re: /^(.+?)[,;]\s*(?:por isso|portanto|logo|consequentemente|dessa forma|desse modo)[,]?\s+(.+)$/d, tipo: "causa" },
  { re: /^(.+?)\s+((?:faz(?:em)? com que|provoca[m]?|causa[m]?|gera[m]?|produz(?:em)?|resulta[m]? em|leva[m]? a|origina[m]?)\s.+)$/d, tipo: "causa" },
];
const INICIO_CONSEQUENCIA = /^(?:por isso|portanto|logo|consequentemente|dessa forma|desse modo|como resultado|assim(?! como))[,]?\s+(.+)$/d;
const ROTULOS_FLUXO = {
  condicao: ["Se…", "então", "Acontece…"],
  causa: ["Causa", "por isso", "Efeito"],
};

function simplificarTrecho(texto) {
  let limpo = texto.replace(/\s+/g, " ").replace(/^[\s,;:–-]+|[\s,;:.!?…–-]+$/g, "").trim();
  const palavras = limpo.split(" ");
  if (palavras.length > MAX_PALAVRAS_BLOCO) limpo = `${palavras.slice(0, MAX_PALAVRAS_BLOCO).join(" ")}…`;
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

function frasesDoMaterial() {
  const blocos = [...leitor.querySelectorAll(".iris-markdown :is(p, li), .iris-audiodescricao p, .iris-passos li")]
    .filter((b) => !b.querySelector("p, li")); // item que contém parágrafo: o parágrafo já entra sozinho
  return blocos.map((b) => b.textContent.normalize("NFC").replace(/\s+/g, " ").trim()).filter(Boolean)
    .map((texto) => texto.split(/(?<=[.!?…])\s+/).filter((f) => f.split(" ").length >= 3));
}

/** Relações causais do texto; se houver menos de 2, uma sequência das ideias principais. */
function extrairFluxo() {
  const paragrafos = frasesDoMaterial();
  const relacoes = [];
  const vistas = new Set();
  const adicionar = (tipo, causa, efeito) => {
    const a = simplificarTrecho(causa);
    const b = simplificarTrecho(efeito);
    const chave = normalizar(a + b);
    if (a.split(" ").length < 2 || b.split(" ").length < 2 || vistas.has(chave)) return;
    vistas.add(chave);
    relacoes.push({ tipo, causa: a, efeito: b });
  };
  for (const frases of paragrafos) {
    frases.forEach((frase, i) => {
      if (relacoes.length >= MAX_RELACOES) return;
      const chave = frase.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const parte = (m, n) => frase.slice(m.indices[n][0], m.indices[n][1]);
      const consequencia = chave.match(INICIO_CONSEQUENCIA);
      if (consequencia && i > 0) { adicionar("causa", frases[i - 1], parte(consequencia, 1)); return; }
      for (const regra of REGRAS_CAUSAIS) {
        const m = chave.match(regra.re);
        if (!m) continue;
        if (regra.tipo === "efeito_causa") adicionar("causa", parte(m, 2), parte(m, 1));
        else adicionar(regra.tipo, parte(m, 1), parte(m, 2));
        return;
      }
    });
  }
  if (relacoes.length >= 2) return { tipo: "causal", itens: relacoes };
  const ideias = paragrafos.map((frases) => frases[0]).filter(Boolean).slice(0, MAX_RELACOES).map(simplificarTrecho);
  return { tipo: "sequencia", itens: ideias };
}

function montarOrganizador() {
  const { tipo, itens } = extrairFluxo();
  if (!itens.length) return null;
  const bloco = (rotulo, texto) => el("div", { class: "iris-fluxo-bloco" }, el("span", { class: "iris-fluxo-rotulo" }, rotulo), texto);
  const lista = el("ol", { class: "iris-fluxo", "data-tipo": tipo }, tipo === "causal"
    ? itens.map((r) => {
      const [antes, conector, depois] = ROTULOS_FLUXO[r.tipo];
      return el("li", {}, bloco(antes, r.causa), el("span", { class: "iris-fluxo-seta" }, conector), bloco(depois, r.efeito));
    })
    : itens.map((texto, i) => el("li", {}, bloco(`Ideia ${i + 1}`, texto))));
  return el("section", { class: "iris-organizador", "data-organizador": "", "aria-labelledby": "iris-organizador-titulo" },
    el("h4", { id: "iris-organizador-titulo", tabindex: -1 }, "Mapa conceitual simplificado"),
    el("p", { class: "iris-organizador-dica" }, tipo === "causal"
      ? `${itens.length} relações de causa e efeito do texto. Leia cada linha da esquerda para a direita.`
      : "O texto quase não traz relações de causa e efeito: aqui estão as ideias principais, na ordem."),
    lista);
}

function marcarMapaSimples(ativo) {
  botaoMapaSimples.setAttribute("aria-pressed", String(ativo));
  rotuloMapaSimples.textContent = ativo ? "Remover mapa simplificado" : "Gerar mapa conceitual simplificado";
}

botaoMapaSimples.addEventListener("click", () => {
  const existente = leitor.querySelector("[data-organizador]");
  if (existente) {
    existente.remove();
    marcarMapaSimples(false);
    anunciar("Mapa simplificado removido.");
    return;
  }
  if (painelAtivo() !== leitor) selecionarAba(abas[0]);
  const organizador = montarOrganizador();
  if (!organizador) { anunciar("Não há texto suficiente para montar o mapa."); return; }
  const cabecalho = leitor.querySelector(":scope > header");
  if (cabecalho) cabecalho.after(organizador); else leitor.prepend(organizador);
  if (termosAtivos()) destacarTermos();
  marcarMapaSimples(true);
  const titulo = organizador.querySelector("h4");
  titulo.focus({ preventScroll: true });
  titulo.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  anunciar("Mapa conceitual simplificado inserido no topo do texto adaptado.");
});

document.addEventListener("iris:material-renderizado", () => {
  marcarMapaSimples(false); // material novo: o mapa anterior foi substituído junto com o texto
  fecharCartaoTermo({ devolverFoco: false });
  if (termosAtivos()) destacarTermos();
});

/* =========================================================================
 * 18. Sonificação de gráficos (static/js/audio_graph.js) e pausa regulatória
 * ====================================================================== */

const seletorFaixaSom = $("#iris-sonificacao-faixa");
// audio_graph.js é carregado depois deste módulo: lê a preferência quando a página termina de carregar.
window.addEventListener("DOMContentLoaded", () => {
  if (window.IrisAudioGraph) seletorFaixaSom.value = window.IrisAudioGraph.faixa();
});
seletorFaixaSom.addEventListener("change", () => {
  window.IrisAudioGraph?.definirFaixa(seletorFaixaSom.value);
  window.IrisAudioGraph?.testarFaixa();
  anunciar(`Sonificação em ${seletorFaixaSom.selectedOptions[0].textContent.toLowerCase()}.`);
});
$("#iris-sonificacao-testar").addEventListener("click", () => {
  if (!window.IrisAudioGraph) { anunciar("A sonificação não carregou. Recarregue a página."); return; }
  window.IrisAudioGraph.testarFaixa();
  anunciar("Tocando uma subida do valor mais baixo ao mais alto.");
});

// Pausa regulatória (apoio_cognitivo.js): a leitura em voz alta para durante a pausa.
document.addEventListener("iris:pausa-inicio", () => { if (estadoTts !== "parado") pararLeitura(); });

/* =========================================================================
 * 19. Último material guardado no aparelho (uso offline — ver static/sw.js)
 * Só materiais de texto: sem nome de aluno (o cabeçalho escolar nunca faz parte do resultado).
 * Apagado no logout (static/js/pwa.js).
 * ====================================================================== */

function guardarUltimoMaterial(resultado) {
  armazenamento.gravar(CHAVE_ULTIMO_MATERIAL, { salvo_em: Date.now(), resultado });
}

(function restaurarUltimoMaterial() {
  const salvo = armazenamento.ler(CHAVE_ULTIMO_MATERIAL);
  if (ultimoResultado || !salvo?.resultado?.dados || Date.now() - salvo.salvo_em > VALIDADE_ULTIMO_MATERIAL_MS) return;
  try {
    ultimoResultado = salvo.resultado;
    renderizar(ultimoResultado, { focar: false });
    $("#iris-avisos").prepend(alerta("aviso", "Último material restaurado",
      `Adaptado em ${new Date(salvo.salvo_em).toLocaleString("pt-BR")}. As ferramentas de leitura funcionam mesmo sem internet.`));
  } catch {
    ultimoResultado = null;
    restaurarPreview();
  }
})();
