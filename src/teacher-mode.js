// Teacher audio is reference recitation, separate from the recognition model.
// Keep completed-word history while feedback optionally requests a retry.
import { createTeacherVoices } from './teacher-voices.js';
const AUDIO_BASE = 'https://audio.qurancdn.com/wbw/';
const CACHE = 'recitealquran-teacher-audio-v1';
const RETENTION = 6 * 24 * 60 * 60 * 1000;
const MAX_CLIPS = 200;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const PAUSE_HINT_MS = 5000;
const PAUSE_HINT_WORDS = document.documentElement.dataset.teacherPauseWords === '3' ? 3 : 1;
const SPLIT_WORDS = { '2:181': 3, '8:6': 4, '13:37': 8, '37:130': 3 };
const abortError = () => new DOMException('Teacher playback cancelled.', 'AbortError');

export function teacherAudioReference(word) {
  if (!word) return null;
  const surah = word.bismillah ? 1 : word.surah;
  const ayah = word.bismillah ? 1 : word.ayah;
  let position = word.position + 1;
  const split = SPLIT_WORDS[`${surah}:${ayah}`];
  const combined = Boolean(split && (position === split || position === split + 1));
  if (split && position > split) position--;
  // Quran.com's audio combines إِلْ يَاسِينَ at 37:130, while the Tanzil
  // timing text retains four separate words in that verse.
  const timingPosition = surah === 37 && ayah === 130 ? word.position + 1 : position;
  const timingWordCount = Number.isInteger(word.wordCount)
    ? word.wordCount - (split && !(surah === 37 && ayah === 130) ? 1 : 0) : undefined;
  const path = [surah, ayah, position].map(value => String(value).padStart(3, '0')).join('_');
  return { url: `${AUDIO_BASE}${path}.mp3`, combined, split, surah, ayah, position, timingPosition, timingWordCount,
    quaPosition: word.position + 1, quaWordCount: word.wordCount };
}

