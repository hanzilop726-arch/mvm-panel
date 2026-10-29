(function () {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reducedMotion.matches) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'ambient-particles';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);

  const context = canvas.getContext('2d', { alpha: true });
  if (!context) {
    canvas.remove();
    return;
  }

  const particles = Array.from({ length: window.innerWidth < 768 ? 42 : 76 }, () => ({
    x: Math.random(),
    y: Math.random(),
    radius: 0.7 + Math.random() * 1.5,
    speedX: (Math.random() - 0.5) * 0.018,
    speedY: (Math.random() - 0.5) * 0.018,
    opacity: 0.18 + Math.random() * 0.42
  }));
  const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#22c55e';
  let width = 0;
  let height = 0;
  let frame = 0;
  let previousTime = 0;
  let pointer = null;

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw(time) {
    frame = 0;
    if (document.hidden) return;

    const delta = Math.min((time - (previousTime || time)) / 1000, 0.032);
    previousTime = time;
    context.clearRect(0, 0, width, height);

    for (const particle of particles) {
      particle.x += particle.speedX * delta;
      particle.y += particle.speedY * delta;
      if (pointer) {
        const dx = pointer.x / width - particle.x;
        const dy = pointer.y / height - particle.y;
        const distance = Math.hypot(dx * width, dy * height);
        if (distance < 180) {
          const attraction = (1 - distance / 180) * 0.18 * delta;
          particle.x += dx * attraction;
          particle.y += dy * attraction;
        }
      }
      if (particle.x < 0) particle.x = 1;
      if (particle.x > 1) particle.x = 0;
      if (particle.y < 0) particle.y = 1;
      if (particle.y > 1) particle.y = 0;
    }

    for (let i = 0; i < particles.length; i++) {
      const particle = particles[i];
      const x = particle.x * width;
      const y = particle.y * height;

      context.beginPath();
      context.arc(x, y, particle.radius, 0, Math.PI * 2);
      context.globalAlpha = particle.opacity;
      context.fillStyle = primary;
      context.fill();

      for (let j = i + 1; j < particles.length; j++) {
        const other = particles[j];
        const dx = (particle.x - other.x) * width;
        const dy = (particle.y - other.y) * height;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > 105) continue;

        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(other.x * width, other.y * height);
        context.globalAlpha = (1 - distance / 105) * 0.13;
        context.strokeStyle = primary;
        context.lineWidth = 0.7;
        context.stroke();
      }
    }

    context.globalAlpha = 1;
    frame = window.requestAnimationFrame(draw);
  }

  function start() {
    if (!frame && !document.hidden) frame = window.requestAnimationFrame(draw);
  }

  function stop() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
  }

  resize();
  start();
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('pointermove', (event) => {
    pointer = { x: event.clientX, y: event.clientY };
  }, { passive: true });
  window.addEventListener('pointerleave', () => { pointer = null; }, { passive: true });
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
  reducedMotion.addEventListener('change', (event) => {
    if (event.matches) {
      stop();
      canvas.remove();
      window.removeEventListener('resize', resize);
    }
  });
})();
