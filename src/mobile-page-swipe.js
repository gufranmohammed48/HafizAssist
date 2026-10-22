// Mobile-only page dragging. The caller supplies navigation and session guards.
export function setupMobilePageSwipe({ reader, canTurn, beforeTurn, turnPage, onSwipeStart, onTurnEnd }) {
  if (!reader || typeof turnPage !== 'function') return () => {};

  let motion = null;
  let suppressClickUntil = 0;
  let disposed = false;
  let viewportWidth = innerWidth;
  const temporaryProperties = ['transform', 'opacity', 'transition', 'will-change', 'user-select'];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function allowed(direction) {
    return !disposed && (typeof canTurn !== 'function' || canTurn(direction));
  }

  function captureStyles(current) {
    const computed = getComputedStyle(reader);
    // Measure the resting page once, before translating it with the finger.
    current.pageWidth = reader.getBoundingClientRect().width;
    current.baseTransform = computed.transform === 'none' ? '' : computed.transform;
    current.baseOpacity = Number(computed.opacity) || 1;
    current.styles = temporaryProperties.map(property => [
      property, reader.style.getPropertyValue(property), reader.style.getPropertyPriority(property),
    ]);
    reader.style.setProperty('will-change', 'transform, opacity');
    reader.style.setProperty('transition', 'none');
    reader.style.setProperty('user-select', 'none');
  }

  function paint(current, offset, opacity = current.baseOpacity) {
    current.offset = offset;
    reader.style.setProperty('transform', `translate3d(${offset}px, 0, 0) ${current.baseTransform}`.trim());
    reader.style.setProperty('opacity', String(opacity));
  }

  function suppressClick() {
    suppressClickUntil = performance.now() + 600;
  }

  function releaseCapture(current) {
    if (reader.hasPointerCapture?.(current.pointerId)) {
      try { reader.releasePointerCapture(current.pointerId); } catch { /* The browser may have released it. */ }
    }
  }

  function finish(current) {
    if (current.finished) return;
    current.finished = true;
    if (current.frame) cancelAnimationFrame(current.frame);
    if (current.wait) current.wait(false);
    // Clear the active motion before releasing capture: lostpointercapture is synchronous in some browsers.
    if (motion === current) motion = null;
    releaseCapture(current);
    if (current.styles) {
      for (const [property, value, priority] of current.styles) {
        if (value) reader.style.setProperty(property, value, priority);
        else reader.style.removeProperty(property);
      }
    }
    reader.classList.remove('mobile-page-dragging', 'mobile-page-turning');
    if (current.committed) onTurnEnd?.();
  }

  function wait(current, milliseconds) {
    return new Promise(resolve => {
      if (current.finished) { resolve(false); return; }
      const timer = setTimeout(() => complete(true), milliseconds);
      function complete(completed) {
        clearTimeout(timer);
        if (current.wait === complete) current.wait = null;
        resolve(completed && !current.finished);
      }
      current.wait = complete;
    });
  }

  async function animate(current, offset, opacity, duration) {
    if (current.finished) return false;
    if (current.frame) { cancelAnimationFrame(current.frame); current.frame = 0; }
    reader.style.setProperty('transition', reducedMotion.matches
      ? 'none'
      : `transform ${duration}ms cubic-bezier(.22,.68,.2,1), opacity ${duration}ms ease`);
    paint(current, offset, opacity);
    return wait(current, reducedMotion.matches ? 0 : duration + 24);
  }

  async function snapBack(current) {
    current.stage = 'turning';
    releaseCapture(current);
    if (current.styles) await animate(current, 0, current.baseOpacity, 180);
    finish(current);
  }

  async function commit(current, direction) {
    current.committed = true;
    current.stage = 'turning';
    releaseCapture(current);
    reader.classList.remove('mobile-page-dragging');
    reader.classList.add('mobile-page-turning');
    try {
      // The caller must still allow navigation when the gesture commits.
      // Only a completed gesture reaches this barrier; short drags never
      // invoke session-changing actions such as stopping the microphone.
      if (beforeTurn) {
        const ready = await beforeTurn(direction);
        if (current.finished) return;
        if (ready === false) { await snapBack(current); return; }
      }
      if (!allowed(direction)) { await snapBack(current); return; }
      if (!reducedMotion.matches) {
        const distance = (innerWidth + reader.getBoundingClientRect().width) / 2 + 40;
        if (!await animate(current, direction * distance, 0, 220)) return;
      }
      // Recording or a dialog may have started while the outgoing page was moving.
      if (!allowed(direction)) { await snapBack(current); return; }
      const turned = await turnPage(direction);
      if (current.finished) return;
      if (turned === false) { await snapBack(current); return; }
      if (!reducedMotion.matches) {
        reader.style.setProperty('transition', 'none');
        paint(current, -direction * Math.min(reader.getBoundingClientRect().width * .22, 100), 0);
        // Commit the entry position before starting its transition.
        reader.getBoundingClientRect();
        await animate(current, 0, current.baseOpacity, 260);
      }
    } catch (error) {
      console.error('Unable to turn the Quran page.', error);
    } finally {
      finish(current);
    }
  }

  function cancelImmediately() {
    if (!motion) return;
    if (motion.stage !== 'tracking') suppressClick();
    finish(motion);
  }

  function onPointerDown(event) {
    if (disposed || motion || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    // A new tap must not inherit click suppression from the preceding gesture.
    suppressClickUntil = 0;
    const control = event.target.closest?.('a, button, input, select, textarea, summary, [role="button"], [contenteditable="true"]');
    if (control && !control.classList.contains('word')) return;
    // Track movement even when navigation is locked. A horizontal gesture
    // must not turn into a word-audio tap while the microphone is running.
    motion = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      stage: 'tracking',
      offset: 0,
      frame: 0,
      wait: null,
      finished: false,
    };
  }

  function onAdditionalPointer(event) {
    if (!motion || event.pointerId === motion.pointerId) return;
    // Give a second finger back to the browser for pinch zoom.
    suppressClick();
    finish(motion);
  }

  function onPointerMove(event) {
    const current = motion;
    if (!current || current.pointerId !== event.pointerId || current.stage === 'turning') return;
    if (current.stage === 'blocked') return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    current.latestX = event.clientX;
    current.latestY = event.clientY;
    if (current.stage === 'tracking') {
      if (Math.hypot(dx, dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.25) {
        // Leave vertical document scrolling untouched, but do not replay a word afterward.
        suppressClick();
        finish(current);
        return;
      }
      // Wait for a clear direction rather than rejecting a horizontal swipe
      // because its first few pixels happened to drift diagonally.
      if (Math.abs(dx) < Math.abs(dy) * 1.15) return;
      if (!allowed(1) && !allowed(-1)) {
        current.stage = 'blocked';
        suppressClick();
        return;
      }
      captureStyles(current);
      current.stage = 'dragging';
      reader.classList.add('mobile-page-dragging');
      suppressClick();
      try { onSwipeStart?.(); }
      catch (error) {
        finish(current);
        console.error('Unable to begin turning the Quran page.', error);
        return;
      }
      try { reader.setPointerCapture(event.pointerId); } catch { /* Global listeners still track the gesture. */ }
    }
    if (!allowed(1) && !allowed(-1)) { void snapBack(current); return; }
    if (event.cancelable) event.preventDefault();
    const direction = dx >= 0 ? 1 : -1;
    const offset = allowed(direction) ? dx : Math.sign(dx) * Math.min(48, Math.abs(dx) * .22);
    current.pendingOffset = offset;
    if (!current.frame) current.frame = requestAnimationFrame(() => {
      current.frame = 0;
      if (!current.finished && current.stage === 'dragging') paint(current, current.pendingOffset);
    });
  }

  function onPointerUp(event) {
    const current = motion;
    if (!current || current.pointerId !== event.pointerId || current.stage === 'turning') return;
    if (current.stage === 'blocked') { suppressClick(); finish(current); return; }
    if (current.stage === 'tracking') { finish(current); return; }
    suppressClick();
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    const direction = dx >= 0 ? 1 : -1;
    // Distance is required even for a fast flick; returning the finger toward
    // the start before release also returns the page instead of turning it.
    const threshold = current.pageWidth * .7;
    if (Math.abs(dx) >= threshold && Math.abs(dx) >= Math.abs(dy) * 1.15 && allowed(direction)) {
      void commit(current, direction);
    } else {
      void snapBack(current);
    }
  }

  function onPointerCancel(event) {
    if (!motion || motion.pointerId !== event.pointerId || motion.stage === 'turning') return;
    if (motion.stage === 'dragging') { suppressClick(); void snapBack(motion); }
    else finish(motion);
  }

  function onLostCapture(event) {
    // Touch starts implicitly captured by the word button. Taking capture
    // for the page emits a bubbling lostpointercapture from that button;
    // that handoff is expected, not a cancellation of the page drag.
    if (event.target !== reader) return;
    if (motion?.pointerId === event.pointerId && motion.stage === 'dragging') {
      suppressClick();
      void snapBack(motion);
    }
  }

  function onClick(event) {
    if (performance.now() < suppressClickUntil || motion?.stage === 'turning') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function onVisibilityChange() {
    if (document.hidden) cancelImmediately();
  }

  function onResize() {
    // Mobile browser bars change viewport height while the finger moves.
    // Only a width change invalidates this horizontal page gesture.
    if (innerWidth === viewportWidth) return;
    viewportWidth = innerWidth;
    cancelImmediately();
  }

  reader.addEventListener('pointerdown', onPointerDown);
  reader.addEventListener('lostpointercapture', onLostCapture);
  reader.addEventListener('click', onClick, true);
  window.addEventListener('pointerdown', onAdditionalPointer, true);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', cancelImmediately);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    disposed = true;
    cancelImmediately();
    reader.removeEventListener('pointerdown', onPointerDown);
    reader.removeEventListener('lostpointercapture', onLostCapture);
    reader.removeEventListener('click', onClick, true);
    window.removeEventListener('pointerdown', onAdditionalPointer, true);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', cancelImmediately);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
