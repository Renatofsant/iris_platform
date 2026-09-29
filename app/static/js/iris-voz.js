/**
 * Íris Voice — assistente de voz universal da Plataforma Íris.
 *
 * Uso: <script src="/static/js/iris-voz.js" defer
 *              data-endpoint="/api/inclusao/voz/perguntar"   (opcional: tira-dúvidas com IA; exige login)
 *              data-conteudo="main"></script>                (opcional: onde está o conteúdo da página)
 *
 * • Ouve com SpeechRecognition (Chrome/Edge). TODA mensagem da Íris no chat é falada com
 *   speechSynthesis.speak() — com cancelamento do áudio anterior e contornos para falhas conhecidas
 *   do Chrome — e pode ser repetida pelo botão "Repetir áudio" da própria mensagem.
 * • Comandos sobre a tela são resolvidos localmente: ler questão N do quiz, ler/explicar a etapa N do
 *   experimento, ler o texto adaptado, o resumo, o glossário, o mapa; velocidade; parar; limpar conversa.
 * • Tira-dúvidas aberto: vai ao servidor com a seção visível e a memória da conversa (sessionStorage,
 *   até 8 turnos). A resposta traz fundamentação para o mediador, referências de um catálogo fixo e,
 *   quando pedida, uma ilustração em DADOS (diagrama de forças, gráfico ou esquema Mermaid) desenhada
 *   aqui em SVG, sempre com audiodescrição.
 * • Modo viva-voz (opcional, comutador abaixo do microfone): escuta contínua da palavra "Íris" / "Ei, Íris"
 *   em qualquer ponto da fala. Ao ouvi-la, a janela se expande (700×600, borda luminosa), toca um sinal
 *   e a pergunta é enviada sozinha após 1,8 s de silêncio. "Íris, minimizar" (ou "fechar") desliga a
 *   escuta e recolhe a janela; "Íris, limpar conversa" apaga o histórico. O botão do microfone continua
 *   como alternativa física: no viva-voz, um toque dispensa a palavra de ativação.
 * • Atalho Alt+I abre o assistente; Esc fecha e interrompe a fala.
 * • A interface fica num Shadow DOM: o CSS da página não interfere nela, nem ela na página.
 */
