/**
 * Plataforma Íris — fundo de partículas das telas de login e cadastro.
 *
 * Canvas nativo, sem dependências: nós luminosos (azul, ciano, violeta, branco) flutuam,
 * ligam-se por linhas de luz quando próximos e são atraídos suavemente pelo cursor.
 *
 * Desempenho e acessibilidade:
 *   • quantidade de partículas proporcional à área da tela (com teto);
 *   • pausa quando a aba fica oculta;
 *   • com "reduzir movimento" ativado no sistema, desenha um quadro estático;
 *   • o canvas é decorativo (aria-hidden) e não recebe cliques (pointer-events: none).
 */
(() => {
  const canvas = document.getElementById("particles-canvas");
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;

  const CORES = ["96, 165, 250", "34, 211, 238", "167, 139, 250", "226, 232, 240"]; // azul, ciano, violeta, branco
  const DISTANCIA_LIGACAO = 130;   // px entre partículas para desenhar uma linha
  const RAIO_CURSOR = 190;         // px de alcance do cursor
  const FORCA_ATRACAO = 0.018;
  const VELOCIDADE_MAX = 0.9;
  const AREA_POR_PARTICULA = 11000; // px² por partícula
  const MAX_PARTICULAS = 140;

  const movimentoReduzido = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cursor = { x: 0, y: 0, ativo: false };
  let largura = 0;
  let altura = 0;
  let particulas = [];
  let quadro = null;

  function criarParticula() {
    const angulo = Math.random() * Math.PI * 2;
    const velocidade = 0.12 + Math.random() * 0.28;
    return {
      x: Math.random() * largura,
      y: Math.random() * altura,
      vx: Math.cos(angulo) * velocidade,
      vy: Math.sin(angulo) * velocidade,
      raio: 1 + Math.random() * 1.8,
      cor: CORES[Math.floor(Math.random() * CORES.length)],
      fase: Math.random() * Math.PI * 2, // cintilar
    };
  }

  function redimensionar() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    largura = window.innerWidth;
    altura = window.innerHeight;
    canvas.width = Math.round(largura * dpr);
    canvas.height = Math.round(altura * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const alvo = Math.min(MAX_PARTICULAS, Math.round((largura * altura) / AREA_POR_PARTICULA));
    while (particulas.length < alvo) particulas.push(criarParticula());
    particulas.length = alvo;
    for (const p of particulas) {
      p.x = Math.min(p.x, largura);
      p.y = Math.min(p.y, altura);
    }
  }

  function atualizar() {
    for (const p of particulas) {
      if (cursor.ativo) {
        const dx = cursor.x - p.x;
        const dy = cursor.y - p.y;
        const distancia = Math.hypot(dx, dy);
        if (distancia < RAIO_CURSOR && distancia > 1) {
          const intensidade = (1 - distancia / RAIO_CURSOR) * FORCA_ATRACAO;
          p.vx += dx / distancia * intensidade;
          p.vy += dy / distancia * intensidade;
        }
      }
      // Atrito leve: depois que o cursor sai, a partícula volta a flutuar devagar.
      p.vx *= 0.992;
      p.vy *= 0.992;
      const velocidade = Math.hypot(p.vx, p.vy);
      if (velocidade > VELOCIDADE_MAX) {
        p.vx *= VELOCIDADE_MAX / velocidade;
        p.vy *= VELOCIDADE_MAX / velocidade;
      } else if (velocidade < 0.08) {
        p.vx += (Math.random() - 0.5) * 0.02;
        p.vy += (Math.random() - 0.5) * 0.02;
      }
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < -10) p.x = largura + 10; else if (p.x > largura + 10) p.x = -10;
      if (p.y < -10) p.y = altura + 10; else if (p.y > altura + 10) p.y = -10;
      p.fase += 0.02;
    }
  }

  function desenhar() {
    ctx.clearRect(0, 0, largura, altura);
    ctx.lineWidth = 1;

    // Linhas de luz entre partículas próximas.
    for (let i = 0; i < particulas.length; i++) {
      const a = particulas[i];
      for (let j = i + 1; j < particulas.length; j++) {
        const b = particulas[j];
        const dx = a.x - b.x;
        if (dx > DISTANCIA_LIGACAO || dx < -DISTANCIA_LIGACAO) continue;
        const dy = a.y - b.y;
        const distancia = Math.hypot(dx, dy);
        if (distancia >= DISTANCIA_LIGACAO) continue;
        ctx.strokeStyle = `rgba(${a.cor}, ${(1 - distancia / DISTANCIA_LIGACAO) * 0.28})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Conexões mais fortes com o cursor.
    if (cursor.ativo) {
      for (const p of particulas) {
        const distancia = Math.hypot(cursor.x - p.x, cursor.y - p.y);
        if (distancia >= RAIO_CURSOR) continue;
        const forca = 1 - distancia / RAIO_CURSOR;
        ctx.strokeStyle = `rgba(${p.cor}, ${forca * 0.6})`;
        ctx.lineWidth = 0.6 + forca * 0.9;
        ctx.beginPath();
        ctx.moveTo(cursor.x, cursor.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }

    // Nós luminosos: halo + núcleo.
    for (const p of particulas) {
      const brilho = 0.65 + Math.sin(p.fase) * 0.25;
      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.raio * 5);
      halo.addColorStop(0, `rgba(${p.cor}, ${brilho * 0.45})`);
      halo.addColorStop(1, `rgba(${p.cor}, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.raio * 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${p.cor}, ${brilho})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.raio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function animar() {
    atualizar();
    desenhar();
    quadro = window.requestAnimationFrame(animar);
  }

  function iniciar() {
    parar();
    if (movimentoReduzido.matches || document.hidden) {
      desenhar(); // quadro estático
      return;
    }
    quadro = window.requestAnimationFrame(animar);
  }

  function parar() {
    if (quadro !== null) window.cancelAnimationFrame(quadro);
    quadro = null;
  }

  window.addEventListener("pointermove", (evento) => {
    if (evento.pointerType === "touch") return; // no toque, a atração atrapalharia a rolagem
    cursor.x = evento.clientX;
    cursor.y = evento.clientY;
    cursor.ativo = true;
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { cursor.ativo = false; });
  window.addEventListener("blur", () => { cursor.ativo = false; });

  let esperaRedimensionar = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(esperaRedimensionar);
    esperaRedimensionar = window.setTimeout(() => { redimensionar(); if (quadro === null) desenhar(); }, 120);
  });
  document.addEventListener("visibilitychange", iniciar);
  movimentoReduzido.addEventListener?.("change", iniciar);

  redimensionar();
  iniciar();
})();
