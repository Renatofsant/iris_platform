/**
 * Íris Audio Graph — audiodescrição sintética e sonificação de gráficos de Física (DUA: representação).
 *
 * Uso (sem dependências; funciona no documento e dentro de Shadow DOM):
 *   IrisAudioGraph.anexarGrafico(figura, { titulo, eixo_x, eixo_y, series: [{ nome, pontos: [{x, y}] }] },
 *                                { svg, pontoParaSvg: (p) => ({ x, y }), areaX: [inicio, fim] });
 *   IrisAudioGraph.anexarForcas(figura, { objeto, vetores: [{ rotulo, angulo_graus, intensidade }] });
 *   IrisAudioGraph.descreverGrafico(dados) / descreverForcas(dados) → texto
 *
 * • Descrição sintética: calculada dos DADOS (tendência, extremos, taxa de variação e leitura física),
 *   complementa a audiodescrição escrita pela IA.
 * • Sonificação (Web Audio API): o valor de Y vira altura do som (escala logarítmica, como o ouvido
 *   percebe) e X vira posição no estéreo (esquerda → direita). Valores negativos soam com outro timbre.
 *   Setas ←/→ percorrem os pontos, Home/End vão às pontas, Enter/Espaço tocam o gráfico inteiro;
 *   com o mouse, o ponto sob o cursor soa.
 * • Faixa de tons ajustável (grave/média/aguda) no painel de acessibilidade, salva em localStorage.
 */
