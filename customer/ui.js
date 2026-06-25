// Generic UI helpers: bottom-sheet open/close, hero CTA animation, swipe
// gestures, PWA install prompt, service worker registration and the
// scroll-reveal observer. These touch the DOM only (no shared app state).

export function openSheet(id) {
  document.getElementById(id).classList.add('on');
  document.getElementById('overlay').classList.add('on');
  document.body.style.overflow = 'hidden';
}

export function closeAll() {
  document.querySelectorAll('.sheet').forEach(s => s.classList.remove('on'));
  document.getElementById('overlay').classList.remove('on');
  document.body.style.overflow = '';
}

// ═══════ HERO CTA ANIMATION ═══════
export function initCta() {
  const cta = document.getElementById('mainCta');
  const slideA = document.getElementById('slideA');
  const slideB = document.getElementById('slideB');
  if (!cta || !slideA || !slideB) return;
  let isA = true;

  setInterval(() => {
    isA = !isA;
    if (isA) {
      slideA.classList.add('active');
      slideB.classList.remove('active');
      cta.style.background = 'var(--primary)';
    } else {
      slideA.classList.remove('active');
      slideB.classList.add('active');
      cta.style.background = '#128C7E';
    }
  }, 3500);
}

// ═══════ SWIPE GESTURES (category paging) ═══════
export function setupSwipe() {
  const menuArea = document.getElementById('menuArea');
  if (!menuArea) return;
  let touchStartX = 0;
  let touchEndX = 0;

  menuArea.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  menuArea.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
  }, { passive: true });

  function handleSwipe() {
    const threshold = 80;
    const area = document.getElementById('menuArea');
    const btns = Array.from(document.querySelectorAll('.cat-btn'));
    const activeIdx = btns.findIndex(b => b.classList.contains('active'));

    if (touchEndX < touchStartX - threshold) {
      // Swipe Left -> Next
      if (activeIdx < btns.length - 1) {
        btns[activeIdx + 1].click();
        area.style.transform = 'translateX(-20px)';
        area.style.opacity = '0.5';
        setTimeout(() => {
          area.style.transform = 'translateX(0)';
          area.style.opacity = '1';
        }, 150);
      }
    } else if (touchEndX > touchStartX + threshold) {
      // Swipe Right -> Prev
      if (activeIdx > 0) {
        btns[activeIdx - 1].click();
        area.style.transform = 'translateX(20px)';
        area.style.opacity = '0.5';
        setTimeout(() => {
          area.style.transform = 'translateX(0)';
          area.style.opacity = '1';
        }, 150);
      }
    }
  }
}

// ═══════ PWA INSTALL PROMPT ═══════
export function setupInstallPrompt() {
  let deferredPrompt;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone) {
      setTimeout(() => {
        document.getElementById('androidInstallState').style.display = 'block';
        document.getElementById('iosInstallState').style.display = 'none';
        openSheet('installSheet');
      }, 2000);
    }
  });

  // For iOS users who don't get beforeinstallprompt
  window.addEventListener('load', () => {
    if (isIOS && !isStandalone) {
      setTimeout(() => {
        document.getElementById('androidInstallState').style.display = 'none';
        document.getElementById('iosInstallState').style.display = 'block';
        openSheet('installSheet');
      }, 3000);
    }
  });

  const installBtn = document.getElementById('actualInstallBtn');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') closeAll();
        deferredPrompt = null;
      }
    });
  }
}

// ═══════ SERVICE WORKER ═══════
export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(err => {
        console.log('ServiceWorker registration failed: ', err);
      });
    });
  }
}

// ═══════ SCROLL-TRIGGERED REVEAL (animate cards only when visible) ═══════
export function setupRevealObserver() {
  const menuAreaEl = document.getElementById('menuArea');
  if (!menuAreaEl) return;

  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.animationPlayState = 'running';
        entry.target.classList.add('in-view');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.05, rootMargin: '0px 0px -20px 0px' });

  const menuMutationObserver = new MutationObserver(() => {
    menuAreaEl.querySelectorAll('.item-card:not(.in-view)').forEach(card => {
      card.style.animationPlayState = 'paused';
      revealObserver.observe(card);
    });
  });
  menuMutationObserver.observe(menuAreaEl, { childList: true, subtree: true });
}
