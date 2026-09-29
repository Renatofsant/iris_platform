/**
 * Plataforma Íris — versão de impressão de provas e atividades adaptadas.
 *
 *  - Ajuste das preferências em tempo real (a URL é atualizada, então o link reproduz a configuração)
 *  - Cabeçalho escolar: preenchido aqui; o nome do aluno nunca é enviado ao servidor
 *  - Verificação de conteúdo mais largo que a página (evita a redução automática de escala)
 *  - Impressão só depois do carregamento das fontes
 */

const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
const raiz = document.documentElement;
const folha = $("#iris-folha");
const controles = $("#iris-controles");
const statusRegiao = $("#iris-status");
const LIMITES = JSON.parse(folha.dataset.limites);
const preferencias = JSON.parse(folha.dataset.preferencias);

function anunciar(mensagem) {
  statusRegiao.textContent = "";
  window.setTimeout(() => { statusRegiao.textContent = mensagem; }, 60);
}

const armazenamento = {
  ler(chave) { try { return JSON.parse(window.localStorage.getItem(chave)); } catch { return null; } },
  gravar(chave, valor) { try { window.localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* modo privado */ } },
};

const limitar = (n, min, max) => Math.min(Math.max(n, min), max);

/* =========================================================================
 * Preferências de impressão
 * ====================================================================== */

const campo = (nome) => controles.elements.namedItem(nome);

function aplicar({ atualizarUrl = true } = {}) {
  const avisos = [];
  if (preferencias.colunas === 2 && preferencias.fonte_pt > LIMITES.fonte_max_duas_colunas) {
    preferencias.colunas = 1;
    avisos.push(`Acima de ${LIMITES.fonte_max_duas_colunas} pt o layout volta para coluna única.`);
  }

  raiz.style.setProperty("--iris-fonte", `${preferencias.fonte_pt}pt`);
  raiz.style.setProperty("--iris-entrelinhas", String(preferencias.entrelinhas));
  raiz.dataset.contraste = preferencias.contraste;
  raiz.dataset.tipografia = preferencias.tipografia;
  raiz.dataset.colunas = String(preferencias.colunas);

  campo("fonte_pt").value = String(preferencias.fonte_pt);
  campo("contraste").value = preferencias.contraste;
  campo("tipografia").value = preferencias.tipografia;
  campo("entrelinhas").value = Number(preferencias.entrelinhas).toFixed(1);
  campo("colunas").value = String(preferencias.colunas);
  campo("colunas").querySelector('option[value="2"]').disabled = preferencias.fonte_pt > LIMITES.fonte_max_duas_colunas;
  campo("linhas_resposta").value = String(preferencias.linhas_resposta);
  document.querySelectorAll("[data-fonte-atalho]").forEach((botao) => {
    botao.setAttribute("aria-pressed", String(Number(botao.dataset.fonteAtalho) === preferencias.fonte_pt));
  });

  renderizarLinhasResposta();
  const secaoGuia = $("#iris-guia");
  if (secaoGuia) secaoGuia.hidden = !preferencias.incluir_guia;
  const caixaGuia = campo("incluir_guia");
  if (caixaGuia) caixaGuia.checked = Boolean(preferencias.incluir_guia);
  if (atualizarUrl) {
    const url = new URL(window.location.href);
    for (const [chave, valor] of Object.entries(preferencias)) url.searchParams.set(chave, String(valor));
    url.hash = "";
    window.history.replaceState(null, "", url);
  }
  // Espera o layout (e as fontes) para medir transbordamentos.
  document.fonts.ready.then(() => window.requestAnimationFrame(verificarLargura));
  mostrarAvisos(avisos);
  return avisos;
}

function renderizarLinhasResposta() {
  const secao = $("#iris-respostas");
  const caixa = $("#iris-linhas-resposta");
  const total = preferencias.linhas_resposta;
  secao.hidden = total === 0;
  if (caixa.children.length === total) return;
  caixa.replaceChildren(...Array.from({ length: total }, () => {
    const linha = document.createElement("div");
    linha.className = "iris-linha-resposta";
    return linha;
  }));
}

function mostrarAvisos(avisos, tipo = "aviso") {
  const caixa = $("#iris-alertas");
  caixa.querySelectorAll("[data-dinamico]").forEach((p) => p.remove());
  for (const texto of avisos) {
    const p = document.createElement("p");
    p.dataset.dinamico = "";
    p.className = tipo === "erro"
      ? "mb-3 mt-0 rounded-lg border border-solid border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
      : "mb-3 mt-0 rounded-lg border border-solid border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900";
    p.textContent = texto;
    caixa.append(p);
  }
}