(() => {
  if (window.IrisAudioGraph) return;

  const CHAVE = "iris:sonificacao:v1";
  const FAIXAS = { grave: [130, 520], media: [220, 880], aguda: [440, 1760] };
  const DURACAO_VARREDURA = 3.2; // segundos para tocar uma série inteira
  const VOLUME = 0.14;

  const lerConfig = () => { try { return JSON.parse(localStorage.getItem(CHAVE)) || {}; } catch { return {}; } };
  const faixaAtual = () => FAIXAS[lerConfig().faixa] || FAIXAS.media;

  let contexto = null;
  function audio() {
    try {
      contexto ||= new (window.AudioContext || window.webkitAudioContext)();
      if (contexto.state === "suspended") contexto.resume();
    } catch { contexto = null; }
    return contexto;
  }

  /* ----------------------------------------------------------------------
   * Números e textos
   * -------------------------------------------------------------------- */

  const fmt = (n) => Number(Number(n).toFixed(2)).toLocaleString("pt-BR");
  const semAcento = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  /** "Velocidade (m/s)" → { nome: "Velocidade", unidade: "m/s" } */
  function eixo(rotulo) {
    const m = String(rotulo || "").match(/^(.*?)\s*[([]\s*([^)\]]+)\s*[)\]]\s*$/);
    return m ? { nome: m[1].trim(), unidade: m[2].trim() } : { nome: String(rotulo || "").trim(), unidade: "" };
  }
  const comUnidade = (valor, unidade) => `${fmt(valor)}${unidade ? ` ${unidade}` : ""}`;

  function regressao(pontos) {
    const n = pontos.length;
    const mx = pontos.reduce((s, p) => s + p.x, 0) / n;
    const my = pontos.reduce((s, p) => s + p.y, 0) / n;
    let sxy = 0; let sxx = 0; let syy = 0;
    for (const p of pontos) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; }
    const inclinacao = sxx ? sxy / sxx : 0;
    const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 1;
    return { inclinacao, r2 };
  }

  function formaDaCurva(pontos) {
    const ys = pontos.map((p) => p.y);
    const amplitude = Math.max(...ys) - Math.min(...ys);
    if (amplitude < 1e-9 || amplitude <= 0.02 * Math.max(...ys.map(Math.abs))) return "constante";
    const { inclinacao, r2 } = regressao(pontos);
    if (r2 >= 0.985) return inclinacao > 0 ? "cresce_linear" : "decresce_linear";
    // Sinais das variações: monotônica e curvatura (taxa aumentando ou diminuindo).
    const d = pontos.slice(1).map((p, i) => (p.y - pontos[i].y) / ((p.x - pontos[i].x) || 1));
    if (d.every((v) => v >= 0)) return d.at(-1) > d[0] ? "cresce_acelerando" : "cresce_desacelerando";
    if (d.every((v) => v <= 0)) return Math.abs(d.at(-1)) > Math.abs(d[0]) ? "decresce_acelerando" : "decresce_desacelerando";
    return "oscila";
  }

  const FRASES_FORMA = {
    constante: "fica constante",
    cresce_linear: "cresce em ritmo constante (uma reta subindo)",
    decresce_linear: "diminui em ritmo constante (uma reta descendo)",
    cresce_acelerando: "cresce cada vez mais rápido (curva que fica mais inclinada)",
    cresce_desacelerando: "cresce cada vez mais devagar (curva que vai achatando)",
    decresce_acelerando: "diminui cada vez mais rápido",
    decresce_desacelerando: "diminui cada vez mais devagar",
    oscila: "sobe e desce ao longo do gráfico",
  };

  /** Leitura física para os pares de eixos mais comuns em cinemática e dinâmica. */
  function leituraFisica(ex, ey, forma, inclinacao) {
    const x = semAcento(ex.nome);
    const y = semAcento(ey.nome);
    const tempo = /tempo|^t$/.test(x);
    const taxa = `${fmt(inclinacao)}${ey.unidade && ex.unidade ? ` ${ey.unidade} a cada ${ex.unidade}` : ""}`;
    if (tempo && /posic|espaco|deslocament|distancia|^s$|^x$/.test(y)) {
      if (forma === "constante") return "Posição constante: o corpo está parado (velocidade nula).";
      if (forma.endsWith("linear")) return `Posição muda em ritmo constante: movimento uniforme, com velocidade de ${taxa}.`;
      if (/acelerando|desacelerando/.test(forma)) return "A inclinação muda: a velocidade varia, é um movimento variado (há aceleração).";
    }
    if (tempo && /velocidade|^v$/.test(y)) {
      if (forma === "constante") return "Velocidade constante: movimento uniforme, aceleração nula (resultante das forças nula).";
      if (forma.endsWith("linear")) return `Velocidade muda em ritmo constante: movimento uniformemente variado, com aceleração de ${taxa}.`;
    }
    if (tempo && /aceleracao|^a$/.test(y) && forma === "constante") return "Aceleração constante: movimento uniformemente variado.";
    if (/forca|^f$/.test(y) && /aceleracao/.test(x) && forma.endsWith("linear")) {
      return `Força proporcional à aceleração, como na segunda lei de Newton: a inclinação (${taxa}) corresponde à massa.`;
    }
    return "";
  }

  function descreverGrafico({ titulo, eixo_x: rx, eixo_y: ry, series = [] }) {
    const ex = eixo(rx);
    const ey = eixo(ry);
    const partes = [`Gráfico${titulo ? ` "${titulo}"` : ""}: eixo horizontal ${ex.nome || "x"}${ex.unidade ? ` em ${ex.unidade}` : ""}, ` +
      `eixo vertical ${ey.nome || "y"}${ey.unidade ? ` em ${ey.unidade}` : ""}.`];
    for (const s of series) {
      const pontos = [...(s.pontos || [])].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
      if (!pontos.length) continue;
      const nome = s.nome ? `Série "${s.nome}": ` : "";
      if (pontos.length === 1) { partes.push(`${nome}um único ponto, ${ey.nome} ${comUnidade(pontos[0].y, ey.unidade)}.`); continue; }
      const forma = formaDaCurva(pontos);
      const { inclinacao } = regressao(pontos);
      const primeiro = pontos[0];
      const ultimo = pontos.at(-1);
      const maior = pontos.reduce((a, b) => (b.y > a.y ? b : a));
      const menor = pontos.reduce((a, b) => (b.y < a.y ? b : a));
      let texto = `${nome}${pontos.length} pontos, de ${ex.nome} ${comUnidade(primeiro.x, ex.unidade)} até ${comUnidade(ultimo.x, ex.unidade)}. ` +
        `${ey.nome || "O valor"} ${FRASES_FORMA[forma]}: começa em ${comUnidade(primeiro.y, ey.unidade)} e termina em ${comUnidade(ultimo.y, ey.unidade)}.`;
      if (forma === "oscila") texto += ` Máximo de ${comUnidade(maior.y, ey.unidade)} em ${comUnidade(maior.x, ex.unidade)}; mínimo de ${comUnidade(menor.y, ey.unidade)} em ${comUnidade(menor.x, ex.unidade)}.`;
      if (menor.y < 0 && maior.y > 0) texto += " Os valores passam de positivos a negativos (ou o contrário).";
      const fisica = leituraFisica(ex, ey, forma, inclinacao);
      partes.push(fisica ? `${texto} ${fisica}` : texto);
    }
    return partes.join(" ");
  }

  /* ----------------------------------------------------------------------
   * Forças e vetores
   * -------------------------------------------------------------------- */

  const DIRECOES = ["para a direita", "para cima e para a direita", "para cima", "para cima e para a esquerda",
    "para a esquerda", "para baixo e para a esquerda", "para baixo", "para baixo e para a direita"];
  const direcao = (graus) => DIRECOES[Math.round((((graus % 360) + 360) % 360) / 45) % 8];

  function resultante(vetores) {
    let x = 0; let y = 0;
    for (const v of vetores) {
      const r = (v.angulo_graus * Math.PI) / 180;
      x += v.intensidade * Math.cos(r);
      y += v.intensidade * Math.sin(r);
    }
    const intensidade = Math.hypot(x, y);
    return { x, y, intensidade, angulo: (Math.atan2(y, x) * 180) / Math.PI };
  }

  function descreverForcas({ objeto, vetores = [] }) {
    if (!vetores.length) return "";
    const maior = Math.max(...vetores.map((v) => v.intensidade)) || 1;
    const itens = vetores.map((v) => {
      const relativa = v.intensidade / maior;
      const tamanho = relativa > 0.85 ? "a maior" : relativa > 0.55 ? "média" : "pequena";
      return `${v.rotulo}, ${direcao(v.angulo_graus)}, intensidade ${tamanho}`;
    });
    const r = resultante(vetores);
    const final = r.intensidade <= 0.08 * maior
      ? "As forças se equilibram: a resultante é praticamente nula, então o corpo fica em repouso ou segue em movimento retilíneo uniforme (primeira lei de Newton)."
      : `A força resultante aponta ${direcao(r.angulo)}: o corpo acelera nesse sentido (segunda lei de Newton).`;
    return `Diagrama de forças sobre ${objeto || "o corpo"}, com ${vetores.length} ${vetores.length === 1 ? "força" : "forças"}: ${itens.join("; ")}. ${final}`;
  }

  /* ----------------------------------------------------------------------
   * Som
   * -------------------------------------------------------------------- */

  function frequencia(valor, min, max) {
    const [fMin, fMax] = faixaAtual();
    const t = max > min ? (valor - min) / (max - min) : 0.5;
    return fMin * (fMax / fMin) ** Math.min(Math.max(t, 0), 1); // logarítmica: passos iguais soam iguais
  }

  /** Um tom curto: pan de -1 (esquerda) a 1 (direita). */
  function tom(freq, { pan = 0, duracao = 0.18, forma = "sine", volume = VOLUME, atraso = 0 } = {}) {
    const ctx = audio();
    if (!ctx) return;
    const t0 = ctx.currentTime + atraso;
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.type = forma;
    osc.frequency.setValueAtTime(freq, t0);
    ganho.gain.setValueAtTime(0.0001, t0);
    ganho.gain.exponentialRampToValueAtTime(volume, t0 + 0.015);
    ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + duracao);
    let saida = ganho;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), t0);
      ganho.connect(panner);
      saida = panner;
    }
    osc.connect(ganho);
    saida.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duracao + 0.02);
    return osc;
  }

  /** Toca uma série como um glissando contínuo, com um "tique" em cada ponto medido. */
  function varrer(pontos, limites, { forma = "sine", aoTerminar } = {}) {
    const ctx = audio();
    if (!ctx || pontos.length < 1) return () => {};
    const { xMin, xMax, yMin, yMax } = limites;
    const t0 = ctx.currentTime + 0.05;
    const tempo = (x) => t0 + (xMax > xMin ? (x - xMin) / (xMax - xMin) : 0) * DURACAO_VARREDURA;
    const pan = (x) => (xMax > xMin ? ((x - xMin) / (xMax - xMin)) * 1.6 - 0.8 : 0);
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.type = forma;
    let saida = ganho;
    let panner = null;
    if (ctx.createStereoPanner) { panner = ctx.createStereoPanner(); ganho.connect(panner); saida = panner; }
    osc.connect(ganho);
    saida.connect(ctx.destination);
    pontos.forEach((p, i) => {
      const t = tempo(p.x);
      const f = frequencia(p.y, yMin, yMax);
      if (i === 0) { osc.frequency.setValueAtTime(f, t); panner?.pan.setValueAtTime(pan(p.x), t); } else {
        osc.frequency.linearRampToValueAtTime(f, t);
        panner?.pan.linearRampToValueAtTime(pan(p.x), t);
      }
    });
    const fim = tempo(pontos.at(-1).x) + 0.15;
    ganho.gain.setValueAtTime(0.0001, t0);
    ganho.gain.exponentialRampToValueAtTime(VOLUME * 0.8, t0 + 0.05);
    ganho.gain.setValueAtTime(VOLUME * 0.8, fim - 0.08);
    ganho.gain.exponentialRampToValueAtTime(0.0001, fim);
    osc.start(t0);
    osc.stop(fim + 0.02);
    // Tiques nos pontos medidos: o estudante percebe onde há dado real (não interpolado).
    const tiques = pontos.map((p) => tom(frequencia(p.y, yMin, yMax) * 2, { pan: pan(p.x), duracao: 0.04, forma: "triangle", volume: VOLUME * 0.5, atraso: tempo(p.x) - ctx.currentTime }));
    osc.onended = () => aoTerminar?.();
    return () => { try { osc.stop(); tiques.forEach((t) => t?.stop()); } catch { /* já parou */ } };
  }

  /* ----------------------------------------------------------------------
   * Interface (injetada na raiz do elemento: documento ou Shadow DOM)
   * -------------------------------------------------------------------- */

  const CSS = `
  .iag { margin-top: 8px; padding: 8px; border: 1px solid #c7d2fe; border-radius: 10px; background: #eef2ff; color: #1e1b4b; font-size: 13px; }
  .iag-barra { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .iag button, .iag select { font: inherit; height: 32px; padding: 0 10px; border: 1px solid #a5b4fc; border-radius: 8px; background: #fff; color: #1e1b4b; cursor: pointer; font-weight: 600; }
  .iag button[aria-pressed="true"] { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  .iag-trilha { position: relative; flex: 1 1 140px; min-width: 120px; height: 32px; border-radius: 8px; background: #fff; border: 1px dashed #818cf8; cursor: crosshair; }
  .iag-trilha:focus-visible, .iag button:focus-visible, .iag select:focus-visible { outline: 3px solid #22d3ee; outline-offset: 2px; }
  .iag-trilha i { position: absolute; top: 3px; bottom: 3px; width: 4px; margin-left: -2px; border-radius: 2px; background: #4f46e5; left: 0; opacity: 0; }
  .iag-trilha[data-ativo] i { opacity: 1; }
  .iag-ajuda { margin: 6px 0 0; color: #3730a3; font-size: 12px; }
  .iag details { margin-top: 6px; }
  .iag summary { cursor: pointer; font-weight: 600; }
  .iag-descricao { margin: 4px 0 0; line-height: 1.5; }
  .iag-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .iag-marca { fill: none; stroke: #4f46e5; stroke-width: 3; pointer-events: none; }
  @media print { .iag { display: none; } }`;

  function garantirEstilo(elemento) {
    const raiz = elemento.getRootNode();
    const alvo = raiz instanceof ShadowRoot ? raiz : document.head;
    if (alvo.querySelector?.("style[data-iag]")) return;
    const estilo = document.createElement("style");
    estilo.dataset.iag = "";
    estilo.textContent = CSS;
    alvo.append(estilo);
  }

  function criar(tag, atributos = {}, ...filhos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(atributos)) if (v != null && v !== false) n.setAttribute(k, v === true ? "" : String(v));
    n.append(...filhos.filter((f) => f != null));
    return n;
  }

  function anexarGrafico(figura, dados, { svg = null, pontoParaSvg = null, areaX = [0, 1] } = {}) {
    const series = (dados.series || [])
      .map((s, i) => ({ nome: s.nome || `Série ${i + 1}`, pontos: [...(s.pontos || [])].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x) }))
      .filter((s) => s.pontos.length);
    if (!series.length) return null;
    garantirEstilo(figura);
    const todos = series.flatMap((s) => s.pontos);
    const limites = {
      xMin: Math.min(...todos.map((p) => p.x)), xMax: Math.max(...todos.map((p) => p.x)),
      yMin: Math.min(...todos.map((p) => p.y)), yMax: Math.max(...todos.map((p) => p.y)),
    };
    const ex = eixo(dados.eixo_x);
    const ey = eixo(dados.eixo_y);
    const FORMAS = ["sine", "square", "sawtooth"];

    const estado = { serie: 0, indice: -1, parar: null };
    const tocar = criar("button", { type: "button", "aria-pressed": "false" }, "▶ Ouvir gráfico");
    const seletor = series.length > 1
      ? criar("select", { "aria-label": "Série a explorar" }, ...series.map((s, i) => criar("option", { value: i }, s.nome)))
      : null;
    const trilha = criar("div", {
      class: "iag-trilha", tabindex: "0", role: "slider", "aria-label": `Explorar pontos de ${dados.titulo || "gráfico"}`,
      "aria-valuemin": "1", "aria-valuemax": String(series[0].pontos.length), "aria-valuenow": "1",
      "aria-valuetext": "Use as setas para ouvir cada ponto",
    }, criar("i"));
    const aviso = criar("p", { class: "iag-sr", role: "status", "aria-live": "polite" });
    const ajuda = criar("p", { class: "iag-ajuda" },
      "Som agudo = valor alto; grave = valor baixo; esquerda → direita acompanha o eixo horizontal. " +
      "Setas ←/→ percorrem os pontos; Home/End vão às pontas; Enter toca tudo.");
    const descricao = criar("details", {}, criar("summary", {}, "Descrição automática dos dados"),
      criar("p", { class: "iag-descricao" }, descreverGrafico(dados)));
    const caixa = criar("div", { class: "iag", role: "group", "aria-label": "Sonificação do gráfico" },
      criar("div", { class: "iag-barra" }, tocar, seletor, trilha), ajuda, descricao, aviso);
    figura.append(caixa);

    let marca = null;
    const pontosAtuais = () => series[estado.serie].pontos;
    const anunciar = (texto) => { aviso.textContent = ""; setTimeout(() => { aviso.textContent = texto; }, 30); };

    function irPara(indice, { falar = true } = {}) {
      const pontos = pontosAtuais();
      estado.indice = Math.max(0, Math.min(indice, pontos.length - 1));
      const p = pontos[estado.indice];
      const frac = limites.xMax > limites.xMin ? (p.x - limites.xMin) / (limites.xMax - limites.xMin) : 0.5;
      tom(frequencia(p.y, limites.yMin, limites.yMax), { pan: frac * 1.6 - 0.8, forma: p.y < 0 ? "triangle" : FORMAS[estado.serie % 3] });
      const texto = `${ex.nome || "x"} ${comUnidade(p.x, ex.unidade)}, ${ey.nome || "y"} ${comUnidade(p.y, ey.unidade)}`;
      trilha.setAttribute("aria-valuenow", String(estado.indice + 1));
      trilha.setAttribute("aria-valuetext", `Ponto ${estado.indice + 1} de ${pontos.length}: ${texto}`);
      trilha.toggleAttribute("data-ativo", true);
      trilha.firstChild.style.left = `${frac * 100}%`;
      if (svg && pontoParaSvg) {
        marca ||= svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "circle"));
        const c = pontoParaSvg(p);
        marca.setAttribute("class", "iag-marca");
        marca.setAttribute("r", "7");
        marca.setAttribute("cx", c.x);
        marca.setAttribute("cy", c.y);
      }
      if (falar) anunciar(texto);
    }

    function pararSom() {
      estado.parar?.();
      estado.parar = null;
      tocar.setAttribute("aria-pressed", "false");
      tocar.textContent = "▶ Ouvir gráfico";
    }

    function tocarTudo() {
      if (estado.parar) { pararSom(); return; }
      let restante = series.length;
      const paradas = [];
      series.forEach((s, i) => {
        // Séries em sequência, cada uma com seu timbre.
        const atraso = i * (DURACAO_VARREDURA + 0.6) * 1000;
        const id = setTimeout(() => {
          if (series.length > 1) anunciar(`Série ${s.nome}`);
          paradas.push(varrer(s.pontos, limites, { forma: FORMAS[i % 3], aoTerminar: () => { if (--restante === 0) pararSom(); } }));
        }, atraso);
        paradas.push(() => clearTimeout(id));
      });
      estado.parar = () => paradas.forEach((p) => p());
      tocar.setAttribute("aria-pressed", "true");
      tocar.textContent = "■ Parar som";
    }

    tocar.addEventListener("click", tocarTudo);
    seletor?.addEventListener("change", () => {
      estado.serie = Number(seletor.value);
      trilha.setAttribute("aria-valuemax", String(pontosAtuais().length));
      irPara(0);
    });
    trilha.addEventListener("keydown", (e) => {
      const passos = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
      if (e.key in passos) irPara((estado.indice < 0 ? 0 : estado.indice + passos[e.key]));
      else if (e.key === "Home") irPara(0);
      else if (e.key === "End") irPara(pontosAtuais().length - 1);
      else if (e.key === "Enter" || e.key === " ") tocarTudo();
      else return;
      e.preventDefault();
    });

    // Mouse/toque: sobre o gráfico ou sobre a trilha, soa o ponto mais próximo do cursor.
    let ultimo = -1;
    const aoMover = (alvo, [inicio, fim]) => (e) => {
      const caixaAlvo = alvo.getBoundingClientRect();
      const frac = ((e.clientX - caixaAlvo.left) / caixaAlvo.width - inicio) / (fim - inicio);
      const xAlvo = limites.xMin + Math.min(Math.max(frac, 0), 1) * (limites.xMax - limites.xMin);
      const pontos = pontosAtuais();
      let melhor = 0;
      pontos.forEach((p, i) => { if (Math.abs(p.x - xAlvo) < Math.abs(pontos[melhor].x - xAlvo)) melhor = i; });
      if (melhor !== ultimo) { ultimo = melhor; irPara(melhor, { falar: false }); }
    };
    trilha.addEventListener("pointermove", aoMover(trilha, [0, 1]));
    if (svg) svg.addEventListener("pointermove", aoMover(svg, areaX));
    trilha.addEventListener("pointerleave", () => { ultimo = -1; });
    svg?.addEventListener("pointerleave", () => { ultimo = -1; });
    return caixa;
  }

  function anexarForcas(figura, dados) {
    const vetores = (dados.vetores || []).filter((v) => Number.isFinite(v.angulo_graus) && Number.isFinite(v.intensidade));
    if (!vetores.length) return null;
    garantirEstilo(figura);
    const maior = Math.max(...vetores.map((v) => v.intensidade)) || 1;
    const aviso = criar("p", { class: "iag-sr", role: "status", "aria-live": "polite" });
    const botao = criar("button", { type: "button" }, "▶ Ouvir forças");
    const caixa = criar("div", { class: "iag", role: "group", "aria-label": "Sonificação das forças" },
      criar("div", { class: "iag-barra" }, botao),
      criar("p", { class: "iag-ajuda" }, "Cada força soa na ordem: mais aguda = mais intensa; o lado do som indica a direção horizontal. Por último, a resultante, com outro timbre."),
      criar("details", {}, criar("summary", {}, "Descrição automática das forças"), criar("p", { class: "iag-descricao" }, descreverForcas(dados))),
      aviso);
    figura.append(caixa);
    botao.addEventListener("click", () => {
      const passo = 0.55;
      vetores.forEach((v, i) => {
        const r = (v.angulo_graus * Math.PI) / 180;
        tom(frequencia(v.intensidade, 0, maior), { pan: Math.cos(r) * 0.9, duracao: 0.4, atraso: i * passo });
      });
      const res = resultante(vetores);
      if (res.intensidade > 0.08 * maior) {
        tom(frequencia(Math.min(res.intensidade, maior), 0, maior), { pan: Math.cos((res.angulo * Math.PI) / 180) * 0.9, duracao: 0.7, forma: "triangle", atraso: vetores.length * passo + 0.2 });
      }
      aviso.textContent = descreverForcas(dados);
    });
    return caixa;
  }

  /** Amostra para o painel: uma subida da nota mais grave à mais aguda da faixa escolhida. */
  function testarFaixa() {
    const pontos = Array.from({ length: 9 }, (_, i) => ({ x: i, y: i }));
    varrer(pontos, { xMin: 0, xMax: 8, yMin: 0, yMax: 8 });
  }

  window.IrisAudioGraph = {
    FAIXAS: Object.keys(FAIXAS),
    faixa: () => lerConfig().faixa || "media",
    definirFaixa(faixa) { if (FAIXAS[faixa]) { try { localStorage.setItem(CHAVE, JSON.stringify({ ...lerConfig(), faixa })); } catch { /* modo privado */ } } },
    testarFaixa,
    descreverGrafico,
    descreverForcas,
    anexarGrafico,
    anexarForcas,
  };
})();
