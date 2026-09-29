/**
 * Plataforma Íris — Simulador de empatia visual e sensorial (painel de adaptação).
 *
 * Aplica, SOMENTE na tela do professor e só na área de pré-visualização, aproximações de como
 * o estudante pode perceber o material. Não altera o material, a impressão nem a exportação.
 *
 *   baixa-visao   desfoque gaussiano ajustável (3 a 6 px)
 *   protanopia    matriz de Machado, Oliveira e Fernandes (2009), severidade 1,0 — sem cones L (vermelho)
 *   deuteranopia  idem — sem cones M (verde)
 *   tritanopia    idem — sem cones S (azul)
 *   tdah          elementos em movimento ao redor do conteúdo (sobrecarga de estímulos)
 *
 * As matrizes valem para RGB linear, que é o espaço padrão dos filtros SVG
 * (color-interpolation-filters: linearRGB).
 */
(() => {
  const seletor = document.getElementById("iris-simulacao");
  const area = document.getElementById("iris-area-simulada");
  if (!seletor || !area) return;

  const grupoDesfoque = document.getElementById("iris-desfoque-grupo");
  const controleDesfoque = document.getElementById("iris-desfoque");
  const valorDesfoque = document.getElementById("iris-desfoque-valor");
  const aviso = document.getElementById("iris-simulacao-aviso");
  const status = document.getElementById("iris-status");
  const reduzirMovimento = window.matchMedia("(prefers-reduced-motion: reduce)");

  const MATRIZES = {
    protanopia: "0.152286 1.052583 -0.204868 0 0  0.114503 0.786281 0.099216 0 0  -0.003882 -0.048116 1.051998 0 0  0 0 0 1 0",
    deuteranopia: "0.367322 0.860646 -0.227968 0 0  0.280085 0.672501 0.047413 0 0  -0.011820 0.042940 0.968881 0 0  0 0 0 1 0",
    tritanopia: "1.255528 -0.076749 -0.178779 0 0  -0.078411 0.930809 0.147602 0 0  0.004733 0.691367 0.303900 0 0  0 0 0 1 0",
  };

  const DESCRICOES = {
    "baixa-visao": ["Baixa visão", "o texto perde nitidez. Hierarquia clara, fonte grande e alto contraste fazem diferença."],
    protanopia: ["Protanopia", "vermelhos ficam escuros e se confundem com verdes. Nunca use só a cor para transmitir informação."],
    deuteranopia: ["Deuteranopia", "verdes e vermelhos se confundem (o tipo mais comum de daltonismo). Combine cor com texto ou ícones."],
    tritanopia: ["Tritanopia", "azuis e amarelos se confundem. Verifique gráficos e destaques que dependem dessas cores."],
    tdah: ["Sobrecarga sensorial (TDAH)", "estímulos ao redor competem pela atenção. Layouts limpos e blocos curtos ajudam a manter o foco."],
  };

  // Filtros SVG de daltonismo, uma vez só.
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  const defs = document.createElementNS(NS, "defs");
  for (const [nome, valores] of Object.entries(MATRIZES)) {
    const filtro = document.createElementNS(NS, "filter");
    filtro.id = `iris-filtro-${nome}`;
    filtro.setAttribute("color-interpolation-filters", "linearRGB");
    const matriz = document.createElementNS(NS, "feColorMatrix");
    matriz.setAttribute("type", "matrix");
    matriz.setAttribute("values", valores);
    filtro.append(matriz);
    defs.append(filtro);
  }
  svg.append(defs);
  document.body.append(svg);

  // Estilos da simulação (inclusive: nada disso vai para a impressão).
  const estilo = document.createElement("style");
  estilo.textContent = `
    #iris-area-simulada { transition: filter 200ms ease; }
    /* Camada "grudada" na parte visível da área: acompanha a rolagem sem sair do painel. */
    .iris-distracoes { position: sticky; top: 0; height: 100vh; max-height: 100%; margin-bottom: -100vh; z-index: 5; overflow: hidden; pointer-events: none; }
    .iris-distracao { position: absolute; font: 600 13px/1.3 Inter, system-ui, sans-serif; }
    .iris-d-bolha { width: 46px; height: 46px; border-radius: 999px; opacity: .55; animation: iris-deriva 7s ease-in-out infinite alternate; }
    .iris-d-faixa { left: 0; right: 0; top: 6px; white-space: nowrap; color: #7c2d12; background: rgb(254 215 170 / .85); padding: 4px 0; }
    .iris-d-faixa span { display: inline-block; padding-left: 20%; animation: iris-letreiro 26s linear infinite; }
    .iris-d-notificacao { right: 14px; bottom: 18px; padding: 10px 14px; border-radius: 12px; color: #fff; background: #0f172a;
                          box-shadow: 0 10px 25px rgb(15 23 42 / .35); animation: iris-notificacao 6s ease-in-out infinite; }
    .iris-d-post { left: 10px; bottom: 40%; padding: 10px; width: 120px; color: #713f12; background: #fde047; transform: rotate(-6deg);
                   box-shadow: 0 6px 14px rgb(0 0 0 / .18); animation: iris-balanco 2.6s ease-in-out infinite; }
    .iris-d-relogio { right: 14px; top: 44px; padding: 4px 10px; border-radius: 8px; color: #fff; background: #dc2626; font-variant-numeric: tabular-nums; }
    .iris-d-seta { font-size: 28px; animation: iris-pulo 1.2s ease-in-out infinite; }
    @keyframes iris-deriva { to { transform: translate(var(--dx), var(--dy)) scale(1.25); } }
    @keyframes iris-letreiro { to { transform: translateX(-100%); } }
    @keyframes iris-notificacao { 0%, 15% { transform: translateY(160%); } 25%, 70% { transform: translateY(0); } 85%, 100% { transform: translateY(160%); } }
    @keyframes iris-balanco { 50% { transform: rotate(4deg) translateY(-6px); } }
    @keyframes iris-pulo { 50% { transform: translateY(-14px); } }
    .iris-distracoes[data-estatico] * { animation: none !important; }
    @media print {
      #iris-area-simulada { filter: none !important; }
      .iris-distracoes { display: none !important; }
    }`;
  document.head.append(estilo);

  let camadaDistracoes = null;
  let relogio = null;

  function criarDistracoes() {
    const camada = document.createElement("div");
    camada.className = "iris-distracoes iris-no-print";
    camada.setAttribute("aria-hidden", "true");
    if (reduzirMovimento.matches) camada.dataset.estatico = "";

    const cores = ["#f472b6", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#fb7185"];
    cores.forEach((cor, i) => {
      const bolha = document.createElement("div");
      bolha.className = "iris-distracao iris-d-bolha";
      bolha.style.cssText = `background:${cor};left:${[4, 86, 12, 78, 45, 92][i]}%;top:${[18, 26, 70, 82, 90, 55][i]}%;` +
        `--dx:${[60, -70, 80, -50, 40, -60][i]}px;--dy:${[-40, 50, -60, -30, -50, 40][i]}px;animation-delay:${-i * 1.1}s`;
      camada.append(bolha);
    });

    const faixa = document.createElement("div");
    faixa.className = "iris-distracao iris-d-faixa";
    const letreiro = document.createElement("span");
    letreiro.textContent = "📣 Intervalo em 5 minutos  •  Não esqueça o trabalho de casa  •  Alguém chamou você no grupo  •  " +
      "O sinal vai tocar  •  Barulho no corredor  •  Que horas são?  •  ";
    faixa.append(letreiro);

    const notificacao = document.createElement("div");
    notificacao.className = "iris-distracao iris-d-notificacao";
    notificacao.textContent = "💬 3 novas mensagens";

    const post = document.createElement("div");
    post.className = "iris-distracao iris-d-post";
    post.textContent = "Lembrar: prova de Matemática amanhã!";

    const seta = document.createElement("div");
    seta.className = "iris-distracao iris-d-seta";
    seta.style.cssText = "right:22%;top:30%";
    seta.textContent = "⚽";

    const relogioEl = document.createElement("div");
    relogioEl.className = "iris-distracao iris-d-relogio";
    const atualizarRelogio = () => { relogioEl.textContent = `⏱ ${new Date().toLocaleTimeString("pt-BR")}`; };
    atualizarRelogio();
    if (!reduzirMovimento.matches) relogio = window.setInterval(atualizarRelogio, 1000);

    camada.append(faixa, notificacao, post, seta, relogioEl);
    return camada;
  }

  function limpar() {
    area.style.filter = "";
    camadaDistracoes?.remove();
    camadaDistracoes = null;
    window.clearInterval(relogio);
    relogio = null;
  }

  function aplicar(modo, { anunciarMudanca = true } = {}) {
    limpar();
    grupoDesfoque.hidden = modo !== "baixa-visao";
    if (modo === "baixa-visao") {
      area.style.filter = `blur(${controleDesfoque.value}px)`;
    } else if (MATRIZES[modo]) {
      area.style.filter = `url(#iris-filtro-${modo})`;
    } else if (modo === "tdah") {
      camadaDistracoes = criarDistracoes();
      area.prepend(camadaDistracoes);
    }

    aviso.hidden = !modo;
    aviso.classList.toggle("hidden", !modo); // a classe "flex" do Tailwind venceria o atributo hidden
    aviso.classList.toggle("flex", Boolean(modo));
    if (modo) {
      const [nome, texto] = DESCRICOES[modo];
      document.getElementById("iris-simulacao-nome").textContent = `Simulação: ${nome}`;
      document.getElementById("iris-simulacao-texto").textContent =
        `${texto} É uma aproximação, apenas na sua tela.` +
        (modo === "tdah" && reduzirMovimento.matches ? " Animações pausadas pela preferência de movimento reduzido do sistema." : "");
    }
    if (anunciarMudanca && status) {
      status.textContent = "";
      window.setTimeout(() => {
        status.textContent = modo ? `Simulação de ${DESCRICOES[modo][0]} ativada. Tecla Esc encerra.` : "Simulação encerrada.";
      }, 60);
    }
  }

  seletor.addEventListener("change", () => aplicar(seletor.value));
  controleDesfoque.addEventListener("input", () => {
    valorDesfoque.textContent = `${controleDesfoque.value}px`;
    if (seletor.value === "baixa-visao") area.style.filter = `blur(${controleDesfoque.value}px)`;
  });
  document.getElementById("iris-simulacao-encerrar").addEventListener("click", () => {
    seletor.value = "";
    aplicar("");
    seletor.focus();
  });
  document.addEventListener("keydown", (evento) => {
    if (evento.key !== "Escape" || !seletor.value || document.querySelector("dialog[open]")) return;
    seletor.value = "";
    aplicar("");
  });
  // Ao imprimir pelo navegador, o filtro inline também precisa sair.
  window.addEventListener("beforeprint", () => { area.dataset.filtroSalvo = area.style.filter; area.style.filter = ""; });
  window.addEventListener("afterprint", () => { area.style.filter = area.dataset.filtroSalvo || ""; });
})();