function definirFonte(valor) {
  const numero = Math.round(Number(valor));
  if (!Number.isFinite(numero)) return;
  preferencias.fonte_pt = limitar(numero, LIMITES.fonte_min, LIMITES.fonte_max);
  const avisos = aplicar();
  anunciar(`Fonte de impressão: ${preferencias.fonte_pt} pontos.${avisos.length ? ` ${avisos[0]}` : ""}`);
}

document.querySelectorAll("[data-fonte-passo]").forEach((botao) => {
  botao.addEventListener("click", () => definirFonte(preferencias.fonte_pt + Number(botao.dataset.fontePasso)));
});
document.querySelectorAll("[data-fonte-atalho]").forEach((botao) => {
  botao.addEventListener("click", () => definirFonte(Number(botao.dataset.fonteAtalho)));
});
// "change" (e não "input"): não reaplica a cada tecla enquanto o professor digita "28".
campo("fonte_pt").addEventListener("change", (e) => definirFonte(e.target.value));

const DESCRICOES = {
  contraste: { "pb-alto": "alto contraste preto e branco", padrao: "padrão em tons de cinza" },
  tipografia: { padrao: "Inter", atkinson: "Atkinson Hyperlegible", dyslexic: "OpenDyslexic" },
  colunas: { 1: "coluna única", 2: "duas colunas" },
};

for (const nome of ["contraste", "tipografia", "entrelinhas", "colunas"]) {
  campo(nome).addEventListener("change", (e) => {
    const valor = e.target.value;
    preferencias[nome] = nome === "entrelinhas" ? Number(valor) : nome === "colunas" ? Number(valor) : valor;
    aplicar();
    const descricao = DESCRICOES[nome]?.[valor] ?? String(valor).replace(".", ",");
    anunciar(`${e.target.labels[0].textContent.replace(/\s*\(.*\)/, "")}: ${descricao}.`);
  });
}

campo("incluir_guia")?.addEventListener("change", (e) => {
  preferencias.incluir_guia = e.target.checked ? 1 : 0;
  aplicar();
  anunciar(e.target.checked
    ? "Orientações ao mediador incluídas em página separada. Não entregue essa página ao estudante."
    : "Orientações ao mediador removidas da impressão.");
});

campo("linhas_resposta").addEventListener("change", (e) => {
  const numero = Math.round(Number(e.target.value));
  preferencias.linhas_resposta = Number.isFinite(numero) ? limitar(numero, 0, LIMITES.linhas_max) : 0;
  aplicar();
  anunciar(preferencias.linhas_resposta ? `${preferencias.linhas_resposta} linhas para resposta.` : "Sem linhas para resposta.");
});

/* =========================================================================
 * Conteúdo mais largo que a página → o navegador reduziria a escala
 * ====================================================================== */

let avisoLargura = null;

function verificarLargura() {
  folha.querySelectorAll(".iris-excede").forEach((el) => el.classList.remove("iris-excede", "outline", "outline-2", "outline-dashed", "outline-rose-600"));
  avisoLargura?.remove();
  avisoLargura = null;

  // Só é confiável quando a folha está no tamanho real do A4 (tela larga o bastante).
  const larguraA4px = (210 / 25.4) * 96;
  if (folha.getBoundingClientRect().width < larguraA4px - 2) return;

  const limite = $(".iris-conteudo", folha).getBoundingClientRect().right + 1;
  const excedentes = [...folha.querySelectorAll(".iris-cabecalho, .iris-conteudo *, .iris-respostas")]
    .filter((el) => el.getBoundingClientRect().right > limite);
  if (!excedentes.length) return;

  excedentes.forEach((el) => el.classList.add("iris-excede", "outline", "outline-2", "outline-dashed", "outline-rose-600"));
  avisoLargura = document.createElement("p");
  avisoLargura.className = "mb-3 mt-0 rounded-lg border border-solid border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900";
  avisoLargura.setAttribute("role", "alert");
  avisoLargura.textContent =
    "Há conteúdo mais largo que a página (contornado em vermelho). Ao imprimir, o navegador pode reduzir " +
    "a escala e a fonte não sairá no tamanho escolhido. Edite esse trecho ou diminua a fonte.";
  $("#iris-alertas").append(avisoLargura);
}

/* =========================================================================
 * Cabeçalho escolar
 * ====================================================================== */

const CHAVE_CABECALHO = "iris:cabecalho-escolar:v1";
// O nome do aluno e a data NÃO são salvos: mudam a cada impressão e o nome é dado pessoal.
const CAMPOS_LEMBRADOS = ["escola", "turma", "disciplina", "professor"];
const camposCabecalho = Object.fromEntries(
  [...folha.querySelectorAll(".iris-cabecalho input")].map((input) => [input.name, input]),
);