(() => {
  if (window.__irisVoz) return;
  window.__irisVoz = true;

  const script = document.currentScript;
  const ENDPOINT = script?.dataset.endpoint || "";
  const SELETOR_CONTEUDO = script?.dataset.conteudo || "main";
  const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  const Reconhecimento = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TEM_FALA = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const CHAVE_PREFERENCIAS = "iris:voz:v1";
  const CHAVE_CONVERSA = "iris:voz:conversa:v1";
  const MAX_MENSAGENS = 30;
  const MAX_TURNOS_MEMORIA = 8;
  const VELOCIDADES = { devagar: 0.8, normal: 1, rapido: 1.3 };

  const ler = (armazenamento, chave) => { try { return JSON.parse(armazenamento.getItem(chave)); } catch { return null; } };
  const gravar = (armazenamento, chave, valor) => { try { armazenamento.setItem(chave, JSON.stringify(valor)); } catch { /* modo privado */ } };

  const estado = {
    aberto: false,
    modo: "parado",          // parado | ouvindo | pensando | falando
    velocidade: Number(ler(localStorage, CHAVE_PREFERENCIAS)?.velocidade) || 1,
    maosLivres: false,       // nunca persiste: o microfone só liga por ação explícita
    aguardandoComando: false,
    reconhecedor: null,
    sessaoFala: 0,
    falandoId: null,
    mensagens: (ler(sessionStorage, CHAVE_CONVERSA)?.mensagens || []).slice(-MAX_MENSAGENS),
    proximoId: 1,
  };
  estado.proximoId = estado.mensagens.reduce((m, msg) => Math.max(m, msg.id || 0), 0) + 1;
  const salvarPreferencias = () => gravar(localStorage, CHAVE_PREFERENCIAS, { velocidade: estado.velocidade });
  const salvarConversa = () => gravar(sessionStorage, CHAVE_CONVERSA, { mensagens: estado.mensagens.slice(-MAX_MENSAGENS) });

  /* ======================================================================
   * Interface
   * ==================================================================== */

  const estiloHospedeiro = document.createElement("style");
  estiloHospedeiro.textContent = "#iris-voz-raiz{position:fixed;left:16px;bottom:16px;z-index:2147483000}" +
    "@media print{#iris-voz-raiz{display:none!important}}";
  document.head.append(estiloHospedeiro);

  const raiz = document.createElement("div");
  raiz.id = "iris-voz-raiz";
  const sombra = raiz.attachShadow({ mode: "open" });
  const ICONE_ONDA = '<span class="onda" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
  sombra.innerHTML = `
<style>
  :host { all: initial; font: 15px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; color: #0f172a; }
  * { box-sizing: border-box; }
  button, input, select { font: inherit; }
  :focus-visible { outline: 3px solid #22d3ee; outline-offset: 2px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  .fab { position: relative; display: grid; place-items: center; width: 60px; height: 60px; border: 0; border-radius: 999px; cursor: pointer;
         color: #fff; background: linear-gradient(135deg, #4f46e5, #0891b2); box-shadow: 0 10px 25px rgb(79 70 229 / .45); }
  .fab:hover { filter: brightness(1.08); }
  .fab svg { width: 26px; height: 26px; }
  .fab .aro { position: absolute; inset: -6px; border-radius: 999px; border: 2px solid rgb(34 211 238 / .7); opacity: 0; }
  :host([data-modo="ouvindo"]) .fab .aro, :host([data-modo="falando"]) .fab .aro { opacity: 1; animation: pulso 1.4s ease-out infinite; }
  :host([data-modo="ouvindo"]) .fab { background: linear-gradient(135deg, #dc2626, #db2777); }
  @keyframes pulso { from { transform: scale(.9); opacity: .9; } to { transform: scale(1.35); opacity: 0; } }

  .painel { position: absolute; left: 0; bottom: 72px; width: min(400px, calc(100vw - 32px)); height: auto; max-height: min(680px, calc(100vh - 100px));
            display: flex; flex-direction: column; overflow: hidden; border-radius: 20px; background: #fff;
            border: 1px solid #e2e8f0; box-shadow: 0 25px 50px -12px rgb(15 23 42 / .45);
            interpolate-size: allow-keywords; /* Chrome/Edge: anima também a altura "auto" ↔ fixa */
            transition: width .3s ease-in-out, height .3s ease-in-out, border-color .3s ease-in-out, box-shadow .3s ease-in-out; }
  :host([data-largo]) .painel { width: min(760px, calc(100vw - 32px)); }
  /* Viva-voz em conversa: janela ampla e focada, com borda luminosa índigo/ciano */
  :host([data-expandido]) .painel { width: min(700px, calc(100vw - 32px)); height: min(600px, calc(100vh - 100px)); border-color: #818cf8;
            box-shadow: 0 0 0 2px rgb(34 211 238 / .55), 0 0 36px 4px rgb(99 102 241 / .4), 0 25px 50px -12px rgb(15 23 42 / .45); }
  :host([data-expandido][data-largo]) .painel { width: min(760px, calc(100vw - 32px)); }
  :host([data-expandido][data-modo="ouvindo"]) .painel { animation: brilho 2.4s ease-in-out infinite; }
  @keyframes brilho { 50% { box-shadow: 0 0 0 3px rgb(34 211 238 / .8), 0 0 48px 8px rgb(34 211 238 / .4), 0 25px 50px -12px rgb(15 23 42 / .45); } }
  .painel[hidden] { display: none; }
  .topo { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 16px; color: #fff; background: linear-gradient(135deg, #1e1b4b, #312e81 60%, #0e7490); }
  .topo h2 { margin: 0; font-size: 16px; font-weight: 700; }
  .topo p { margin: 0; font-size: 12.5px; color: #c7d2fe; }
  .topo .icone { margin-left: auto; display: flex; gap: 6px; }
  .topo .icone button { display: grid; place-items: center; width: 36px; height: 36px; border: 0; border-radius: 10px;
                        background: rgb(255 255 255 / .12); color: #fff; cursor: pointer; }
  .topo .icone button:hover { background: rgb(255 255 255 / .22); }
  .topo .icone svg { width: 18px; height: 18px; }

  /* Onda sonora animada: no topo e na mensagem que está sendo falada */
  .onda { display: inline-flex; align-items: flex-end; gap: 3px; height: 20px; }
  .onda i { width: 4px; height: 5px; border-radius: 2px; background: currentColor; }
  :host([data-modo="falando"]) .topo .onda i, :host([data-modo="ouvindo"]) .topo .onda i, .msg.falando .onda i { animation: barra .9s ease-in-out infinite; }
  .onda i:nth-child(2) { animation-delay: .15s !important; } .onda i:nth-child(3) { animation-delay: .3s !important; } .onda i:nth-child(4) { animation-delay: .45s !important; }
  @keyframes barra { 50% { height: 18px; } }
  .topo .onda { color: #67e8f9; }

  .acoes, .viva-voz, form, .sugestoes, .ajustes, .topo { flex-shrink: 0; }
  .log { flex: 1; min-height: 220px; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; background: #f8fafc; }
  .vazio { margin: auto; text-align: center; color: #64748b; font-size: 13.5px; }
  .msg { max-width: 94%; padding: 8px 12px; border-radius: 14px; overflow-wrap: anywhere; }
  .msg p { margin: 0; white-space: pre-wrap; }
  .msg .autor { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; opacity: .8; }
  .msg .autor .onda, .msg .autor .falando-rotulo { display: none; }
  .msg.falando .autor .onda { display: inline-flex; color: #0891b2; height: 14px; }
  .msg.falando .autor .falando-rotulo { display: inline; color: #0e7490; text-transform: none; letter-spacing: 0; font-weight: 600; }
  .msg.voce { align-self: flex-end; background: #4f46e5; color: #fff; border-bottom-right-radius: 4px; }
  .msg.iris { align-self: flex-start; background: #fff; border: 1px solid #e2e8f0; border-bottom-left-radius: 4px; }
  .msg.iris.falando { border-color: #22d3ee; box-shadow: 0 0 0 3px rgb(34 211 238 / .2); }
  .msg.aviso { align-self: stretch; max-width: none; background: #fffbeb; border: 1px solid #fcd34d; color: #78350f; font-size: 13.5px; }
  .repetir { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; padding: 4px 10px; border: 1px solid #c7d2fe; border-radius: 999px;
             background: #eef2ff; color: #3730a3; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .repetir svg { width: 14px; height: 14px; }

  figure.ilustracao { margin: 10px 0 0; padding: 10px; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; }
  figure.ilustracao figcaption { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-weight: 700; font-size: 13.5px; }
  figure.ilustracao .ampliar { flex-shrink: 0; padding: 2px 8px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; font-size: 12px; cursor: pointer; color: #334155; }
  figure.ilustracao .desenho svg { display: block; width: 100%; height: auto; }
  figure.ilustracao .desenho .carregando { margin: 12px 0; color: #64748b; font-size: 13px; }
  figure.ilustracao .descricao { margin: 6px 0 0; color: #475569; font-size: 12.5px; }

  details.fundamentacao { margin-top: 8px; padding: 6px 10px; border-radius: 10px; background: #f1f5f9; font-size: 13px; }
  details.fundamentacao summary { cursor: pointer; font-weight: 600; color: #334155; }
  details.fundamentacao p { margin: 6px 0 0; }
  details.fundamentacao ul { margin: 4px 0 0; padding-left: 18px; }
  details.fundamentacao .nota { color: #64748b; font-size: 11.5px; }

  .acoes { display: flex; gap: 8px; padding: 12px 16px 0; }
  .microfone { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 46px; border: 0; border-radius: 12px;
               cursor: pointer; font-weight: 700; color: #fff; background: #4f46e5; }
  .microfone[aria-pressed="true"] { background: #dc2626; }
  .microfone:disabled { background: #94a3b8; cursor: not-allowed; }
  .microfone svg { width: 20px; height: 20px; }
  .secundario { height: 46px; padding: 0 14px; border: 1px solid #cbd5e1; border-radius: 12px; background: #fff; color: #0f172a; cursor: pointer; font-weight: 600; }
  .secundario:disabled { opacity: .5; cursor: not-allowed; }

  /* Comutador do modo viva-voz */
  .viva-voz { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; padding: 10px 16px 0; }
  .viva-voz[hidden] { display: none; }
  .viva-voz button { display: inline-flex; align-items: center; gap: 10px; padding: 4px 4px 4px 0; border: 0; background: none;
                     color: #0f172a; font-weight: 700; cursor: pointer; }
  .viva-voz .trilho { position: relative; flex-shrink: 0; width: 40px; height: 22px; border-radius: 999px; background: #94a3b8; transition: background .2s; }
  .viva-voz .trilho i { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 999px; background: #fff;
                        box-shadow: 0 1px 2px rgb(15 23 42 / .35); transition: transform .2s; }
  .viva-voz [aria-checked="true"] .trilho { background: linear-gradient(135deg, #4f46e5, #0891b2); }
  .viva-voz [aria-checked="true"] .trilho i { transform: translateX(18px); }
  .viva-voz .dica { font-size: 12px; color: #475569; }

  form { display: flex; gap: 8px; padding: 10px 16px 0; }
  form input { flex: 1; min-width: 0; height: 42px; padding: 0 12px; border: 1px solid #cbd5e1; border-radius: 10px; color: #0f172a; background: #fff; }
  form button { height: 42px; padding: 0 14px; border: 0; border-radius: 10px; background: #0f172a; color: #fff; font-weight: 600; cursor: pointer; }

  .sugestoes { display: flex; gap: 6px; padding: 10px 16px 4px; margin: 0; list-style: none; overflow-x: auto; scrollbar-width: thin; }
  .sugestoes li { flex-shrink: 0; }
  .sugestoes button { white-space: nowrap; padding: 5px 10px; border: 1px solid #c7d2fe; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 12.5px; cursor: pointer; }

  .ajustes { display: block; padding: 8px 16px 12px; margin-top: 8px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #334155; }
  .ajustes summary { cursor: pointer; font-weight: 600; color: #475569; }
  .ajustes[open] summary { margin-bottom: 4px; }
  .ajustes label { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .ajustes .nota-rodape { margin-top: 8px; }
  .ajustes select { height: 32px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 0 6px; background: #fff; color: #0f172a; }
  .ajustes input[type="checkbox"] { width: 18px; height: 18px; accent-color: #4f46e5; }
  .nota-rodape { margin: 0; font-size: 11.5px; color: #64748b; }

  @media (prefers-reduced-motion: reduce) {
    .fab .aro, .onda i, .painel { animation: none !important; }
    .painel, .viva-voz .trilho, .viva-voz .trilho i { transition: none; }
    :host([data-modo="ouvindo"]) .fab .aro, :host([data-modo="falando"]) .fab .aro { opacity: .8; transform: scale(1.1); }
    .msg.falando .onda i { height: 12px; }
  }
</style>

<div class="painel" id="painel" role="dialog" aria-modal="false" aria-labelledby="titulo" hidden>
  <div class="topo">
    ${ICONE_ONDA}
    <div>
      <h2 id="titulo">Íris Voice</h2>
      <p id="situacao" aria-live="polite">Pronta para ajudar.</p>
    </div>
    <div class="icone">
      <button type="button" id="limpar" aria-label="Limpar conversa" title="Limpar conversa">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>
      </button>
      <button type="button" id="fechar" aria-label="Fechar o assistente de voz" title="Fechar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
  </div>
  <div class="log" id="log" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversa com a Íris" tabindex="0"></div>
  <div class="acoes">
    <button type="button" class="microfone" id="microfone" aria-pressed="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg>
      <span id="microfone-rotulo">Falar com a Íris</span>
    </button>
    <button type="button" class="secundario" id="parar" disabled>Parar voz</button>
  </div>
  <div class="viva-voz" id="linha-viva-voz">
    <button type="button" role="switch" id="viva-voz" aria-checked="false" aria-describedby="viva-voz-dica">
      <span class="trilho" aria-hidden="true"><i></i></span> Modo Viva-Voz
    </button>
    <span class="dica" id="viva-voz-dica">Diga “Íris” ou “Ei, Íris” e pergunte; envio automático na pausa.</span>
  </div>
  <form id="formulario" autocomplete="off">
    <label for="pergunta" class="sr">Digite um comando ou pergunta</label>
    <input id="pergunta" type="text" maxlength="500" placeholder="Pergunte ou peça: mostre um diagrama…">
    <button type="submit">Enviar</button>
  </form>
  <ul class="sugestoes" id="sugestoes" aria-label="Sugestões de comandos"></ul>
  <details class="ajustes">
    <summary>Ajustes de voz e privacidade</summary>
    <label>Velocidade da voz
      <select id="velocidade">
        <option value="0.8">Devagar</option>
        <option value="1">Normal</option>
        <option value="1.3">Rápida</option>
      </select>
    </label>
    <p class="nota-rodape" id="nota-privacidade"></p>
  </details>
</div>

<button type="button" class="fab" id="abrir" aria-expanded="false" aria-controls="painel" aria-keyshortcuts="Alt+I"
        aria-label="Íris Voice: assistente de voz (atalho Alt+I)">
  <span class="aro" aria-hidden="true"></span>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/><path d="M2 10v3M22 10v3" opacity=".6"/></svg>
</button>`;

  const $ = (id) => sombra.getElementById(id);
  const ui = {
    painel: $("painel"), abrir: $("abrir"), fechar: $("fechar"), limpar: $("limpar"), log: $("log"), situacao: $("situacao"),
    microfone: $("microfone"), microfoneRotulo: $("microfone-rotulo"), parar: $("parar"),
    formulario: $("formulario"), pergunta: $("pergunta"), sugestoes: $("sugestoes"),
    velocidade: $("velocidade"), vivaVoz: $("viva-voz"), linhaVivaVoz: $("linha-viva-voz"), nota: $("nota-privacidade"),
  };

  /** Cria elemento com texto sempre como texto (nunca HTML). */
  function el(tag, atributos = {}, ...filhos) {
    const elemento = document.createElement(tag);
    for (const [nome, valor] of Object.entries(atributos)) {
      if (valor == null || valor === false) continue;
      if (nome === "class") elemento.className = valor; else elemento.setAttribute(nome, valor === true ? "" : String(valor));
    }
    for (const filho of filhos.flat()) {
      if (filho == null || filho === false) continue;
      elemento.append(filho instanceof Node ? filho : document.createTextNode(String(filho)));
    }
    return elemento;
  }

  function montar() {
    document.body.append(raiz);
    ui.velocidade.value = String(estado.velocidade);
    if (!Reconhecimento) {
      ui.microfone.disabled = true;
      ui.microfoneRotulo.textContent = "Voz indisponível neste navegador";
      ui.linhaVivaVoz.hidden = true;
      ui.nota.textContent = "Seu navegador não reconhece voz (use Chrome ou Edge). Você pode digitar os pedidos.";
    } else {
      ui.nota.textContent = "O reconhecimento de voz é feito pelo navegador e pode enviar o áudio ao serviço do fabricante (Google ou Microsoft).";
    }
    montarSugestoes();
    renderizarLog();
  }

  function montarSugestoes() {
    const lista = paginaDeAdaptacao()
      ? ["Leia o texto adaptado", "Leia a questão 1 do quiz", "Explique a primeira etapa do experimento",
        "Mostre um diagrama da segunda lei de Newton", "Limpar conversa"]
      : ["Leia esta página", "Leia o título", "Ajuda", "Limpar conversa"];
    ui.sugestoes.replaceChildren(...lista.map((texto) => {
      const botao = el("button", { type: "button" }, texto);
      botao.addEventListener("click", () => processar(texto));
      return el("li", {}, botao);
    }));
  }

  function definirModo(modo, mensagem) {
    estado.modo = modo;
    raiz.setAttribute("data-modo", modo);
    if (mensagem) ui.situacao.textContent = mensagem;
    atualizarMicrofone();
    ui.parar.disabled = modo !== "falando";
  }

  /** Botão físico do microfone. No viva-voz ele vira "Falar agora": dispensa a palavra de ativação. */
  function atualizarMicrofone() {
    const ativo = estado.maosLivres ? estado.aguardandoComando : estado.modo === "ouvindo";
    ui.microfone.setAttribute("aria-pressed", String(ativo));
    ui.microfoneRotulo.textContent = !Reconhecimento ? "Voz indisponível neste navegador"
      : estado.maosLivres ? (ativo ? "Ouvindo… toque para cancelar" : "Falar agora")
        : ativo ? "Ouvindo… toque para parar" : "Falar com a Íris";
  }

  /** Janela ampla (700×600) durante a conversa por voz; compacta ao minimizar ou desligar o áudio. */
  const expandir = (sim) => raiz.toggleAttribute("data-expandido", sim);

  const MSG_VIVA_VOZ = "Viva-voz: diga “Íris” ou “Ei, Íris”.";

  function definirVivaVoz(ligado) {
    estado.maosLivres = ligado;
    estado.aguardandoComando = false;
    ui.vivaVoz.setAttribute("aria-checked", String(ligado));
    if (!ligado) expandir(false);
    atualizarMicrofone();
  }

  /* Sinal sonoro curto ao reconhecer "Íris": confirmação para quem não vê a janela crescer.
     O AudioContext nasce no clique que liga o viva-voz (os navegadores exigem um gesto). */
  let contextoAudio = null;
  function prepararSinal() {
    try { contextoAudio ||= new (window.AudioContext || window.webkitAudioContext)(); contextoAudio.resume?.(); } catch { contextoAudio = null; }
  }
  function sinalSonoro() {
    if (!contextoAudio) return;
    try {
      const agora = contextoAudio.currentTime;
      const oscilador = contextoAudio.createOscillator();
      const ganho = contextoAudio.createGain();
      oscilador.frequency.setValueAtTime(660, agora);
      oscilador.frequency.linearRampToValueAtTime(990, agora + 0.12);
      ganho.gain.setValueAtTime(0.0001, agora);
      ganho.gain.exponentialRampToValueAtTime(0.12, agora + 0.02);
      ganho.gain.exponentialRampToValueAtTime(0.0001, agora + 0.2);
      oscilador.connect(ganho).connect(contextoAudio.destination);
      oscilador.start(agora);
      oscilador.stop(agora + 0.22);
    } catch { /* sem áudio: a mensagem "Ouvindo…" continua valendo */ }
  }

  /* ======================================================================
   * Mensagens (memória da sessão)
   * ==================================================================== */

  /** Texto falado de uma mensagem da Íris: a resposta + a audiodescrição da ilustração, se houver. */
  const textoFalado = (msg) => [msg.texto, msg.ilustracao?.descricao_textual ? `Descrição da ilustração: ${msg.ilustracao.descricao_textual}` : ""]
    .filter(Boolean).join(" ");

  function adicionar(tipo, texto, extras = {}) {
    const msg = { id: estado.proximoId++, tipo, texto, ...extras };
    estado.mensagens.push(msg);
    while (estado.mensagens.length > MAX_MENSAGENS) estado.mensagens.shift();
    salvarConversa();
    ui.log.querySelector(".vazio")?.remove();
    ui.log.append(renderizarMensagem(msg));
    while (ui.log.children.length > MAX_MENSAGENS) ui.log.firstElementChild.remove();
    ui.log.scrollTop = ui.log.scrollHeight;
    return msg;
  }

  function renderizarLog() {
    ui.log.replaceChildren(...(estado.mensagens.length
      ? estado.mensagens.map(renderizarMensagem)
      : [el("p", { class: "vazio" }, "Converse comigo por voz ou digitando. Posso ler o material, tirar dúvidas de Física e mostrar diagramas.")]));
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function renderizarMensagem(msg) {
    if (msg.tipo === "voce") {
      return el("div", { class: "msg voce", "data-id": msg.id }, el("div", { class: "autor" }, "Você"), el("p", {}, msg.texto));
    }
    const caixa = el("div", { class: `msg ${msg.tipo}${estado.falandoId === msg.id ? " falando" : ""}`, "data-id": msg.id },
      el("div", { class: "autor" }, msg.tipo === "aviso" ? "Aviso" : "Íris", el("span", { "aria-hidden": "true", class: "onda-msg" }),
        el("span", { class: "falando-rotulo" }, "Falando…")),
      el("p", {}, msg.texto));
    caixa.querySelector(".onda-msg").outerHTML = ICONE_ONDA;
    if (msg.ilustracao) caixa.append(renderizarIlustracao(msg.ilustracao));
    if (msg.fundamentacao || msg.referencias?.length) {
      caixa.append(el("details", { class: "fundamentacao" },
        el("summary", {}, "Fundamentação para o mediador"),
        msg.nome_area ? el("p", {}, el("b", {}, "Área: "), msg.nome_area) : null,
        msg.fundamentacao ? el("p", {}, msg.fundamentacao) : null,
        msg.referencias?.length ? [el("p", {}, el("b", {}, "Referências")), el("ul", {}, msg.referencias.map((r) => el("li", {}, r)))] : null,
        msg.aviso_referencias ? el("p", { class: "nota" }, msg.aviso_referencias) : null));
    }
    const repetir = el("button", { type: "button", class: "repetir", "aria-label": "Repetir o áudio desta mensagem" });
    repetir.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
    repetir.append("Repetir áudio");
    repetir.addEventListener("click", () => falar(textoFalado(msg), msg.id));
    caixa.append(repetir);
    return caixa;
  }

  /** Toda resposta da Íris passa por aqui: vai para o chat E é falada. */
  function responder(texto, extras = {}, tipo = "iris") {
    const msg = adicionar(tipo, texto, extras);
    falar(textoFalado(msg), msg.id);
    return msg;
  }

  function historicoParaServidor() {
    // Últimos turnos antes da pergunta atual (que acabou de entrar no chat).
    return estado.mensagens.slice(0, -1)
      .filter((m) => m.tipo === "voce" || m.tipo === "iris")
      .slice(-MAX_TURNOS_MEMORIA)
      .map((m) => ({ papel: m.tipo === "voce" ? "estudante" : "iris", texto: m.texto.slice(0, 600) }));
  }

  function limparConversa({ confirmar = true } = {}) {
    pararFala();
    estado.mensagens = [];
    estado.aguardandoComando = false;
    try { sessionStorage.removeItem(CHAVE_CONVERSA); } catch { /* modo privado */ }
    raiz.removeAttribute("data-largo");
    renderizarLog();
    if (confirmar) responder("Conversa apagada. Comecei do zero: como posso ajudar?");
  }

  function abrirPainel({ ouvir = false } = {}) {
    estado.aberto = true;
    ui.painel.hidden = false;
    ui.abrir.setAttribute("aria-expanded", "true");
    if (!estado.mensagens.length) responder("Olá! Eu sou a Íris. Toque em “Falar com a Íris” ou digite um pedido, como “leia a questão 2 do quiz” ou “mostre um diagrama da segunda lei de Newton”.");
    (Reconhecimento ? ui.microfone : ui.pergunta).focus();
    if (ouvir && Reconhecimento) ouvir1Vez();
  }

  function fecharPainel() {
    estado.aberto = false;
    ui.painel.hidden = true;
    ui.abrir.setAttribute("aria-expanded", "false");
    pararTudo();
    ui.abrir.focus();
  }

  /* ======================================================================
   * Fala (speechSynthesis) — robusta às falhas conhecidas do Chrome:
   *  • speak() logo após cancel() pode ser descartado → pequeno atraso;
   *  • utterances coletadas pelo GC antes do onend → referências mantidas em `vivas`;
   *  • fila presa em "paused" → resume() antes de falar;
   *  • falas longas cortadas (~15 s) → trechos curtos;
   *  • algumas vozes nunca disparam onend → vigia por tempo.
   * ==================================================================== */

  const vivas = [];
  let vozes = TEM_FALA ? window.speechSynthesis.getVoices() : [];
  if (TEM_FALA) window.speechSynthesis.addEventListener?.("voiceschanged", () => { vozes = window.speechSynthesis.getVoices(); });

  function vozPortugues() {
    if (!vozes.length && TEM_FALA) vozes = window.speechSynthesis.getVoices();
    const ptBr = vozes.filter((v) => /^pt[-_]BR$/i.test(v.lang));
    return ptBr.find((v) => /natural|online|neural|google|francisca|antonio|luciana/i.test(v.name))
      || ptBr[0] || vozes.find((v) => /^pt/i.test(v.lang)) || null;
  }

  /** Símbolos e unidades por extenso, para a síntese de voz não soletrar nem pular. */
  function prepararParaFala(texto) {
    return texto
      .replace(/[*_#`>]+/g, " ")
      .replace(/m\/s²/g, " metros por segundo ao quadrado")
      .replace(/m\/s\b/g, " metros por segundo")
      .replace(/km\/h\b/g, " quilômetros por hora")
      .replace(/Δ/g, " delta ")
      .replace(/²/g, " ao quadrado").replace(/³/g, " ao cubo")
      .replace(/\s[·×]\s|(?<=\w)[·×](?=\w)/g, " vezes ")
      .replace(/\s=\s/g, " igual a ").replace(/≈/g, " aproximadamente ").replace(/→/g, " resulta em ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function dividir(texto, limite = 170) {
    const frases = texto.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) || [texto];
    const trechos = [];
    let atual = "";
    for (let frase of frases.map((f) => f.trim())) {
      while (frase.length > limite) {
        const corte = Math.max(frase.lastIndexOf(",", limite), frase.lastIndexOf(" ", limite), limite / 2);
        if (atual) { trechos.push(atual); atual = ""; }
        trechos.push(frase.slice(0, corte + 1).trim());
        frase = frase.slice(corte + 1).trim();
      }
      if ((`${atual} ${frase}`).length > limite) { trechos.push(atual); atual = frase; } else { atual = atual ? `${atual} ${frase}` : frase; }
    }
    if (atual) trechos.push(atual);
    return trechos.filter(Boolean);
  }

  function marcarFalando(id) {
    estado.falandoId = id;
    ui.log.querySelectorAll(".msg.falando").forEach((m) => m.classList.remove("falando"));
    if (id != null) ui.log.querySelector(`.msg[data-id="${id}"]`)?.classList.add("falando");
  }

  let avisouSemFala = false;

  function falar(texto, idMensagem = null) {
    if (!TEM_FALA) {
      if (!avisouSemFala) { avisouSemFala = true; adicionar("aviso", "Este navegador não tem síntese de voz: as respostas aparecem só em texto."); }
      retomarEscuta(); // sem fala, o viva-voz volta a ouvir na hora
      return;
    }
    const synth = window.speechSynthesis;
    const sessao = ++estado.sessaoFala;
    synth.cancel();                                        // cancela qualquer áudio anterior pendente
    vivas.length = 0;
    pausarEscuta();                                        // não ouvir a própria voz
    document.dispatchEvent(new CustomEvent("iris:voz-fala")); // a leitura em voz alta da página se cala
    const trechos = dividir(prepararParaFala(texto));
    if (!trechos.length) { retomarEscuta(); return; }
    marcarFalando(idMensagem);
    definirModo("falando", "Falando…");

    let indice = 0;
    let tentativas = 0;
    let vigia = null;

    const terminar = () => {
      window.clearTimeout(vigia);
      if (sessao !== estado.sessaoFala) return;
      vivas.length = 0;
      marcarFalando(null);
      definirModo("parado", "Pronta para ajudar.");
      retomarEscuta();
    };

    const falarTrecho = () => {
      if (sessao !== estado.sessaoFala) return;
      if (indice >= trechos.length) { terminar(); return; }
      const trecho = trechos[indice];
      const fala = new SpeechSynthesisUtterance(trecho);
      fala.lang = "pt-BR";
      const voz = vozPortugues();
      if (voz) fala.voice = voz;
      fala.rate = estado.velocidade;
      fala.pitch = 1;
      fala.volume = 1;
      let resolvido = false;

      const avancar = () => {
        if (resolvido || sessao !== estado.sessaoFala) return;
        resolvido = true;
        window.clearTimeout(vigia);
        indice++;
        tentativas = 0;
        falarTrecho();
      };
      fala.onend = avancar;
      fala.onerror = (evento) => {
        if (resolvido || sessao !== estado.sessaoFala) return;
        if (evento.error === "not-allowed") {
          // Política de reprodução automática: o navegador exige um toque antes de falar.
          resolvido = true;
          adicionar("aviso", "O navegador bloqueou o áudio. Toque em “Repetir áudio” para ouvir a resposta.");
          terminar();
          return;
        }
        if ((evento.error === "interrupted" || evento.error === "canceled") && tentativas < 1) {
          // Interrupção espúria do Chrome (a sessão continua a mesma): tenta o mesmo trecho de novo.
          resolvido = true;
          window.clearTimeout(vigia);
          tentativas++;
          window.setTimeout(falarTrecho, 120);
          return;
        }
        avancar(); // outros erros: pula o trecho em vez de travar
      };

      vivas.push(fala);
      if (synth.paused) synth.resume();
      synth.speak(fala);

      // Vigia: se a voz não sinalizar o fim, segue para o próximo trecho.
      const previsto = (trecho.length * 80) / estado.velocidade + 4000;
      let prorrogacoes = 0;
      const vigiar = () => {
        if (resolvido || sessao !== estado.sessaoFala) return;
        if (synth.speaking && prorrogacoes < 2) { prorrogacoes++; vigia = window.setTimeout(vigiar, previsto / 2); return; }
        resolvido = true;
        indice++;
        tentativas = 0;
        synth.cancel();
        window.setTimeout(falarTrecho, 80);
      };
      vigia = window.setTimeout(vigiar, previsto);
    };

    window.setTimeout(falarTrecho, 60);
  }

  function pararFala() {
    estado.sessaoFala++;
    vivas.length = 0;
    if (TEM_FALA) window.speechSynthesis.cancel();
    marcarFalando(null);
    if (estado.modo === "falando") definirModo("parado", "Pronta para ajudar.");
  }

  /* ======================================================================
   * Escuta (SpeechRecognition)
   * ==================================================================== */

  /* Viva-voz: a escuta é contínua e o reconhecedor acumula resultados (parciais e finais).
     `consumido` marca até onde o texto já foi enviado ou descartado; um reconhecedor novo recomeça do zero. */
  const SILENCIO_MS = 1800;          // pausa de fala que envia a pergunta
  const ESPERA_COMANDO_MS = 8000;    // "Íris" dito sem pergunta: desiste depois disso
  const escuta = { consumido: 0, total: 0, comando: "", silencio: null, expira: null };

  function zerarEscuta() {
    window.clearTimeout(escuta.silencio);
    window.clearTimeout(escuta.expira);
    Object.assign(escuta, { consumido: 0, total: 0, comando: "", silencio: null, expira: null });
  }

  function criarReconhecedor(continuo) {
    const rec = new Reconhecimento();
    rec.lang = "pt-BR";
    rec.interimResults = true;
    rec.continuous = continuo;
    rec.maxAlternatives = 1;
    rec.onresult = (evento) => {
      if (estado.reconhecedor !== rec) return;
      if (continuo) { aoOuvirContinuo(evento.results); return; }
      let parcial = "";
      for (let i = evento.resultIndex; i < evento.results.length; i++) {
        const trecho = evento.results[i][0].transcript;
        if (evento.results[i].isFinal) aoOuvir(trecho);
        else parcial += trecho;
      }
      if (parcial) ui.situacao.textContent = `Ouvindo: “${parcial.trim()}”`;
    };
    rec.onerror = (evento) => {
      const mensagens = {
        "not-allowed": "O microfone está bloqueado. Libere o acesso ao microfone nas permissões do navegador.",
        "service-not-allowed": "O reconhecimento de voz não está disponível. Digite seu pedido.",
        "audio-capture": "Não encontrei um microfone. Verifique se ele está conectado.",
        network: "Sem conexão com o serviço de reconhecimento de voz. Digite seu pedido.",
      };
      if (mensagens[evento.error]) {
        definirVivaVoz(false);
        responder(mensagens[evento.error], {}, "aviso");
      } else if (evento.error === "no-speech" && !estado.maosLivres) {
        ui.situacao.textContent = "Não ouvi nada. Tente de novo.";
      }
    };
    rec.onend = () => {
      if (estado.reconhecedor !== rec) return;
      estado.reconhecedor = null;
      if (estado.modo === "ouvindo") definirModo("parado", estado.maosLivres ? (estado.aguardandoComando ? "Ouvindo…" : MSG_VIVA_VOZ) : "Pronta para ajudar.");
      // O Chrome encerra a escuta contínua sozinho de tempos em tempos: no viva-voz, religa.
      if (estado.maosLivres && estado.modo === "parado") window.setTimeout(retomarEscuta, 250);
    };
    return rec;
  }

  function iniciarEscuta(continuo) {
    if (!Reconhecimento || estado.reconhecedor) return;
    const rec = criarReconhecedor(continuo);
    estado.reconhecedor = rec;
    zerarEscuta();
    try {
      rec.start();
      definirModo("ouvindo", !continuo ? "Pode falar…" : estado.aguardandoComando ? "Ouvindo…" : MSG_VIVA_VOZ);
      if (continuo && estado.aguardandoComando) armarExpiracao();
    } catch {
      estado.reconhecedor = null;
    }
  }

  function ouvir1Vez() {
    pararFala();
    iniciarEscuta(false);
  }

  function pausarEscuta() {
    const rec = estado.reconhecedor;
    estado.reconhecedor = null;
    zerarEscuta(); // nada pendente pode ser enviado depois que a escuta parou
    try { rec?.abort(); } catch { /* já parado */ }
    if (estado.modo === "ouvindo") definirModo("parado");
  }

  function retomarEscuta() {
    if (estado.maosLivres && estado.modo !== "falando" && !estado.reconhecedor) iniciarEscuta(true);
  }

  function pararTudo() {
    definirVivaVoz(false);
    pausarEscuta();
    pararFala();
    definirModo("parado", "Pronta para ajudar.");
  }

  /** "Íris", "Ei Íris", "Ok, Íris"… no início do pedido (para remover antes de interpretar). */
  const PALAVRA_DE_ATIVACAO = /^(?:(?:ok|ei|oi|ola|olá)[\s,]+)?[íi]ris(?!\p{L})[\s,.:!?]*/iu;
  /** A mesma palavra em qualquer ponto da fala contínua: remove tudo até ela (inclusive), pela 1ª ocorrência. */
  const ATE_PALAVRA_DE_ATIVACAO = /^(?:.*?[\s,.;:!?])??(?:(?:ok|ei|oi|ola|olá)[\s,]+)?[íi]ris(?!\p{L})[\s,.:!?]*/isu;

  /** Viva-voz entra em conversa: janela ampla, "Ouvindo…" e sinal sonoro. */
  function engajar() {
    estado.aguardandoComando = true;
    expandir(true);
    ui.situacao.textContent = "Ouvindo…";
    atualizarMicrofone();
    sinalSonoro();
    armarExpiracao();
  }

  /** Volta a esperar a palavra de ativação; o que já foi ouvido é descartado. */
  function desengajar() {
    estado.aguardandoComando = false;
    window.clearTimeout(escuta.silencio);
    window.clearTimeout(escuta.expira);
    escuta.consumido = escuta.total;
    escuta.comando = "";
    if (estado.maosLivres) ui.situacao.textContent = MSG_VIVA_VOZ;
    atualizarMicrofone();
  }

  function armarExpiracao() {
    window.clearTimeout(escuta.expira);
    escuta.expira = window.setTimeout(() => { if (estado.aguardandoComando && !escuta.comando) desengajar(); }, ESPERA_COMANDO_MS);
  }

  function aoOuvirContinuo(resultados) {
    const lista = [...resultados];
    escuta.total = lista.length;
    const texto = lista.slice(escuta.consumido).map((r) => r[0].transcript).join(" ").replace(/\s+/g, " ").trim();
    if (!texto) return;
    const temPalavra = ATE_PALAVRA_DE_ATIVACAO.test(texto);

    if (!estado.aguardandoComando) {
      if (!temPalavra) {
        // Conversa da sala sem "Íris": ignora, e o trecho já finalizado sai da conta.
        if (lista.at(-1).isFinal) escuta.consumido = lista.length;
        return;
      }
      engajar();
    }

    escuta.comando = (temPalavra ? texto.replace(ATE_PALAVRA_DE_ATIVACAO, "") : texto).trim();
    ui.situacao.textContent = escuta.comando ? `Ouvindo: “${escuta.comando}”` : "Ouvindo…";
    armarExpiracao();
    // Cada novo trecho reinicia a contagem: a pergunta só vai depois de 1,8 s de silêncio.
    window.clearTimeout(escuta.silencio);
    escuta.silencio = window.setTimeout(enviarAposSilencio, SILENCIO_MS);
  }

  function enviarAposSilencio() {
    const comando = escuta.comando;
    if (!comando || !estado.aguardandoComando) return; // só disse "Íris": continua esperando a pergunta
    escuta.consumido = escuta.total;
    escuta.comando = "";
    estado.aguardandoComando = false;
    window.clearTimeout(escuta.expira);
    atualizarMicrofone();
    processar(comando);
  }

  /** Escuta de uma vez (botão do microfone, fora do viva-voz): cada frase final vira um pedido. */
  function aoOuvir(transcricao) {
    const texto = transcricao.trim();
    if (!texto) return;
    pausarEscuta();
    processar(texto);
  }

  /* ======================================================================
   * Leitura da tela
   * ==================================================================== */

  const paginaDeAdaptacao = () => Boolean(document.getElementById("iris-leitor"));
  const raizConteudo = () => document.querySelector(SELETOR_CONTEUDO) || document.querySelector("main") || document.body;

  /** Seção visível no painel de adaptação (aba ativa), com o nome da aba. */
  function secaoAtiva() {
    if (!paginaDeAdaptacao()) return { nome: document.title, elemento: raizConteudo() };
    const aba = document.querySelector('#iris-abas:not(.hidden) [role="tab"][aria-selected="true"]');
    const painel = aba && document.getElementById(aba.getAttribute("aria-controls"))?.querySelector(".iris-leitor");
    return { nome: aba ? aba.firstChild.textContent.trim() : "Texto adaptado", elemento: painel || document.getElementById("iris-leitor") };
  }

  /**
   * Texto legível de um elemento, mesmo em abas ocultas: uma cópia é medida fora da tela.
   * paraIA=true mantém as fórmulas como LaTeX (a IA entende); para a fala, elas saem.
   */
  function textoDe(elemento, { paraIA = false } = {}) {
    if (!elemento) return "";
    const copia = elemento.cloneNode(true);
    copia.querySelectorAll("button, input, select, textarea, script, style, svg, .iris-eyebrow, .iris-quiz-acoes, .iris-codigo-mermaid, .iris-mapa-grafico, .iris-distracoes, #iris-voz-raiz")
      .forEach((n) => n.remove());
    copia.querySelectorAll(".iris-math[data-latex]").forEach((m) => m.replaceWith(paraIA ? ` [fórmula: ${m.dataset.latex}] ` : ""));
    copia.querySelectorAll("mjx-container").forEach((n) => n.remove());
    copia.querySelectorAll("[hidden]").forEach((n) => n.removeAttribute("hidden"));
    copia.removeAttribute("id");
    copia.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    const caixa = document.createElement("div");
    caixa.setAttribute("aria-hidden", "true");
    caixa.style.cssText = "position:absolute;left:-99999px;top:0;width:800px";
    caixa.append(copia);
    document.body.append(caixa);
    const texto = caixa.innerText;
    caixa.remove();
    return texto.split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => (/[.!?:;…]$/.test(l) ? l : `${l}.`)).join("\n");
  }

  const semAcento = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  const NUMEROS = {
    um: 1, uma: 1, primeira: 1, primeiro: 1, dois: 2, duas: 2, segunda: 2, segundo: 2, tres: 3, terceira: 3, terceiro: 3,
    quatro: 4, quarta: 4, quarto: 4, cinco: 5, quinta: 5, quinto: 5, seis: 6, sexta: 6, sexto: 6, sete: 7, setima: 7, setimo: 7,
    oito: 8, oitava: 8, oitavo: 8, nove: 9, nona: 9, nono: 9, dez: 10, decima: 10, decimo: 10, ultima: -1, ultimo: -1,
  };

  function numeroApos(texto, palavras) {
    const depois = texto.match(new RegExp(`(?:${palavras})s?\\s+(?:de\\s+)?(?:numero\\s+|n\\.?\\s*)?(\\d+|[a-z]+)`));
    const antes = texto.match(new RegExp(`(\\d+|[a-z]+)\\s+(?:${palavras})`));
    for (const m of [depois, antes]) {
      if (!m) continue;
      const valor = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMEROS[m[1]];
      if (valor) return valor;
    }
    return null;
  }

  function questoesDoQuiz() {
    return [...document.querySelectorAll(".iris-questao")].map((q) => {
      const enunciado = (q.querySelector(".iris-enunciado")?.textContent || "").replace(/^\s*Questão\s+\d+\.\s*/i, "").trim();
      const alternativas = [...q.querySelectorAll(".iris-alternativas li")].map((li) => {
        const rotulo = li.querySelector(".iris-letra")?.textContent || "";
        const texto = li.textContent.replace(rotulo, "").trim();
        return `Alternativa ${rotulo.replace(/[)\s]/g, "")}: ${texto.replace(/\*\*/g, "").replace(/[.;:\s]+$/, "")}.`;
      });
      return { enunciado: enunciado.replace(/\*\*/g, ""), alternativas };
    });
  }

  function partesDoExperimento() {
    const partes = {};
    document.querySelectorAll(".iris-roteiro-parte").forEach((parte) => {
      const titulo = semAcento(parte.querySelector("h5")?.textContent || "");
      const itens = [...parte.querySelectorAll("li")].map((li) => li.textContent.trim());
      if (titulo.includes("passo")) partes.passos = itens;
      else if (titulo.includes("materiais")) partes.materiais = itens;
      else if (titulo.includes("perceber")) partes.perceber = itens;
      else if (titulo.includes("fisica")) partes.explicacao = parte.querySelector("p")?.textContent.trim();
    });
    return partes;
  }

  function primeiroTexto(seletores) {
    for (const s of seletores) {
      const texto = textoDe(document.querySelector(s));
      if (texto) return texto;
    }
    return "";
  }

  /* ======================================================================
   * Ilustrações: dados validados no servidor → SVG desenhado aqui
   * ==================================================================== */

  const NS = "http://www.w3.org/2000/svg";
  const CORES = ["#dc2626", "#2563eb", "#059669", "#d97706", "#7c3aed", "#db2777"];
  const TRACOS = ["", "6 3", "2 3", "8 3 2 3", "", "6 3"]; // a cor nunca é o único código
  let contadorSvg = 0;

  function svg(tag, atributos = {}, texto) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(atributos)) if (v != null) n.setAttribute(k, String(v));
    if (texto != null) n.textContent = texto;
    return n;
  }

  const formatarNumero = (n) => Number(n.toFixed(2)).toLocaleString("pt-BR");

  function desenhoBase(titulo, descricao, largura, altura) {
    const id = `ilu-${++contadorSvg}`;
    const raizSvg = svg("svg", { viewBox: `0 0 ${largura} ${altura}`, role: "img", "aria-labelledby": `${id}-t ${id}-d` });
    raizSvg.append(svg("title", { id: `${id}-t` }, titulo), svg("desc", { id: `${id}-d` }, descricao || titulo));
    return { raizSvg, id };
  }

  function diagramaForcas({ titulo, descricao_textual: descricao, objeto, vetores }) {
    const L = 340;
    const A = 260;
    const { raizSvg, id } = desenhoBase(titulo, descricao, L, A);
    const defs = svg("defs");
    CORES.forEach((cor, i) => {
      const marcador = svg("marker", { id: `${id}-seta-${i}`, viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
      marcador.append(svg("path", { d: "M0 0 L10 5 L0 10 z", fill: cor }));
      defs.append(marcador);
    });
    raizSvg.append(defs);
    const cx = L / 2;
    const cy = A / 2;
    const meiaL = 34;
    const meiaA = 24;
    raizSvg.append(
      svg("rect", { x: cx - meiaL, y: cy - meiaA, width: meiaL * 2, height: meiaA * 2, rx: 6, fill: "#e0e7ff", stroke: "#3730a3", "stroke-width": 2 }),
      svg("text", { x: cx, y: cy + 4, "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: "#1e1b4b" }, objeto),
    );
    vetores.forEach((v, i) => {
      const rad = (v.angulo_graus * Math.PI) / 180;
      const dx = Math.cos(rad);
      const dy = -Math.sin(rad); // eixo y do SVG aponta para baixo
      const t = Math.min(Math.abs(dx) > 1e-6 ? meiaL / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? meiaA / Math.abs(dy) : Infinity);
      const x1 = cx + dx * t;
      const y1 = cy + dy * t;
      const comprimento = 28 + v.intensidade * 62;
      const x2 = x1 + dx * comprimento;
      const y2 = y1 + dy * comprimento;
      const cor = CORES[i % CORES.length];
      raizSvg.append(svg("line", {
        x1, y1, x2, y2, stroke: cor, "stroke-width": 3.5, "stroke-linecap": "round",
        "stroke-dasharray": TRACOS[i % TRACOS.length] || null, "marker-end": `url(#${id}-seta-${i % CORES.length})`,
      }));
      const tx = x2 + dx * 12;
      const ty = y2 + dy * 12 + 4;
      raizSvg.append(svg("text", {
        x: Math.min(Math.max(tx, 4), L - 4), y: Math.min(Math.max(ty, 12), A - 4),
        "text-anchor": dx > 0.3 ? "start" : dx < -0.3 ? "end" : "middle", "font-size": 12, "font-weight": 700, fill: cor,
        stroke: "#fff", "stroke-width": 3, "paint-order": "stroke",
      }, v.rotulo));
    });
    return raizSvg;
  }

  function passoBonito(intervalo) {
    const bruto = intervalo / 5;
    const potencia = 10 ** Math.floor(Math.log10(bruto));
    const fracao = bruto / potencia;
    return (fracao <= 1 ? 1 : fracao <= 2 ? 2 : fracao <= 5 ? 5 : 10) * potencia;
  }

  function grafico({ titulo, descricao_textual: descricao, eixo_x: eixoX, eixo_y: eixoY, series }) {
    const L = 360;
    const A = 250;
    const m = { e: 50, d: 14, t: 14, b: 44 };
    const { raizSvg } = desenhoBase(titulo, descricao, L, A);
    const pontos = series.flatMap((s) => s.pontos);
    let xMin = Math.min(0, ...pontos.map((p) => p.x));
    let xMax = Math.max(...pontos.map((p) => p.x));
    let yMin = Math.min(0, ...pontos.map((p) => p.y));
    let yMax = Math.max(0, ...pontos.map((p) => p.y));
    if (xMax === xMin) xMax = xMin + 1;
    if (yMax === yMin) yMax = yMin + 1;
    const passoX = passoBonito(xMax - xMin);
    const passoY = passoBonito(yMax - yMin);
    xMin = Math.floor(xMin / passoX) * passoX; xMax = Math.ceil(xMax / passoX) * passoX;
    yMin = Math.floor(yMin / passoY) * passoY; yMax = Math.ceil(yMax / passoY) * passoY;
    const px = (x) => m.e + ((x - xMin) / (xMax - xMin)) * (L - m.e - m.d);
    const py = (y) => A - m.b - ((y - yMin) / (yMax - yMin)) * (A - m.t - m.b);

    const grade = svg("g", { stroke: "#e2e8f0", "stroke-width": 1 });
    const rotulos = svg("g", { "font-size": 10.5, fill: "#475569" });
    for (let x = xMin; x <= xMax + passoX / 2; x += passoX) {
      grade.append(svg("line", { x1: px(x), y1: m.t, x2: px(x), y2: A - m.b }));
      rotulos.append(svg("text", { x: px(x), y: A - m.b + 14, "text-anchor": "middle" }, formatarNumero(x)));
    }
    for (let y = yMin; y <= yMax + passoY / 2; y += passoY) {
      grade.append(svg("line", { x1: m.e, y1: py(y), x2: L - m.d, y2: py(y) }));
      rotulos.append(svg("text", { x: m.e - 6, y: py(y) + 3.5, "text-anchor": "end" }, formatarNumero(y)));
    }
    raizSvg.append(grade, rotulos,
      svg("line", { x1: m.e, y1: py(Math.max(yMin, Math.min(0, yMax))), x2: L - m.d, y2: py(Math.max(yMin, Math.min(0, yMax))), stroke: "#0f172a", "stroke-width": 1.5 }),
      svg("line", { x1: px(Math.max(xMin, 0)), y1: m.t, x2: px(Math.max(xMin, 0)), y2: A - m.b, stroke: "#0f172a", "stroke-width": 1.5 }),
      svg("text", { x: (m.e + L - m.d) / 2, y: A - 8, "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: "#0f172a" }, eixoX),
      svg("text", { x: 12, y: (m.t + A - m.b) / 2, "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: "#0f172a",
        transform: `rotate(-90 12 ${(m.t + A - m.b) / 2})` }, eixoY));

    const FORMAS = ["circle", "rect", "diamond"];
    series.forEach((s, i) => {
      const cor = CORES[(i + 1) % CORES.length];
      raizSvg.append(svg("polyline", {
        points: s.pontos.map((p) => `${px(p.x)},${py(p.y)}`).join(" "), fill: "none", stroke: cor, "stroke-width": 2.5,
        "stroke-dasharray": TRACOS[i] || null, "stroke-linejoin": "round",
      }));
      s.pontos.forEach((p) => raizSvg.append(marcadorPonto(FORMAS[i % 3], px(p.x), py(p.y), cor)));
      if (s.nome) {
        const ly = m.t + 6 + i * 16;
        raizSvg.append(marcadorPonto(FORMAS[i % 3], m.e + 14, ly, cor),
          svg("text", { x: m.e + 24, y: ly + 4, "font-size": 11, "font-weight": 600, fill: cor, stroke: "#fff", "stroke-width": 3, "paint-order": "stroke" }, s.nome));
      }
    });
    // Para a sonificação (audio_graph.js): ponto → coordenadas do SVG e faixa horizontal da área do gráfico.
    raizSvg.irisMapa = { pontoParaSvg: (p) => ({ x: px(p.x), y: py(p.y) }), areaX: [m.e / L, (L - m.d) / L] };
    return raizSvg;
  }

  function marcadorPonto(forma, x, y, cor) {
    if (forma === "rect") return svg("rect", { x: x - 3.5, y: y - 3.5, width: 7, height: 7, fill: cor });
    if (forma === "diamond") return svg("path", { d: `M${x} ${y - 4.5} L${x + 4.5} ${y} L${x} ${y + 4.5} L${x - 4.5} ${y} z`, fill: cor });
    return svg("circle", { cx: x, cy: y, r: 3.8, fill: cor });
  }

  let mermaidCarregando = null;
  function carregarMermaid() {
    mermaidCarregando ||= import(MERMAID_URL).then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "neutral",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" });
      return mermaid;
    }).catch((erro) => { mermaidCarregando = null; throw erro; });
    return mermaidCarregando;
  }

  async function desenharEsquema(codigo, destino, titulo) {
    const id = `iris-voz-mmd-${++contadorSvg}`;
    try {
      const mermaid = await carregarMermaid();
      const { svg: marcacao } = await mermaid.render(id, codigo);
      destino.innerHTML = marcacao; // SVG do Mermaid em modo strict (rótulos sanitizados)
      const desenho = destino.querySelector("svg");
      desenho?.setAttribute("role", "img");
      desenho?.setAttribute("aria-label", titulo);
      desenho?.removeAttribute("style");
    } catch {
      document.getElementById(`d${id}`)?.remove();
      destino.replaceChildren(el("p", { class: "carregando" }, "Não consegui desenhar o esquema; a descrição abaixo explica o conteúdo."));
    }
  }

  /** Sonificação e descrição sintética (static/js/audio_graph.js), carregada sob demanda. */
  const URL_AUDIO_GRAPH = script?.src ? new URL("audio_graph.js", script.src).href : "";
  let audioGraphCarregando = null;
  function carregarAudioGraph() {
    if (window.IrisAudioGraph) return Promise.resolve(window.IrisAudioGraph);
    if (!URL_AUDIO_GRAPH) return Promise.reject(new Error("sem endereço"));
    audioGraphCarregando ||= new Promise((resolver, rejeitar) => {
      const tag = document.createElement("script");
      tag.src = URL_AUDIO_GRAPH;
      tag.onload = () => (window.IrisAudioGraph ? resolver(window.IrisAudioGraph) : rejeitar(new Error("módulo ausente")));
      tag.onerror = () => { audioGraphCarregando = null; rejeitar(new Error("falha ao carregar")); };
      document.head.append(tag);
    });
    return audioGraphCarregando;
  }

  function renderizarIlustracao(ilu) {
    const desenho = el("div", { class: "desenho" });
    let figura = null;
    if (ilu.tipo === "diagrama_forcas" || ilu.tipo === "grafico") {
      const desenhoSvg = ilu.tipo === "grafico" ? grafico(ilu) : diagramaForcas(ilu);
      desenho.append(desenhoSvg);
      // Sem o módulo (offline), a figura continua com o desenho e a audiodescrição da IA.
      carregarAudioGraph().then((ag) => {
        if (!figura) return;
        if (ilu.tipo === "grafico") ag.anexarGrafico(figura, ilu, { svg: desenhoSvg, ...desenhoSvg.irisMapa });
        else ag.anexarForcas(figura, ilu);
      }).catch(() => {});
    } else {
      desenho.append(el("p", { class: "carregando" }, "Desenhando o esquema…"));
      desenharEsquema(ilu.codigo_mermaid, desenho, ilu.titulo);
    }
    const ampliar = el("button", { type: "button", class: "ampliar", "aria-pressed": raiz.hasAttribute("data-largo") ? "true" : "false" }, "Ampliar");
    ampliar.addEventListener("click", () => {
      const largo = !raiz.hasAttribute("data-largo");
      raiz.toggleAttribute("data-largo", largo);
      sombra.querySelectorAll(".ampliar").forEach((b) => { b.setAttribute("aria-pressed", String(largo)); b.textContent = largo ? "Reduzir" : "Ampliar"; });
    });
    if (raiz.hasAttribute("data-largo")) ampliar.textContent = "Reduzir";
    figura = el("figure", { class: "ilustracao" },
      el("figcaption", {}, el("span", {}, ilu.titulo), ampliar),
      desenho,
      ilu.descricao_textual ? el("p", { class: "descricao" }, ilu.descricao_textual) : null);
    return figura;
  }

  /* ======================================================================
   * Interpretação dos pedidos
   * ==================================================================== */

  const AJUDA = "Você pode pedir: leia o texto adaptado; leia a questão 2 do quiz; leia os materiais do experimento; " +
    "explique a primeira etapa do experimento; mostre um diagrama ou um gráfico; fale mais devagar; pare; limpar conversa. " +
    "Também pode fazer perguntas de Física, como: o que significa esta fórmula?";

  const PEDIDO_VISUAL = /\b(mostr\w*|desenh\w*|diagrama\w*|esquema\w*|grafico\w*|figura\w*|imagem|imagens|ilustr\w*)\b/;
  const LIMPAR = /\b(limpa|limpar|limpe|apaga|apagar|apague|zera|zerar|reinicia|reiniciar|nova)\s+(?:a\s+|o\s+|esta\s+|essa\s+)?(conversa|chat|historico|dialogo)\b/;
  // Frase inteira (não só o começo): "fechar o circuito…" continua sendo uma pergunta de Física.
  const MINIMIZAR = /^(fechar|feche|fecha|minimizar|minimize|minimiza|recolher|recolha|encolher|encolha)(\s+(a\s+|o\s+)?(janela|tela|assistente|chat|iris))?$/;

  /** "Íris, fechar" / "Íris, minimizar": desliga a escuta e a janela volta ao tamanho compacto. */
  function minimizar() {
    const estavaNoVivaVoz = estado.maosLivres;
    pausarEscuta();
    definirVivaVoz(false);
    raiz.removeAttribute("data-largo");
    responder(estavaNoVivaVoz ? "Viva-voz desligado. Toque no microfone quando precisar de mim." : "Janela recolhida.");
  }

  function ajustarVelocidade(t) {
    let nova = null;
    if (/devagar|lent[oa]|lentamente|mais calma/.test(t)) nova = VELOCIDADES.devagar;
    else if (/rapid[oa]|depressa|acelera\b/.test(t)) nova = VELOCIDADES.rapido;
    else if (/velocidade normal|ritmo normal|normalmente/.test(t)) nova = VELOCIDADES.normal;
    if (nova !== null) {
      estado.velocidade = nova;
      ui.velocidade.value = String(nova);
      salvarPreferencias();
    }
    return nova !== null;
  }

  async function processar(pedido) {
    const original = pedido.trim().replace(PALAVRA_DE_ATIVACAO, "");
    if (!original) return;
    if (!estado.aberto) abrirPainel();
    const t = semAcento(original).replace(/[.,!?;:]/g, " ").replace(/\s+/g, " ").trim();

    // Limpar conversa (antes de registrar o pedido, para o chat realmente começar do zero).
    if (LIMPAR.test(t)) { limparConversa(); return; }
    if (MINIMIZAR.test(t)) { minimizar(); return; }

    adicionar("voce", original);

    if (/^(pare|para|parar|silencio|chega|cancela|cancelar)\b/.test(t)) {
      responder("Tudo bem, parei."); // falar() já cancela o áudio anterior
      return;
    }
    if (/^(ajuda|comandos|o que (voce|vc) (faz|sabe fazer))/.test(t)) { responder(AJUDA); return; }

    // Pedido visual: sempre ao tira-dúvidas (a IA escolhe e monta a ilustração).
    if (PEDIDO_VISUAL.test(t)) {
      if (!ENDPOINT) { responder("As ilustrações ficam disponíveis dentro da plataforma, depois de entrar com sua conta."); return; }
      const secao = secaoAtiva();
      await perguntarIA(original, textoDe(secao.elemento, { paraIA: true }), secao.nome);
      return;
    }

    const mudouVelocidade = ajustarVelocidade(t);
    const pedeLeitura = /\b(leia|ler|le|releia|repita|repete|fale|diga)\b/.test(t);
    const pedeExplicacao = /\b(explique|explica|explicar|o que (e|significa|quer dizer)|por que|porque|como)\b/.test(t);

    // Quiz
    if (/\b(questao|questoes|pergunta|exercicio)\b/.test(t) && /quiz|questao|exercicio/.test(t)) {
      if (/\b(resposta|gabarito|correta|certa)\b/.test(t)) {
        responder("Tente responder primeiro! Escolha uma alternativa e use o botão Conferir. Se precisar, eu leio a questão de novo.");
        return;
      }
      const questoes = questoesDoQuiz();
      if (!questoes.length) { responder("Ainda não há um quiz nesta tela."); return; }
      const n = numeroApos(t, "questao|pergunta|exercicio") ?? 1;
      const indice = n === -1 ? questoes.length - 1 : n - 1;
      const q = questoes[indice];
      if (!q) { responder(`O quiz tem ${questoes.length} questões. Peça um número de 1 a ${questoes.length}.`); return; }
      responder(`Questão ${indice + 1}. ${q.enunciado} ${q.alternativas.join(" ")}`);
      return;
    }

    // Experimento
    if (/experimento|etapa|passo|materiais|material do experimento/.test(t) && document.querySelector(".iris-roteiro-parte")) {
      const exp = partesDoExperimento();
      if (/materia(is|l)/.test(t)) { responder(`Materiais do experimento: ${(exp.materiais || []).join("; ")}.`); return; }
      if (/perceber|sentir|ouvir|observar/.test(t) && exp.perceber) { responder(`O que perceber: ${exp.perceber.join(" ")}`); return; }
      const passos = exp.passos || [];
      const n = numeroApos(t, "etapa|passo|parte");
      if (n && passos.length) {
        const indice = n === -1 ? passos.length - 1 : n - 1;
        const passo = passos[indice];
        if (!passo) { responder(`O experimento tem ${passos.length} etapas.`); return; }
        const explicacaoLocal = `Etapa ${indice + 1}. ${passo}${pedeExplicacao && exp.explicacao ? ` A Física por trás: ${exp.explicacao}` : ""}`;
        if (pedeExplicacao && ENDPOINT) {
          const contexto = `Etapa ${indice + 1} do experimento: ${passo}\nExplicação física do experimento: ${exp.explicacao || ""}\n\n` +
            textoDe(document.getElementById("iris-leitor-experimento") || raizConteudo(), { paraIA: true });
          await perguntarIA(original, contexto, "Experimento", explicacaoLocal);
          return;
        }
        responder(explicacaoLocal);
        return;
      }
      if (pedeLeitura || !pedeExplicacao) {
        responder(textoDe(document.getElementById("iris-leitor-experimento")) || "Não encontrei o experimento nesta tela.");
        return;
      }
    }

    // Leituras diretas
    if (pedeLeitura) {
      const alvos = [
        [/resumo/, [".iris-resumo"]],
        [/glossario/, ['[data-bloco="glossario"]', '[data-bloco="glossario_ilustrado"]']],
        [/mapa/, ["#mapa-descricao"]],
        [/curiosidade/, ['[data-bloco="curiosidades"]']],
        [/titulo/, ["#iris-titulo", "h1"]],
        [/(esta |essa |a )?(secao|aba|parte)/, []],
        [/texto|material|conteudo|tudo|para mim|pagina|tela/, ["#iris-leitor"]],
      ];
      for (const [padrao, seletores] of alvos) {
        if (!padrao.test(t)) continue;
        const texto = seletores.length ? primeiroTexto(seletores) : textoDe(secaoAtiva().elemento);
        responder(texto || textoDe(raizConteudo()) || "Não encontrei conteúdo para ler.");
        return;
      }
    }

    if (mudouVelocidade && t.split(" ").length <= 6) {
      responder(`Certo, velocidade ${estado.velocidade < 1 ? "mais devagar" : estado.velocidade > 1 ? "mais rápida" : "normal"}.`);
      return;
    }

    // Tira-dúvidas aberto
    const secao = secaoAtiva();
    await perguntarIA(original, textoDe(secao.elemento, { paraIA: true }), secao.nome);
  }

  /** respostaLocal: usada quando o servidor responde sem IA real (simulação/fallback) ou falha. */
  async function perguntarIA(pergunta, contexto, secao, respostaLocal = null) {
    if (!ENDPOINT) { responder(buscaLocal(pergunta, contexto || textoDe(raizConteudo()))); return; }
    const historico = historicoParaServidor();
    pausarEscuta();
    definirModo("pensando", "Pensando…");
    try {
      const resposta = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pergunta, contexto: (contexto || "").slice(0, 8000), secao, historico }),
      });
      const json = await resposta.json().catch(() => null);
      definirModo("parado");
      if (!resposta.ok || !json?.sucesso) {
        responder(respostaLocal || json?.erro?.mensagem || buscaLocal(pergunta, contexto));
        return;
      }
      const d = json.dados;
      const extras = {
        fundamentacao: d.fundamentacao || "",
        referencias: d.referencias || [],
        aviso_referencias: d.referencias?.length ? d.aviso_referencias : "",
        nome_area: d.nome_area || "",
        ilustracao: d.ilustracao || null,
      };
      if (json.origem !== "ia" && respostaLocal) responder(respostaLocal, { ...extras, fundamentacao: "", referencias: [] });
      else responder(d.resposta, extras);
    } catch {
      definirModo("parado");
      responder(respostaLocal || buscaLocal(pergunta, contexto));
    }
  }

  /** Sem servidor: devolve a frase da página com mais palavras em comum com a pergunta. */
  function buscaLocal(pergunta, contexto) {
    const vazias = new Set(["iris", "que", "qual", "como", "para", "por", "significa", "explique", "esta", "este", "isso", "sobre", "uma", "voce", "pode"]);
    const palavras = new Set(semAcento(pergunta).match(/\w{3,}/g)?.filter((p) => !vazias.has(p)) || []);
    let melhor = "";
    let pontos = 0;
    for (const frase of (contexto || "").split(/(?<=[.!?])\s+|\n+/)) {
      if (frase.trim().length < 15) continue;
      const comuns = (semAcento(frase).match(/\w{3,}/g) || []).filter((p) => palavras.has(p)).length;
      if (comuns > pontos) { melhor = frase.trim(); pontos = comuns; }
    }
    return melhor ? `Encontrei isto na página: ${melhor}` : "Não encontrei essa informação nesta página. Diga “ajuda” para ouvir o que eu sei fazer.";
  }

  /* ======================================================================
   * Eventos
   * ==================================================================== */

  function ligarEventos() {
    ui.abrir.addEventListener("click", () => (estado.aberto ? fecharPainel() : abrirPainel()));
    ui.fechar.addEventListener("click", fecharPainel);
    ui.limpar.addEventListener("click", () => { limparConversa(); ui.pergunta.focus(); });
    ui.microfone.addEventListener("click", () => {
      if (estado.maosLivres) {
        // Fallback físico do viva-voz: o toque substitui a palavra "Íris" (ou cancela a pergunta em curso).
        if (estado.aguardandoComando) { desengajar(); return; }
        prepararSinal();
        pararFala();
        retomarEscuta();
        escuta.consumido = escuta.total; // o que foi dito antes do toque não entra na pergunta
        engajar();
        return;
      }
      if (estado.modo === "ouvindo") { pausarEscuta(); definirModo("parado", "Pronta para ajudar."); return; }
      ouvir1Vez();
    });
    ui.parar.addEventListener("click", () => { pararFala(); ui.microfone.focus(); });
    ui.formulario.addEventListener("submit", (evento) => {
      evento.preventDefault();
      const texto = ui.pergunta.value.trim();
      if (!texto) return;
      ui.pergunta.value = "";
      processar(texto);
    });
    ui.velocidade.addEventListener("change", () => { estado.velocidade = Number(ui.velocidade.value) || 1; salvarPreferencias(); });
    ui.vivaVoz.addEventListener("click", () => {
      const ligar = !estado.maosLivres;
      pausarEscuta();
      definirVivaVoz(ligar);
      if (ligar) {
        prepararSinal();
        // A escuta começa quando este aviso termina de ser falado (falar() → retomarEscuta()).
        responder("Modo viva-voz ligado: o microfone fica aberto enquanto esta janela estiver aberta. " +
          "Diga “Íris” ou “Ei, Íris” e faça a pergunta; eu envio sozinha quando você fizer uma pausa. " +
          "Para desligar, diga “Íris, minimizar”.", {}, "aviso");
      } else {
        definirModo("parado", "Pronta para ajudar.");
      }
    });
    sombra.addEventListener("keydown", (evento) => {
      if (evento.key === "Escape") { evento.stopPropagation(); fecharPainel(); }
    });
    document.addEventListener("keydown", (evento) => {
      if (evento.altKey && !evento.ctrlKey && !evento.metaKey && evento.code === "KeyI") {
        evento.preventDefault();
        if (estado.aberto) ui.microfone.focus(); else abrirPainel();
      }
    });
    // Outra leitura em voz alta da página começou: a Íris se cala.
    document.addEventListener("iris:leitura-inicio", pararFala);
    window.addEventListener("pagehide", () => { pausarEscuta(); if (TEM_FALA) window.speechSynthesis.cancel(); });
  }

  const iniciar = () => { montar(); ligarEventos(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