export function createTeacherMode({ getState, pauseRecognition, resumeRecognition, onStateChange, onCorrectionPlayed, onCorrectionSettled, onEnabledChange }) {
  const $ = id => document.getElementById(id);
  if (!$('teacher-enabled')) return { refresh() {}, observe() {}, cancel() {}, async cancelAndWait() {}, unlock() {}, continuePage() {}, hearWord() {}, enabled: false, playing: false, busy: false };
  const card = $('teacher-feedback');
  let enabled = false;
  let audioContext, mediaAudio, silentUrl, source, activeJob, correction;
  let manualSequence = 0, pendingManual;
  let dismissTimer, closeTimer, cardFrame, lastKey = '', warmKey = '', warmController;
  let feedbackWords = [];
  let enabledAt = Date.now();
  const hinted = new Set(), corrected = new Set();
  const failedPrompts = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem('recitealquran-teacher') || '{}');
    enabled = saved.enabled === true;
  } catch {}
  function save() {
    try { localStorage.setItem('recitealquran-teacher', JSON.stringify({ enabled })); } catch {}
  }
  const voices = createTeacherVoices({
    getEnabled: () => enabled,
    onToggle: () => setEnabled(!enabled),
    onOpen: () => unlock(true),
    onChange() {
      // Choosing a reciter is a direct gesture to enable spoken assistance.
      // Voice selection and Teacher's master switch must not disagree.
      cancel({ reset: true });
      enabled = true; enabledAt = Date.now();
      unlock(true); save();
      message('Teacher on. Pause for five seconds to hear help. Words marked for review play automatically.');
      refresh(); onStateChange?.();
    },
  });
  function message(text) {
    if ($('teacher-status').textContent !== text) $('teacher-status').textContent = text;
    voices?.setStatus(text);
  }
  function setEnabled(value) {
    enabled = Boolean(value);
    onEnabledChange?.(enabled);
    if (enabled) {
      enabledAt = Date.now(); hinted.clear(); corrected.clear(); failedPrompts.clear();
      unlock(true);
      message('Teacher on. Pause for five seconds to hear help. Words marked for review play automatically.');
    } else {
      cancel(); message('Teacher off. Click a word to hear its reference audio.');
    }
    save(); refresh(); onStateChange?.();
  }
  function positionCard() {
    if (card.hidden) return;
    const page = document.querySelector('.reader')?.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const available = page ? width - page.right - 32 : 0;
    if (available >= 240) {
      const cardWidth = Math.min(310, available);
      card.dataset.placement = 'gutter';
      card.style.width = `${cardWidth}px`;
      card.style.left = `${page.right + 16 + (available - cardWidth) / 2}px`;
    } else {
      card.dataset.placement = 'overlay';
      card.style.removeProperty('width'); card.style.removeProperty('left');
    }
  }
  function hideCard() {
    clearTimeout(dismissTimer); cancelAnimationFrame(cardFrame);
    if (card.hidden || (!card.classList.contains('is-visible') && closeTimer)) return;
    clearTimeout(closeTimer);
    card.classList.remove('is-visible');
    closeTimer = setTimeout(() => {
      if (card.hidePopover && card.matches(':popover-open')) card.hidePopover();
      card.hidden = true; closeTimer = null;
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 440);
  }
  function playbackWords(words) {
    // Two displayed fragments can share one complete source-word recording.
    // Fetch that recording once when warming upcoming words.
    if (document.documentElement.dataset.teacherTimings === 'qua') return words.filter(Boolean);
    return words.filter((word, index) => word && (!index ||
      teacherAudioReference(word).url !== teacherAudioReference(words[index - 1])?.url));
  }
  function showCard(label, words, detail, temporary = false, kind = 'reference') {
    // On the dedicated phone page, tapping a word plays audio without a
    // second word card. Keep word-info details and automatic Teacher feedback.
    if (document.documentElement.dataset.layout === 'mobile' && activeJob?.kind === 'manual') {
      if (kind !== 'error') { hideCard(); return; }
      // Failed manual audio remains actionable, but does not repeat the word.
      words = null;
      detail = detail.replace(' Press Replay to try again.', ' Tap the word to try again.');
    }
    clearTimeout(dismissTimer); clearTimeout(closeTimer); closeTimer = null; cancelAnimationFrame(cardFrame);
    $('teacher-feedback-label').textContent = label;
    feedbackWords = Array.isArray(words) ? words : words ? [words] : [];
    $('teacher-feedback-word').textContent = feedbackWords.map(word => word.audioLabel || word.accessible || '').join(' ');
    $('teacher-feedback-detail').textContent = detail;
    card.dataset.state = kind;
    $('teacher-replay').hidden = !feedbackWords.length;
    $('teacher-replay').textContent = feedbackWords.length > 1 ? `Replay ${feedbackWords.length} words` : 'Replay word';
    // A modal settings drawer is above normal document content. Popovers use
    // the browser's top layer so the countdown/errors remain visible there.
    const settings = $('book-settings');
    const host = settings?.matches(':modal') ? settings : document.body;
    if (card.parentElement !== host) host.append(card);
    card.hidden = false; positionCard();
    if (card.showPopover && !card.matches(':popover-open')) card.showPopover();
    cardFrame = requestAnimationFrame(() => card.classList.add('is-visible'));
    if (temporary) dismissTimer = setTimeout(hideCard, 5000);
  }
  function unlock(manual = false) {
    if (!enabled && !manual) return;
    // Called directly from the Teacher toggle, replay button, or mic click.
    try {
      if (!audioContext || audioContext.state === 'closed') audioContext = new (window.AudioContext || window.webkitAudioContext)();
      void audioContext.resume().catch(() => {});
      if (!mediaAudio) {
        mediaAudio = new Audio();
        // Unlock the same media element for a direct-stream fallback on browsers
        // where public CDN files cannot be fetched for WebAudio decoding.
        const wav = new ArrayBuffer(46), view = new DataView(wav);
        const write = (offset, value) => [...value].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
        write(0, 'RIFF'); view.setUint32(4, 38, true); write(8, 'WAVE'); write(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, 2, true);
        silentUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      }
      // Retry the unlock on every direct user action, including after a
      // browser blocked the first silent play. Never replace an active clip.
      if (!activeJob?.playing) {
        mediaAudio.src = silentUrl;
        void mediaAudio.play().catch(() => {});
      }
    } catch { message('Audio playback is unavailable in this browser.'); }
  }
  async function pruneCache() {
    try {
      const cache = await caches.open(CACHE);
      const entries = await Promise.all((await cache.keys()).map(async request => {
        const response = await cache.match(request);
        return { request, saved: Number(response?.headers.get('X-Teacher-Saved-At')) || 0,
          bytes: Number(response?.headers.get('Content-Length')) || 0 };
      }));
      const fresh = entries.filter(entry => Date.now() - entry.saved < RETENTION).sort((a, b) => b.saved - a.saved);
      const keep = new Set();
      let retainedBytes = 0;
      for (const entry of fresh) {
        if (keep.size >= MAX_CLIPS || retainedBytes + entry.bytes > MAX_CACHE_BYTES) continue;
        keep.add(entry.request.url); retainedBytes += entry.bytes;
      }
      await Promise.all(entries.filter(entry => !keep.has(entry.request.url)).map(entry => cache.delete(entry.request)));
    } catch {} // Private browsing or quota limits must not prevent streaming.
  }
  void pruneCache();
  async function fetchClip(url, signal) {
    if (signal.aborted) throw abortError();
    let cache;
    try {
      cache = await caches.open(CACHE);
      const saved = await cache.match(url);
      if (saved?.ok) {
        const time = Number(saved.headers.get('X-Teacher-Saved-At')) || 0;
        if (Date.now() - time < RETENTION) return saved.arrayBuffer();
        await cache.delete(url);
      }
    } catch {}
    if (!navigator.onLine) throw new Error('This reference audio is not saved on this device. Connect to download it.');
    const download = new AbortController();
    const abort = () => download.abort(); signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 10000);
    try {
      const response = await fetch(url, { signal: download.signal, credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error('The reference recording is unavailable.');
      const bytes = await response.arrayBuffer();
      if (signal.aborted) throw abortError();
      if (cache) {
        const headers = new Headers({ 'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg' });
        headers.set('Content-Length', String(bytes.byteLength));
        headers.set('X-Teacher-Saved-At', String(Date.now()));
        try { await cache.put(url, new Response(bytes.slice(0), { headers })); void pruneCache(); } catch {}
      }
      return bytes;
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw error;
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  }
  async function prepare(word, signal, { resolved, quiet = false, buffers } = {}) {
    const base = teacherAudioReference(word);
    if (!base) throw new Error('Choose a Quran word first.');
    let reference = resolved || (voices ? await voices.resolve(base, signal, { quiet }) : base);
    if (reference.stream) {
      // QUA timestamps belong to chapter recordings, sometimes hours long.
      // Let the media element seek using HTTP ranges instead of fetching and
      // decoding a whole chapter for one word. These streams are not cached
      // by our short-word cache. Offline use can try a saved word reference.
      if (navigator.onLine) return { reference, direct: true };
      if (reference.format === 'phrase') throw new Error('This Teacher recording needs a connection. Saved individual word references may still work.');
      reference = voices.fallback(base, 'This Teacher recording needs a connection.', { quiet });
    }
    try {
      if (!audioContext) throw new Error('Click a word to allow audio playback.');
      const readBuffer = async ref => {
        let pending = buffers?.get(ref.url);
        if (!pending) {
          pending = fetchClip(ref.url, signal).then(bytes => audioContext.decodeAudioData(bytes));
          buffers?.set(ref.url, pending);
        }
        const buffer = await pending;
        if (signal.aborted) throw abortError();
        const selectedVoice = ref.voiceId && ref.voiceId !== 'word-reference';
        if (!buffer.duration || buffer.duration > (selectedVoice ? 900 : 12)) throw new Error('The reference recording could not be read.');
        return buffer;
      };
      let buffer = await readBuffer(reference);
      // Timing metadata must belong to this exact recording. Invalid bounds
      // use the original word recording, never a whole ayah or guessed slice.
      if (Number.isFinite(reference.start) && Number.isFinite(reference.end) &&
          (reference.start < 0 || reference.end <= reference.start || reference.end > buffer.duration + .05)) {
        if (reference.format === 'phrase') throw new RangeError('Phrase timing does not fit this recording.');
        reference = voices.fallback(base, 'Word timing does not fit this recording.', { quiet });
        buffer = await readBuffer(reference);
      }
      const start = reference.start ?? 0;
      const duration = reference.end == null ? buffer.duration : Math.min(reference.end, buffer.duration) - start;
      return { buffer, reference, start, duration };
    } catch (error) {
      if (signal.aborted) throw abortError();
      // A known invalid phrase must be retried as individual words, rather
      // than passed to a media element with the same invalid boundaries.
      if (reference.format === 'phrase' && error instanceof RangeError) throw error;
      if (!navigator.onLine) throw error;
      // A regular audio element can play public media without reading its bytes.
      return { reference, direct: true };
    }
  }
  async function preparePrompt(words, signal) {
    if (words.length === 1) return [await prepare(words[0], signal)];
    const clips = [], buffers = new Map();
    for (let offset = 0; offset < words.length;) {
      const first = teacherAudioReference(words[offset]);
      let end = offset + 1;
      while (end < words.length) {
        const next = teacherAudioReference(words[end]);
        if (next.surah !== first.surah || next.ayah !== first.ayah) break;
        end++;
      }
      const group = words.slice(offset, end);
      let phrase;
      if (voices && group.length > 1) {
        phrase = await voices.resolvePhrase(group.map(teacherAudioReference), signal, { quiet: true });
      }
      let phraseClip;
      if (phrase) {
        try { phraseClip = await prepare(group[0], signal, { resolved: phrase, quiet: true, buffers }); }
        catch (error) { if (signal.aborted || error.name === 'AbortError') throw error; }
      }
      if (phraseClip) clips.push(phraseClip);
      else for (const word of group) {
        const clip = await prepare(word, signal, { quiet: true, buffers });
        const previous = clips.at(-1)?.reference;
        // Split display fragments may share one source-word recording.
        // Distinct timed words, including 37:130, retain their own boundaries.
        if (previous?.url !== clip.reference.url || previous.start !== clip.reference.start || previous.end !== clip.reference.end)
          clips.push(clip);
      }
      offset = end;
    }
    return clips;
  }
  function playClip(clip, signal) {
    return new Promise((resolve, reject) => {
      let timer, endTimer, finished = false, started = false;
      const timed = Number.isFinite(clip.reference.start) && Number.isFinite(clip.reference.end);
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(endTimer); signal.removeEventListener('abort', abort);
        if (mediaAudio) {
          mediaAudio.onended = null; mediaAudio.onerror = null; mediaAudio.onloadedmetadata = null;
          mediaAudio.onseeked = null; mediaAudio.ontimeupdate = null;
          mediaAudio.onplaying = null; mediaAudio.onwaiting = null;
        }
        if (source) { source.onended = null; source.disconnect(); source = null; }
      };
      const finish = error => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve(); };
      const abort = () => {
        try { source?.stop(); } catch {}
        mediaAudio?.pause(); finish(abortError());
      };
      if (signal.aborted) { reject(abortError()); return; }
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        try { source?.stop(); } catch {}
        mediaAudio?.pause(); finish(new Error('Teacher audio timed out. Click the word to retry.'));
      }, clip.reference.format === 'ayah' ? Math.min(915000, ((clip.duration || 900) + 15) * 1000) :
        Math.max(15000, Math.min(915000, ((clip.duration || (timed ? clip.reference.end - clip.reference.start : 0)) + 10) * 1000)));
      if (clip.direct) {
        if (!mediaAudio) { finish(new Error('Click a word to allow audio playback.')); return; }
        mediaAudio.onended = () => finish();
        mediaAudio.onerror = () => finish(new Error('The reference recording could not load. Your microphone can continue.'));
        const begin = () => {
          if (finished || started || signal.aborted) return;
          started = true;
          void mediaAudio.play().catch(() => finish(new Error('Audio was blocked. Click the word to allow playback.')));
        };
        if (timed) {
          const stop = () => { mediaAudio.pause(); finish(); };
          const reachBoundary = () => {
            if (finished || signal.aborted) return;
            // Streaming clocks can lag a wall-clock timeout slightly. Stop
            // at the recording's time, so that lag cannot clip the word end.
            const remaining = (clip.reference.end - mediaAudio.currentTime) * 1000;
            if (clip.reference.stream && remaining > 5) {
              endTimer = setTimeout(reachBoundary, Math.max(10, remaining));
              return;
            }
            stop();
          };
          const seek = () => {
            if (finished || signal.aborted) return;
            if (!Number.isFinite(mediaAudio.duration) || clip.reference.end > mediaAudio.duration + .05) {
              finish(new Error('Word timing does not fit this recording. Choose another Teacher voice.')); return;
            }
            mediaAudio.onseeked = begin;
            const alreadyAtStart = clip.reference.stream && Math.abs(mediaAudio.currentTime - clip.reference.start) < .015;
            try { mediaAudio.currentTime = clip.reference.start; } catch (error) { finish(error); return; }
            if (!clip.reference.start || alreadyAtStart) begin();
          };
          mediaAudio.onloadedmetadata = seek;
          mediaAudio.onplaying = () => {
            clearTimeout(endTimer);
            endTimer = setTimeout(reachBoundary, Math.max(0, clip.reference.end - mediaAudio.currentTime) * 1000);
          };
          mediaAudio.onwaiting = () => clearTimeout(endTimer);
          mediaAudio.ontimeupdate = () => { if (started && mediaAudio.currentTime >= clip.reference.end) stop(); };
        }
        const reuseStream = clip.reference.stream && mediaAudio.src === clip.reference.url && mediaAudio.readyState >= 1;
        mediaAudio.preload = clip.reference.stream ? 'metadata' : 'auto';
        if (!reuseStream) mediaAudio.src = clip.reference.url;
        else if (timed) mediaAudio.onloadedmetadata();
        if (!timed) begin();
      } else {
        try {
          source = audioContext.createBufferSource(); source.buffer = clip.buffer;
          source.connect(audioContext.destination); source.onended = () => finish();
          source.start(0, clip.start || 0, clip.duration || clip.buffer.duration);
        } catch (error) { finish(error); }
      }
    });
  }
  function resumeAudio(signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Click a word to allow audio playback.')), 3000);
      const abort = () => finish(abortError());
      function finish(error) {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      }
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      audioContext.resume().then(() => finish(audioContext.state === 'running' ? null : new Error('Audio playback is paused. Click a word to resume it.')), finish);
    });
  }
  function cancel({ reset = false, hide = true, preserveCorrection = false, reason = '' } = {}) {
    manualSequence++; pendingManual = null;
    activeJob?.controller.abort();
    warmController?.abort(); warmKey = '';
    if (!preserveCorrection) correction = null;
    if (reset) { hinted.clear(); corrected.clear(); failedPrompts.clear(); lastKey = ''; }
    if (hide) hideCard();
    if (reason) message(reason);
  }
  async function cancelAndWait(options) {
    // Call after stopping recognition and before changing the passage. A
    // cancelled job must finish releasing its capture gate on the old page.
    do {
      const job = activeJob, request = pendingManual;
      cancel(options);
      await Promise.all([job?.finished, request?.finished]);
    } while (activeJob || pendingManual);
  }
  async function speak(word, kind, key, replayWords) {
    if (activeJob || !word) return;
    const before = getState();
    if (document.hidden || before.voiceSearch || !['idle', 'recording'].includes(before.phase)) return;
    const requestedWords = kind === 'hint' ? (before.nextWords?.length ? before.nextWords : [word]) :
      kind === 'manual' && replayWords?.length ? replayWords : [word];
    const wordLimit = kind === 'hint' ? PAUSE_HINT_WORDS : kind === 'manual' && replayWords?.length ? 3 : 1;
    const promptWords = requestedWords.filter(Boolean).slice(0, wordLimit);
    let label = kind === 'correction' ? 'Review this word' : kind === 'hint' ? 'A little help' :
      promptWords.length > 1 ? 'Reference words' : 'Reference word';
    const job = { controller: new AbortController(), kind, playing: false, page: before.page,
      cursor: before.cursor, speechAt: before.speechAt, gated: false, gateReady: false };
    job.finished = new Promise(resolve => { job.finish = resolve; });
    activeJob = job; refresh(); onStateChange?.();
    const signal = job.controller.signal;
    message('Loading reference audio…');
    showCard(label, promptWords, 'Loading audio…');
    try {
      if (kind === 'correction' && before.phase === 'recording' && document.documentElement.dataset.teacherRetry === 'word') {
        // Freeze a flagged word before fetching its reference. Old queued
        // hypotheses drain without marking the words after the mistake.
        job.gated = true;
        await pauseRecognition(signal);
        job.gateReady = true;
        const now = getState();
        if (signal.aborted || document.hidden || now.voiceSearch || now.phase !== 'recording' || now.page !== before.page) throw abortError();
      }
      // Prepare the entire hint while listening, then pause capture once so
      // none of the teacher's words or their echoes can advance the pointer.
      const clips = await preparePrompt(promptWords, signal);
      const reference = clips[0].reference;
      const multiple = promptWords.length > 1;
      if (multiple) {
        for (let i = 0; i < promptWords.length; i++) promptWords[i] = { ...promptWords[i], audioLabel: promptWords[i].accessible };
      } else if (!reference.combined && word.audioLabel) promptWords[0] = { ...word, audioLabel: word.accessible };
      const ayahHelp = reference.format === 'ayah';
      if (ayahHelp) label = 'Ayah help';
      else if (reference.wordFallback && !multiple) label = 'Word reference';
      if (clips.some(clip => !clip.direct)) await resumeAudio(signal);
      let now = getState();
      if (signal.aborted || document.hidden || now.voiceSearch || now.page !== before.page || now.phase !== before.phase ||
          (kind === 'hint' && now.cursor !== before.cursor) ||
          (kind === 'hint' && now.speechAt > before.speechAt)) throw abortError();
      if (before.phase === 'recording' && !job.gated) {
        job.gated = true;
        await pauseRecognition(signal);
        job.gateReady = true;
        now = getState();
        if (signal.aborted || document.hidden || now.voiceSearch || now.phase !== 'recording' || now.page !== before.page ||
            (kind === 'hint' && now.cursor !== before.cursor) ||
            (kind === 'hint' && now.speechAt > before.speechAt)) throw abortError();
      }
      job.playing = true;
      const sources = [...new Set(clips.map(clip => clip.reference).filter(ref => ref.voiceName &&
        (ref.voiceId !== 'word-reference' || ref.wordFallback)).map(ref => `${ref.voiceName}${ref.style ? ` · ${ref.style}` : ''}`))];
      const voiceLabel = sources.length ? `${sources.join(' / ')}. ` : '';
      showCard(label, promptWords, ayahHelp
        ? `${voiceLabel}Playing ayah ${reference.surah}:${reference.ayah}. ${reference.notice || 'Individual-word timing is unavailable for this recording.'}`
        : multiple ? `${voiceLabel}Listen to the next ${promptWords.length} words.${clips.some(clip => clip.reference.wordFallback) ? ' Unavailable timings use Quran.com word audio.' : ''}`
        : reference.wordFallback ? reference.notice :
          `${voiceLabel}${reference.combined ? 'Playing the complete source word.' : 'Listen to the reference word.'}`);
      message('Playing reference audio…');
      for (const clip of clips) {
        if (signal.aborted) throw abortError();
        await playClip(clip, signal);
      }
      if (signal.aborted) throw abortError();
      if (kind === 'hint') hinted.add(key);
      let retrying = false;
      if (kind === 'correction') {
        // Reposition only after successful audio, while capture stays gated.
        // A fresh wrong retry may request another correction; playback alone
        // does not certify that the learner has said the word correctly.
        retrying = onCorrectionPlayed?.({ word, page: before.page }) === true;
        if (!retrying) corrected.add(key);
        if (correction?.key === key) correction = null;
      }
      failedPrompts.delete(`${kind}:${key}`);
      showCard(ayahHelp ? 'Ayah help · Your turn' : 'Your turn', promptWords,
        ayahHelp ? `${voiceLabel}Continue from the highlighted word when you’re ready.` :
          kind === 'correction' ? retrying ? 'Recite this word again. Its mistake mark and count are kept.' :
            'Continue from the highlighted word. The flagged word remains available for review.' :
          kind === 'manual' ? 'Continue reciting when you’re ready.' :
          multiple ? 'Continue from the highlighted word when you’re ready.' : 'Read the highlighted word when you’re ready.', true);
      message(clips.some(clip => clip.direct) ? 'Listening. Some audio streamed online and was not saved offline.' : 'Ready. Downloaded word audio is kept on this device for up to six days.');
    } catch (error) {
      if (error.name !== 'AbortError') {
        job.controller.abort();
        // One bounded automatic retry; failure does not count as a played hint.
        const failureKey = `${kind}:${key}`;
        const count = (failedPrompts.get(failureKey)?.count || 0) + 1;
        failedPrompts.set(failureKey, { count, nextAt: count < 2 ? Date.now() + 5000 : Infinity });
        showCard('Audio unavailable', promptWords, error.message + ' Press Replay to try again.', false, 'error'); message(error.message);
      } else if (enabled) {
        message(kind === 'correction' ? 'Teacher on. The word remains queued for review.' :
          'Teacher on. The prompt was cancelled; a new quiet pause can request it again.');
      }
    } finally {
      // Include cancellation and playback errors: a stopped speaker can still
      // leave a brief echo, which must not be counted as the learner's speech.
      if (job.gated && job.playing && getState().phase === 'recording') await new Promise(resolve => setTimeout(resolve, 400));
      if (kind === 'correction') onCorrectionSettled?.({ word, page: before.page, gateReady: job.gateReady });
      if (job.gated) await resumeRecognition({ played: job.playing }).catch(() => {});
      job.playing = false;
      if (activeJob === job) activeJob = null;
      job.finish();
      refresh(); onStateChange?.();
      queueMicrotask(() => requestCorrection());
    }
  }
  async function hearWord(word, replayWords) {
    if (!word) return;
    const before = getState();
    if (document.hidden || before.voiceSearch || !['idle', 'recording'].includes(before.phase)) return;
    // Unlock in the click handler, then finish any previous capture gate
    // before playing the latest requested word. There is never an audio queue.
    unlock(true);
    const request = { sequence: ++manualSequence, word, words: replayWords?.slice(0, 3), page: before.page, phase: before.phase };
    request.finished = new Promise(resolve => { request.finish = resolve; });
    pendingManual = request;
    const previous = activeJob;
    previous?.controller.abort();
    refresh(); onStateChange?.();
    try {
      if (previous) await previous.finished;
      const now = getState();
      if (pendingManual !== request || request.sequence !== manualSequence || document.hidden ||
          now.voiceSearch || now.page !== request.page || now.phase !== request.phase) return;
      pendingManual = null;
      await speak(request.word, 'manual', undefined, request.words);
    } finally {
      if (pendingManual === request) pendingManual = null;
      request.finish();
      refresh(); onStateChange?.();
    }
  }
  function refresh() {
    const state = getState();
    const busy = !['idle', 'recording'].includes(state.phase) || state.voiceSearch;
    $('teacher-replay').disabled = !feedbackWords.length || busy || Boolean(activeJob || pendingManual);
    $('teacher-enabled').disabled = busy;
    voices?.setDisabled(busy || Boolean(activeJob || pendingManual), busy);
    voices?.refreshEnabled(enabled);
    $('teacher-enabled').setAttribute('aria-pressed', String(enabled));
    const label = voices ? `Teacher ${enabled ? 'on' : 'off'}. Open Teacher options.` :
      enabled ? 'Teacher on. Click to turn off.' : 'Teacher off. Click to turn on.';
    $('teacher-enabled').setAttribute('aria-label', label);
    const help = busy ? 'Teacher mode is unavailable while audio is loading, starting, stopping, or searching.' : $('teacher-enabled').dataset.help;
    $('teacher-tooltip').textContent = help;
    $('teacher-icon-on').hidden = !enabled;
    $('teacher-icon-off').hidden = enabled;
    if (state.key !== lastKey) {
      lastKey = state.key;
      if (!activeJob) hideCard();
      if (correction && (correction.page !== state.page || state.cursor - correction.cursor > 6)) correction = null;
    }
    // Fetch only the next three words, not a whole chapter or Quran audio pack.
    const nextWarmKey = `${voices?.key || 'word-reference'}:${state.key}`;
    if (enabled && state.word && navigator.onLine && !state.voiceSearch && !busy && warmKey !== nextWarmKey) {
      warmController?.abort(); warmController = new AbortController(); warmKey = nextWarmKey;
      const signal = warmController.signal;
      void (async () => {
        const fetched = new Set();
        for (const word of playbackWords(state.nextWords || [])) {
          if (signal.aborted) break;
          try {
            const base = teacherAudioReference(word);
            const reference = voices ? await voices.resolve(base, signal, { quiet: true }) : base;
            // QUA warms only its small timing shard. Its chapter recording
            // must be sought by the media player, not downloaded into the
            // short-word cache in the background.
            if (reference.stream) continue;
            if (fetched.has(reference.url)) continue;
            fetched.add(reference.url);
            await fetchClip(reference.url, signal);
          } catch { if (signal.aborted) break; }
        }
      })();
    }
  }
  function observe(results, page) {
    if (!enabled) return;
    // Results draining before a correction starts may flag a later word.
    // Keep the first retry target until its audio finishes.
    const retryEnabled = document.documentElement.dataset.teacherRetry === 'word';
    if (retryEnabled && activeJob?.kind === 'correction') return;
    const reviews = results.filter(result => result.state === 'review');
    const latest = retryEnabled ? reviews[0] : reviews.at(-1);
    if (!latest?.word) return;
    const key = `${page}:${latest.word.surah}:${latest.word.ayah}:${latest.word.position}:${Boolean(latest.word.bismillah)}`;
    if (retryEnabled) {
      // Fresh learner speech is a new attempt, not the failed download's
      // automatic retry. It must be able to replace a stale queued word.
      corrected.delete(key);
      failedPrompts.delete(`correction:${key}`);
    }
    if (!corrected.has(key)) {
      correction = { key, word: latest.word, page, cursor: getState().cursor };
      if (activeJob?.kind === 'hint' && !activeJob.playing && !activeJob.controller.signal.aborted && !pendingManual)
        cancel({ hide: false, preserveCorrection: true });
      // Let the current recognition callback finish painting/turning pages
      // before starting feedback. A detected review needs no quiet pause.
      queueMicrotask(() => requestCorrection());
    }
  }
  function continuePage(page) {
    // The final flagged word can still be heard after an automatic page turn.
    if (correction) { correction.page = page; correction.cursor = 0; }
  }
  function completeRetry(word, page) {
    if (!word) return;
    const key = `${page}:${word.surah}:${word.ayah}:${word.position}:${Boolean(word.bismillah)}`;
    if (correction?.key === key) correction = null;
    failedPrompts.delete(`correction:${key}`);
    corrected.add(key);
  }
  function retryReady(kind, key) {
    const failure = failedPrompts.get(`${kind}:${key}`);
    return !failure || Date.now() >= failure.nextAt;
  }
  function requestCorrection(state = getState()) {
    if (!enabled || activeJob || pendingManual || state.phase !== 'recording' || state.voiceSearch || document.hidden) return false;
    if (correction && (correction.page !== state.page || state.cursor - correction.cursor > 6)) correction = null;
    if (!correction || !retryReady('correction', correction.key)) return false;
    const next = correction;
    void speak(next.word, 'correction', next.key);
    return true;
  }
  setInterval(() => {
    const state = getState();
    if (activeJob) {
      if (!activeJob.controller.signal.aborted && !activeJob.gated && activeJob.kind === 'hint' && state.speechAt > activeJob.speechAt)
        cancel({ preserveCorrection: true, reason: 'Teacher on. You continued reciting; waiting for another pause.' });
      return;
    }
    if (!enabled || pendingManual || state.phase !== 'recording' || state.voiceSearch || document.hidden) return;
    if (requestCorrection(state) || !state.word) return;
    // A warm-up backlog can stay above the old hint-only queue limit while
    // silence keeps arriving. Use the live microphone heartbeat; the same
    // bounded pause/drain barrier used by corrections validates queued speech
    // and the current word before any reference audio plays.
    if (!state.captureAt || Date.now() - state.captureAt > 1500) {
      message('Teacher on · Waiting for microphone audio.');
      if (card.dataset.state === 'countdown') hideCard();
      return;
    }
    // Late recognition can move the cursor during a real quiet pause. The
    // post-drain cursor check already cancels stale hints; it must not also
    // postpone every new hint for another full pause interval.
    const quietFor = Date.now() - Math.max(state.speechAt, enabledAt);
    const canHint = !hinted.has(state.key) && retryReady('hint', state.key);
    if (canHint && quietFor >= PAUSE_HINT_MS) void speak(state.word, 'hint', state.key);
    else if (canHint && quietFor >= 1000) {
      const seconds = Math.max(1, Math.ceil((PAUSE_HINT_MS - quietFor) / 1000));
      const detail = `Next ${PAUSE_HINT_WORDS > 1 ? 'words' : 'word'} in ${seconds} second${seconds === 1 ? '' : 's'}…`;
      message(`Teacher on · ${detail}`);
      if (card.hidden || card.dataset.state === 'countdown') showCard('Teacher on', null, detail, false, 'countdown');
    } else {
      if (card.dataset.state === 'countdown' && !card.hidden) hideCard();
      if (card.dataset.state !== 'error') message(hinted.has(state.key)
        ? 'Teacher on · Hint played. Click a word to hear it again.'
        : 'Teacher on · Listening for your next pause.');
    }
  }, 250);
  $('teacher-enabled').addEventListener('click', () => {
    if (voices) { voices.togglePanel(); return; }
    setEnabled(!enabled);
  });
  $('teacher-replay').addEventListener('click', () => { void hearWord(feedbackWords[0], feedbackWords); });
  $('teacher-dismiss').addEventListener('click', () => cancel());
  window.addEventListener('resize', positionCard);
  window.addEventListener('scroll', positionCard, { passive: true });
  new ResizeObserver(positionCard).observe(document.querySelector('.reader'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('pagehide', event => {
    voices?.closePanel({ restoreFocus: false });
    // Keep the panel and unlocked media element usable after Back/Forward
    // restores this document from the browser's page cache.
    if (!event.persisted) voices?.dispose();
    cancel(); mediaAudio?.pause(); void audioContext?.close().catch(() => {});
    if (!event.persisted && silentUrl) URL.revokeObjectURL(silentUrl);
  });
  $('book-settings').addEventListener('close', () => {
    if (card.parentElement === document.body) return;
    const visible = !card.hidden && card.classList.contains('is-visible');
    document.body.append(card);
    if (visible && card.showPopover && !card.matches(':popover-open')) card.showPopover();
  });
  refresh();
  message(enabled ? 'Teacher on. Start reciting, or click a word to listen.' : 'Turn on Teacher for spoken hints and corrections. Click a word to listen.');
  return { refresh, observe, cancel, cancelAndWait, unlock, continuePage, hearWord, completeRetry, get enabled() { return enabled; },
    get correctionPending() { return enabled && Boolean(correction || activeJob?.kind === 'correction'); },
    get playing() { return activeJob?.playing === true; }, get busy() { return Boolean(activeJob || pendingManual); } };
}