function lerFragmentoCabecalho() {
  const parametros = new URLSearchParams(window.location.hash.slice(1));
  const bruto = parametros.get("cab");
  if (!bruto) return null;
  try {
    const base64 = bruto.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function preencherCabecalho() {
  const salvos = armazenamento.ler(CHAVE_CABECALHO) || {};
  const doFragmento = lerFragmentoCabecalho() || {};
  for (const [nome, input] of Object.entries(camposCabecalho)) {
    const valor = doFragmento[nome] ?? (CAMPOS_LEMBRADOS.includes(nome) ? salvos[nome] : undefined);
    if (typeof valor === "string") input.value = valor.slice(0, 120);
  }
  if (!camposCabecalho.data.value) camposCabecalho.data.value = new Date().toLocaleDateString("pt-BR");
  Object.values(camposCabecalho).forEach((input) => input.sincronizarEspelho());
}

function salvarCabecalho() {
  const dados = {};
  for (const nome of CAMPOS_LEMBRADOS) dados[nome] = camposCabecalho[nome].value.trim();
  armazenamento.gravar(CHAVE_CABECALHO, dados);
}

for (const input of Object.values(camposCabecalho)) {
  const espelho = document.createElement("span");
  espelho.className = "iris-valor";
  espelho.setAttribute("aria-hidden", "true"); // na tela, quem é lido é o próprio input
  input.after(espelho);
  const sincronizar = () => { espelho.textContent = input.value.trim(); };
  input.addEventListener("input", () => {
    sincronizar();
    if (CAMPOS_LEMBRADOS.includes(input.name)) salvarCabecalho();
  });
  input.sincronizarEspelho = sincronizar;
  input.addEventListener("change", verificarLargura);
}

/* =========================================================================
 * Impressão
 * ====================================================================== */

let tituloOriginal = document.title;
window.addEventListener("beforeprint", () => {
  tituloOriginal = document.title;
  const aluno = camposCabecalho.aluno.value.trim();
  document.title = [folha.dataset.titulo, aluno].filter(Boolean).join(" - "); // nome do arquivo PDF
});
window.addEventListener("afterprint", () => { document.title = tituloOriginal; });

$("#iris-docx").addEventListener("click", async () => {
  const botao = $("#iris-docx");
  const rotulo = $("#iris-docx-rotulo");
  botao.disabled = true;
  rotulo.textContent = "Gerando Word…";
  try {
    const cabecalho = Object.fromEntries(Object.entries(camposCabecalho).map(([nome, input]) => [nome, input.value.trim()]));
    // O cabeçalho vai só para montar o arquivo: o servidor não o grava.
    const resposta = await fetch(botao.dataset.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cabecalho, preferencias }),
    });
    if (resposta.status === 401) { location.assign(`/login?expirou=1&next=${encodeURIComponent(location.pathname)}`); return; }
    if (!resposta.ok) throw new Error();
    const nome = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(resposta.headers.get("Content-Disposition") || "")?.[1] || "material-adaptado.docx";
    const url = URL.createObjectURL(await resposta.blob());
    const link = Object.assign(document.createElement("a"), { href: url, download: decodeURIComponent(nome), hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    anunciar("Arquivo Word baixado, com o tamanho de fonte escolhido.");
  } catch {
    mostrarAvisos(["Não foi possível gerar o arquivo Word. Tente novamente."], "erro");
  } finally {
    botao.disabled = false;
    rotulo.textContent = "Baixar Word (.docx)";
  }
});

$("#iris-imprimir").addEventListener("click", async () => {
  if (document.activeElement?.matches?.("#iris-controles input")) document.activeElement.blur(); // aplica valor digitado
  await document.fonts.ready; // sem isso a primeira impressão pode sair com a fonte substituta
  await matematicaPronta;     // fórmulas tipografadas antes de abrir o diálogo
  window.print();
});

/* =========================================================================
 * Equações: MathJax só é carregado se a folha tiver LaTeX
 * ====================================================================== */

let matematicaPronta = Promise.resolve();
const conteudoFolha = $(".iris-conteudo", folha);
if (/\\\(|\\\[/.test(conteudoFolha.textContent)) {
  window.MathJax = {
    tex: { inlineMath: [["\\(", "\\)"]], displayMath: [["\\[", "\\]"]] },
    options: { enableMenu: false },
    startup: { typeset: false },
  };
  matematicaPronta = new Promise((concluir) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js";
    script.async = true;
    script.onload = () => window.MathJax.startup.promise
      .then(() => window.MathJax.typesetPromise([conteudoFolha]))
      .then(concluir, concluir);
    script.onerror = concluir; // sem MathJax, o LaTeX fica legível como texto
    document.head.append(script);
  }).then(() => window.requestAnimationFrame(verificarLargura));
}

/* ====================================================================== */

preencherCabecalho();
aplicar();
