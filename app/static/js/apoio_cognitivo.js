/**
 * Plataforma Íris — recursos anti-fadiga e de foco cognitivo (TDAH / TEA), no bloco "Texto" do painel.
 *
 * • Régua de leitura dinâmica: faixa transparente que acompanha o cursor (ou Alt+↑/↓ no teclado)
 *   e escurece o restante da área do material.
 * • Foco mínimo: esconde tudo o que não é o material; uma barra flutuante mantém A−/A+, a régua e a saída (Esc).
 * • Pausa regulatória: conta só o tempo com a página visível e, no intervalo escolhido, sugere uma
 *   micro-pausa sensorial de 1 minuto (pode adiar ou pular). A leitura em voz alta para durante a pausa.
 *
 * Preferências (régua e intervalo) ficam em localStorage; o foco mínimo sempre começa desligado.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const area = $("iris-area-simulada");
  const leitor = $("iris-leitor");
  if (!area || !leitor) return;

  const CHAVE = "iris:apoio-cognitivo:v1";
  const lerConfig = () => { try { return JSON.parse(localStorage.getItem(CHAVE)) || {}; } catch { return {}; } };
  const salvarConfig = (parcial) => { try { localStorage.setItem(CHAVE, JSON.stringify({ ...lerConfig(), ...parcial })); } catch { /* modo privado */ } };
  const status = $("iris-status");
  const anunciar = (texto) => { if (!status) return; status.textContent = ""; setTimeout(() => { status.textContent = texto; }, 60); };
  const ligado = (botao) => botao.getAttribute("aria-checked") === "true";
  const marcar = (botao, valor) => botao.setAttribute("aria-checked", String(valor));

  /* ======================================================================
   * Régua de leitura dinâmica
   * ==================================================================== */

  const botaoRegua = $("iris-regua");
  const regua = document.createElement("div");
  regua.className = "iris-regua iris-no-print";
  regua.setAttribute("aria-hidden", "true");
  regua.hidden = true;
  regua.innerHTML = '<div class="iris-regua-veu iris-regua-topo"></div><div class="iris-regua-faixa"></div><div class="iris-regua-veu iris-regua-base"></div>';
  area.append(regua);
  const [veuTopo, faixa, veuBase] = regua.children;
  let centroY = 120;        // centro da faixa, relativo ao topo da área
  let ultimoClienteY = null; // posição do cursor na tela, para acompanhar a rolagem

  /** Altura da faixa: cerca de duas linhas do material, com a fonte e o entrelinhas escolhidos. */
  function alturaFaixa() {
    const estilo = getComputedStyle(leitor);
    const fonte = parseFloat(estilo.fontSize) || 18;
    const linha = parseFloat(estilo.lineHeight) || fonte * 1.5;
    return Math.round(linha * 1.9);
  }

  function posicionarRegua() {
    const altura = alturaFaixa();
    const total = area.scrollHeight;
    const topo = Math.max(0, Math.min(centroY - altura / 2, total - altura));
    veuTopo.style.height = `${topo}px`;
    faixa.style.top = `${topo}px`;
    faixa.style.height = `${altura}px`;
    veuBase.style.top = `${topo + altura}px`;
  }

  function aoMoverPonteiro(evento) {
    ultimoClienteY = evento.clientY;
    centroY = evento.clientY - area.getBoundingClientRect().top;
    posicionarRegua();
  }

  function ativarRegua(ativa, { avisar = true } = {}) {
    marcar(botaoRegua, ativa);
    regua.hidden = !ativa;
    salvarConfig({ regua: ativa });
    if (ativa) {
      const caixa = area.getBoundingClientRect();
      centroY = Math.max(80, Math.min(window.innerHeight / 2 - caixa.top, caixa.height - 40));
      posicionarRegua();
    }
    if (avisar) anunciar(ativa ? "Régua de leitura ativada. Mova o cursor ou use Alt e as setas para cima e para baixo." : "Régua de leitura desativada.");
  }

  botaoRegua?.addEventListener("click", () => ativarRegua(!ligado(botaoRegua)));
  area.addEventListener("pointermove", (e) => { if (!regua.hidden) aoMoverPonteiro(e); });
  window.addEventListener("scroll", () => {
    if (regua.hidden || ultimoClienteY == null) return;
    centroY = ultimoClienteY - area.getBoundingClientRect().top;
    posicionarRegua();
  }, { passive: true });
  window.addEventListener("resize", () => { if (!regua.hidden) posicionarRegua(); });
  document.addEventListener("keydown", (e) => {
    if (regua.hidden || !e.altKey || e.ctrlKey || e.metaKey || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const passo = alturaFaixa() / 1.9; // uma linha
    centroY += e.key === "ArrowDown" ? passo : -passo;
    ultimoClienteY = null;
    posicionarRegua();
    // Mantém a faixa visível ao descer/subir pelo teclado.
    const faixaNaTela = area.getBoundingClientRect().top + centroY;
    if (faixaNaTela > window.innerHeight * 0.75 || faixaNaTela < window.innerHeight * 0.2) {
      window.scrollBy({ top: faixaNaTela - window.innerHeight / 2, behavior: "instant" });
    }
  });
  // Mudança de fonte, entrelinhas ou de material: recalcula a faixa.
  new MutationObserver(() => { if (!regua.hidden) posicionarRegua(); })
    .observe(leitor, { attributes: true, attributeFilter: ["style"], childList: true });

  /* ======================================================================
   * Foco mínimo
   * ==================================================================== */

  const botaoFoco = $("iris-foco-minimo");
  const barraFoco = document.createElement("div");
  barraFoco.className = "iris-foco-barra iris-no-print";
  barraFoco.setAttribute("role", "toolbar");
  barraFoco.setAttribute("aria-label", "Foco mínimo");
  barraFoco.hidden = true;
  const botaoBarra = (rotulo, acao, rotuloAcessivel) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = rotulo;
    if (rotuloAcessivel) b.setAttribute("aria-label", rotuloAcessivel);
    b.addEventListener("click", acao);
    barraFoco.append(b);
    return b;
  };
  // Reaproveita os controles do painel (ficam escondidos no foco mínimo).
  botaoBarra("A−", () => $("iris-fonte-menos")?.click(), "Diminuir fonte");
  botaoBarra("A+", () => $("iris-fonte-mais")?.click(), "Aumentar fonte");
  const botaoReguaBarra = botaoBarra("Régua", () => { botaoRegua?.click(); sincronizarBarra(); });
  botaoBarra("Sair do foco (Esc)", () => ativarFoco(false));
  document.body.append(barraFoco);

  function sincronizarBarra() { botaoReguaBarra.setAttribute("aria-pressed", String(ligado(botaoRegua))); }

  function ativarFoco(ativo) {
    marcar(botaoFoco, ativo);
    document.body.toggleAttribute("data-foco-minimo", ativo);
    barraFoco.hidden = !ativo;
    sincronizarBarra();
    if (ativo) {
      document.getElementById("iris-titulo")?.focus({ preventScroll: true });
      area.scrollIntoView({ block: "start" });
      anunciar("Foco mínimo ativado: só o material está visível. Pressione Esc para sair.");
    } else {
      botaoFoco.focus({ preventScroll: true });
      anunciar("Foco mínimo desativado.");
    }
    if (!regua.hidden) requestAnimationFrame(posicionarRegua);
  }

  botaoFoco?.addEventListener("click", () => ativarFoco(!ligado(botaoFoco)));
  document.addEventListener("keydown", (e) => {
    // Esc também encerra diálogos e a simulação: aqui só age se nada disso estiver aberto.
    if (e.key !== "Escape" || !ligado(botaoFoco) || document.querySelector("dialog[open]")) return;
    ativarFoco(false);
  });

  /* ======================================================================
   * Pausa regulatória
   * ==================================================================== */

  const seletorPausa = $("iris-pausa-intervalo");
  const statusPausa = $("iris-pausa-status");
  const DURACAO_PAUSA_S = 60;
  const ADIAR_MIN = 5;

  const SUGESTOES = [
    { titulo: "Respiração quadrada", passos: ["Inspire contando até 4.", "Segure o ar contando até 4.", "Solte o ar contando até 4.", "Espere contando até 4. Repita 3 vezes."] },
    { titulo: "Descanso para os olhos", passos: ["Tire os olhos da tela.", "Olhe para algo bem longe, como a janela ou o fundo da sala.", "Pisque devagar algumas vezes."] },
    { titulo: "Pressão nas palmas", passos: ["Junte as palmas das mãos na frente do peito.", "Empurre uma contra a outra com força por 5 segundos.", "Solte devagar. Repita 3 vezes."] },
    { titulo: "Alongar mãos e ombros", passos: ["Abra e feche as mãos 5 vezes.", "Gire os ombros para trás 5 vezes.", "Estique os braços para cima e respire fundo."] },
    { titulo: "Água e postura", passos: ["Beba alguns goles de água.", "Apoie os dois pés no chão.", "Encoste as costas na cadeira e solte os ombros."] },
    { titulo: "Âncora nos sentidos", passos: ["Encontre 3 coisas que você vê ao seu redor.", "Toque 2 objetos e perceba a textura.", "Respire fundo 1 vez, bem devagar."] },
  ];
  let ultimaSugestao = -1;

  const dialogo = document.createElement("dialog");
  dialogo.className = "iris-pausa";
  dialogo.setAttribute("aria-labelledby", "iris-pausa-titulo");
  dialogo.innerHTML = `
    <p class="iris-pausa-selo">Pausa regulatória · 1 minuto</p>
    <h2 id="iris-pausa-titulo"></h2>
    <ol id="iris-pausa-passos"></ol>
    <div class="iris-pausa-progresso" role="progressbar" aria-label="Tempo da pausa" aria-valuemin="0" aria-valuemax="${DURACAO_PAUSA_S}" aria-valuenow="0" hidden><span></span></div>
    <p id="iris-pausa-contagem" class="iris-pausa-contagem" hidden></p>
    <div class="iris-pausa-acoes">
      <button type="button" data-acao="comecar" class="primario">Começar a pausa</button>
      <button type="button" data-acao="adiar">Adiar ${ADIAR_MIN} min</button>
      <button type="button" data-acao="pular">Pular</button>
    </div>`;
  document.body.append(dialogo);
  const progresso = dialogo.querySelector(".iris-pausa-progresso");
  const contagem = $("iris-pausa-contagem");
  const botaoComecar = dialogo.querySelector('[data-acao="comecar"]');

  const pausa = { intervaloMin: Number(lerConfig().pausa) || 0, ativoMs: 0, ultimaMarca: Date.now(), cronometro: null };

  function atualizarStatus() {
    if (!statusPausa) return;
    if (!pausa.intervaloMin) { statusPausa.textContent = ""; return; }
    const faltam = Math.max(0, Math.ceil((pausa.intervaloMin * 60000 - pausa.ativoMs) / 60000));
    statusPausa.textContent = faltam <= 1 ? "Próxima pausa em instantes" : `Próxima pausa em ${faltam} min`;
  }

  /** Conta apenas o tempo com a página visível (aba em segundo plano não cansa a leitura). */
  function marcarTempo() {
    const agora = Date.now();
    if (document.visibilityState === "visible" && !dialogo.open) pausa.ativoMs += agora - pausa.ultimaMarca;
    pausa.ultimaMarca = agora;
    if (pausa.intervaloMin && pausa.ativoMs >= pausa.intervaloMin * 60000 && !dialogo.open) abrirPausa();
    atualizarStatus();
  }

  function abrirPausa() {
    let indice;
    do { indice = Math.floor(Math.random() * SUGESTOES.length); } while (indice === ultimaSugestao && SUGESTOES.length > 1);
    ultimaSugestao = indice;
    const sugestao = SUGESTOES[indice];
    $("iris-pausa-titulo").textContent = `Hora de uma micro-pausa: ${sugestao.titulo}`;
    $("iris-pausa-passos").replaceChildren(...sugestao.passos.map((p) => Object.assign(document.createElement("li"), { textContent: p })));
    progresso.hidden = true;
    contagem.hidden = true;
    botaoComecar.hidden = false;
    delete botaoComecar.dataset.fase;
    botaoComecar.textContent = "Começar a pausa";
    document.dispatchEvent(new CustomEvent("iris:pausa-inicio")); // a leitura em voz alta do painel para
    dialogo.showModal();
    botaoComecar.focus();
  }

  function fecharPausa({ adiarMin = 0 } = {}) {
    clearInterval(pausa.cronometro);
    pausa.cronometro = null;
    // Adiar: faltam só alguns minutos para a próxima; nos demais casos, o ciclo recomeça.
    pausa.ativoMs = adiarMin ? Math.max(0, pausa.intervaloMin - adiarMin) * 60000 : 0;
    pausa.ultimaMarca = Date.now();
    if (dialogo.open) dialogo.close();
    atualizarStatus();
  }

  function comecarContagem() {
    let restante = DURACAO_PAUSA_S;
    botaoComecar.hidden = true;
    progresso.hidden = false;
    contagem.hidden = false;
    const barra = progresso.firstElementChild;
    const passo = () => {
      progresso.setAttribute("aria-valuenow", String(DURACAO_PAUSA_S - restante));
      barra.style.width = `${((DURACAO_PAUSA_S - restante) / DURACAO_PAUSA_S) * 100}%`;
      contagem.textContent = restante > 0 ? `${restante} segundos` : "Pausa concluída. Quando estiver pronto, volte ao material.";
    };
    passo();
    anunciar("Pausa iniciada: um minuto.");
    pausa.cronometro = setInterval(() => {
      restante--;
      passo();
      if (restante <= 0) {
        clearInterval(pausa.cronometro);
        pausa.cronometro = null;
        botaoComecar.hidden = false;
        botaoComecar.dataset.fase = "concluida";
        botaoComecar.textContent = "Voltar ao material";
        botaoComecar.focus();
        anunciar("Pausa concluída.");
      }
    }, 1000);
  }

  dialogo.addEventListener("click", (e) => {
    const acao = e.target.closest("[data-acao]")?.dataset.acao;
    if (acao === "comecar") { if (botaoComecar.dataset.fase === "concluida") fecharPausa(); else comecarContagem(); }
    else if (acao === "adiar") { fecharPausa({ adiarMin: ADIAR_MIN }); anunciar(`Pausa adiada por ${ADIAR_MIN} minutos.`); }
    else if (acao === "pular") fecharPausa();
  });
  dialogo.addEventListener("cancel", () => fecharPausa()); // Esc

  seletorPausa?.addEventListener("change", () => {
    pausa.intervaloMin = Number(seletorPausa.value) || 0;
    pausa.ativoMs = 0;
    pausa.ultimaMarca = Date.now();
    salvarConfig({ pausa: pausa.intervaloMin });
    atualizarStatus();
    anunciar(pausa.intervaloMin ? `Pausa regulatória a cada ${pausa.intervaloMin} minutos.` : "Pausa regulatória desligada.");
  });
  document.addEventListener("visibilitychange", marcarTempo);
  setInterval(marcarTempo, 15000);

  /* ======================================================================
   * Estado inicial
   * ==================================================================== */

  if (seletorPausa) seletorPausa.value = String(pausa.intervaloMin);
  atualizarStatus();
  if (lerConfig().regua) ativarRegua(true, { avisar: false });
})();
