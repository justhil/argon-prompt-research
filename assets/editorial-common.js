/* ============================================================================
   Shared Scrollytelling, Braided Particle Stream Canvas & Rolling Counter Engine
   100% Classic Script (window.EditorialUI) — Works on both file:// and http://
   ============================================================================ */
(function () {
  const activeTimers = new WeakMap();

  /**
   * 1. Smooth Rolling Number Counter (380ms easeOutQuart)
   */
  function animateNumber(el, targetValue, formatter) {
    if (!el) return;
    const fmt = formatter || ((v) => Math.round(v).toLocaleString());
    const startValue = Number(el.dataset.currentVal || 0);
    const diff = targetValue - startValue;
    if (Math.abs(diff) < 0.05) {
      el.dataset.currentVal = String(targetValue);
      el.textContent = fmt(targetValue);
      return;
    }

    const startTime = performance.now();
    const duration = 380;

    if (activeTimers.has(el)) {
      cancelAnimationFrame(activeTimers.get(el));
    }

    function tick(now) {
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 4);
      const cur = startValue + diff * ease;
      el.textContent = fmt(cur);
      if (t < 1) {
        activeTimers.set(el, requestAnimationFrame(tick));
      } else {
        el.dataset.currentVal = String(targetValue);
        el.textContent = fmt(targetValue);
      }
    }
    activeTimers.set(el, requestAnimationFrame(tick));
  }

  /**
   * 2. Trigger Cross-Fade Animation on Stage Drawer
   */
  function pulseDrawer(drawerId) {
    const el = typeof drawerId === 'string' ? document.getElementById(drawerId) : drawerId;
    if (!el) return;
    el.classList.add('switching');
    setTimeout(() => el.classList.remove('switching'), 150);
  }

  /**
   * 3. Update Step Progress Dots Bar (.step-dots-bar)
   */
  function updateStepDots(dotsContainerId, activeIdx) {
    const container = document.getElementById(dotsContainerId);
    if (!container) return;
    container.querySelectorAll('.step-dot-pill').forEach((dot, idx) => {
      dot.classList.toggle('done', idx < activeIdx);
      dot.classList.toggle('current', idx === activeIdx);
    });
  }

  /**
   * 4. Scrollytelling Center-Tracking Engine + Step Dot Click Binding
   */
  function bindScrollyStage(options) {
    const { sectionId, dotsId, drawerId, onStepChange } = options;
    const sec = document.getElementById(sectionId);
    if (!sec) return;
    const cards = Array.from(sec.querySelectorAll('.step-card'));
    if (cards.length === 0) return;

    // Auto-build step dots if dotsId exists and is empty
    const dotsBox = dotsId ? document.getElementById(dotsId) : null;
    if (dotsBox && dotsBox.children.length === 0) {
      dotsBox.innerHTML = cards
        .map((_, idx) => `<div class="step-dot-pill" data-step-dot="${idx}" title="跳转到步骤 ${idx + 1}"><div class="step-dot-fill"></div></div>`)
        .join('');
      dotsBox.querySelectorAll('.step-dot-pill').forEach((dot, idx) => {
        dot.addEventListener('click', () => {
          cards[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setStep(idx, true);
        });
      });
    }

    let activeIdx = -1;
    let ticking = false;

    function setStep(idx, animateDrawer) {
      if (idx === activeIdx) return;
      activeIdx = idx;
      cards.forEach((c, i) => c.classList.toggle('active', i === activeIdx));
      if (dotsId) updateStepDots(dotsId, activeIdx);
      if (animateDrawer && drawerId) pulseDrawer(drawerId);
      if (typeof onStepChange === 'function') {
        onStepChange(activeIdx, cards[activeIdx]);
      }
    }

    function evaluateCenterCard() {
      ticking = false;
      const targetY = window.innerHeight * 0.45;
      let bestIdx = 0;
      let bestDist = Infinity;

      cards.forEach((card, idx) => {
        const rect = card.getBoundingClientRect();
        const center = (rect.top + rect.bottom) * 0.5;
        const dist = Math.abs(center - targetY);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = idx;
        }
      });

      setStep(bestIdx, activeIdx !== -1);
    }

    window.addEventListener('scroll', () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(evaluateCenterCard);
      }
    }, { passive: true });

    cards.forEach((card, idx) => {
      card.addEventListener('click', () => {
        setStep(idx, true);
      });
    });

    evaluateCenterCard();
    return { setStep };
  }

  /**
   * 5. Rich Braided Mineral Particle Stream Canvas (with mouse repulsion & scroll morph)
   */
  function initParticleStreamCanvas(canvasId, streamConfig) {
    const cfg = streamConfig || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const ctx = canvas.getContext('2d');

    const streamPalette = cfg.streams || [
      { branch: -1, color: '#d66856', alpha: 0.80 },
      { branch: 0,  color: '#5493b8', alpha: 0.80 },
      { branch: 1,  color: '#528e67', alpha: 0.88 },
      { branch: 1,  color: '#cf963e', alpha: 0.68 }
    ];
    const count = cfg.count || 1020;

    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let mouseX = -9999;
    let mouseY = -9999;
    let scrollRatio = 0;

    const particles = [];
    for (let i = 0; i < count; i++) {
      const sc = streamPalette[i % streamPalette.length];
      const r1 = (Math.random() + Math.random() + Math.random()) / 3 - 0.5;
      particles.push({
        t: Math.random(),
        speed: 0.00095 + Math.random() * 0.00115,
        branch: sc.branch,
        color: sc.color,
        alpha: sc.alpha * (0.55 + Math.random() * 0.45),
        spread: r1 * 86,
        wavePhase: Math.random() * Math.PI * 2,
        len: 6.5 + Math.random() * 8.5,
        thick: 1.55 + Math.random() * 1.45
      });
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = rect.width || 640;
      height = rect.height || 430;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    window.addEventListener('resize', resize);

    if (wrap) {
      wrap.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        mouseX = e.clientX - r.left;
        mouseY = e.clientY - r.top;
      });
      wrap.addEventListener('mouseleave', () => {
        mouseX = -9999;
        mouseY = -9999;
      });
    }

    window.addEventListener('scroll', () => {
      scrollRatio = Math.min(1, Math.max(0, (window.scrollY || 0) / 680));
      if (wrap) {
        wrap.style.transform = `translate3d(0, ${scrollRatio * 20}px, 0) scale(${1 - scrollRatio * 0.025})`;
      }
    }, { passive: true });

    function getPos(t, p) {
      const centerY = height * 0.5;
      const splitStart = 0.20;
      const u = Math.max(0, (t - splitStart) / (1 - splitStart));
      const curve = Math.pow(u, 1.75);
      const tighten = 1 - scrollRatio * 0.32;
      const branchOffset = p.branch * (height * 0.34 * tighten) * curve;
      const spreadFactor = 0.22 + 1.12 * curve;
      const wave = Math.sin(t * 7 + p.wavePhase) * 2.5 * (1 - u * 0.5);
      return centerY + branchOffset + p.spread * spreadFactor + wave;
    }

    function render() {
      ctx.clearRect(0, 0, width, height);
      for (const p of particles) {
        p.t += p.speed;
        if (p.t > 1) p.t -= 1;

        let x1 = p.t * width * 0.96;
        let y1 = getPos(p.t, p);

        const dx = x1 - mouseX;
        const dy = y1 - mouseY;
        const distSq = dx * dx + dy * dy;
        if (distSq < 8100 && distSq > 1) {
          const dist = Math.sqrt(distSq);
          const push = (1 - dist / 90) * 15;
          y1 += (dy / dist) * push;
        }

        const dt = p.len / width;
        const t2 = Math.min(1, p.t + dt);
        const x2 = t2 * width * 0.96;
        const y2 = getPos(t2, p) + (y1 - getPos(p.t, p));

        const edgeFade = p.t < 0.07 ? p.t / 0.07 : p.t > 0.88 ? (1 - p.t) / 0.12 : 1;
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = Math.max(0, p.alpha * edgeFade);
        ctx.lineWidth = p.thick;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(render);
    }

    requestAnimationFrame(render);
  }

  /**
   * 6. Global Scroll Progress Ribbon, Floating Chapter Pill & Reveal Observer
   */
  function initGlobalChoreography(chapters) {
    // Scroll reveal
    const items = document.querySelectorAll('.reveal');
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
          }
        });
      }, { threshold: 0.08 });
      items.forEach((el) => io.observe(el));
    } else {
      items.forEach((el) => el.classList.add('visible'));
    }

    // Top progress bar & floating chapter pill
    const progressBar = document.getElementById('global-progress-bar');
    const chapterText = document.getElementById('floating-chapter-text');
    let ticking = false;

    function onScrollFrame() {
      ticking = false;
      const vh = window.innerHeight || 800;
      const maxScroll = Math.max(1, document.documentElement.scrollHeight - vh);
      const progress = Math.min(1, Math.max(0, (window.scrollY || 0) / maxScroll));
      if (progressBar) {
        progressBar.style.transform = `scaleX(${progress.toFixed(4)})`;
      }

      if (chapterText && Array.isArray(chapters) && chapters.length > 0) {
        let activeLabel = chapters[0].label;
        for (const ch of chapters) {
          const el = document.getElementById(ch.id);
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.top <= vh * 0.55) {
              activeLabel = ch.label;
            }
          }
        }
        chapterText.textContent = `${activeLabel} · ${Math.round(progress * 100)}%`;
      }
    }

    window.addEventListener('scroll', () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(onScrollFrame);
      }
    }, { passive: true });

    onScrollFrame();
  }

  window.EditorialUI = {
    animateNumber,
    pulseDrawer,
    updateStepDots,
    bindScrollyStage,
    initParticleStreamCanvas,
    initGlobalChoreography
  };
})();
