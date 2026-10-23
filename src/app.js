import { alignSegment, normalize, locateTranscriptBoundary } from './alignment.js';
import { setupOffline, refreshOfflineStatus } from './offline.js';
import { createDebugPanel } from './debug.js';
import { createWordInfo, wordRules, referenceWords } from './word-info.js';
import { createMaddMonitor } from './madd.js';
import { createTajweedLog } from './tajweed-log.js';
import { createTajweedColors } from './tajweed-colors.js';
import { captureRecognitionBoundary, locateRecognitionBoundary } from './recognition-boundary.js';
import { createTeacherMode, teacherAudioReference } from './teacher-mode.js';
import { createTeacherActivity } from './teacher-activity.js';
import { createTeacherRetry, preserveReview } from './teacher-retry.js';
import { setupMobilePageSwipe } from './mobile-page-swipe.js';
import { createAccounts } from './accounts.js';

const $ = id => document.getElementById(id);
const arabicNumber = new Intl.NumberFormat('ar', { numberingSystem: 'arab', useGrouping: false });
const juzNames = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر',
  'الحادي عشر', 'الثاني عشر', 'الثالث عشر', 'الرابع عشر', 'الخامس عشر', 'السادس عشر', 'السابع عشر', 'الثامن عشر', 'التاسع عشر', 'العشرون',
  'الحادي والعشرون', 'الثاني والعشرون', 'الثالث والعشرون', 'الرابع والعشرون', 'الخامس والعشرون', 'السادس والعشرون',
  'السابع والعشرون', 'الثامن والعشرون', 'التاسع والعشرون', 'الثلاثون'];
const bookView = document.body.classList.contains('book-view');
const mobileView = document.documentElement.dataset.layout === 'mobile';
const interruptControls = document.documentElement.dataset.controlInterrupt === 'enabled';
const teacherRetryEnabled = document.documentElement.dataset.teacherRetry === 'word';
const teacherRetry = createTeacherRetry(teacherRetryEnabled);
let chapters = [], words = [], elements = [], states = [], committed = [];
let chapter, cursor = 0, segmentStart = 0, phase = 'idle', engineReady = false;
let accountClient, accountProgressReady = false, restoringAccountProgress = false;
let accountProgressSignature = '', accountProgressUpdatedAt = 0;
const accountProgressListeners = new Set();
let segmentCarry = '';
let alignmentAnchor = null;
let pageBoundary = null;
let reviewDetails = [], completedMatched = 0, completedReview = 0, completedPages = 0, firstPracticePage = 1;
const maddEnabled = document.documentElement.dataset.maddTiming === 'experimental';
const tajweedReviewEnabled = document.documentElement.dataset.tajweedReview === 'experimental';
const tajweedColors = createTajweedColors(document.documentElement.dataset.tajweedColors === 'preview');
const tajweedLog = tajweedReviewEnabled ? createTajweedLog() : null;
const madd = createMaddMonitor(maddEnabled, {
  reviewEnabled: tajweedReviewEnabled,
  getSpeed: () => $('tajweed-speed')?.value || 'normal',
  onDiagnostic: event => tajweedLog?.record(event),
});
const wordInfo = createWordInfo(index => {
  const recoveryIndex = words.findIndex(word => word.accessible === reviewDetails[index]?.recoveryWord);
  const recoveryElement = elements[recoveryIndex];
  return { word: words[index], state: states[index], detail: reviewDetails[index], madd: madd.get(index), hidden: memoryMode && !states[index],
    recoveryDisplay: recoveryElement ? { text: recoveryElement.textContent, font: getComputedStyle(recoveryElement).fontFamily } : null };
});
let worker, sessionId = 0, pendingChunks = 0, workerTimer;
let media, context, source, capture, analyser, mute, animation, flushResolve;
let finishResolve, startResolve, stopPromise, engineResolve;
let controlActionTail = Promise.resolve(), pendingControlActions = 0, swipeTurnPending = false;
let elapsed = 0, startedAt = 0, memoryMode = false, fontSize = 34;
try {
  const savedSize = Number(localStorage.getItem('hafizassist-font-size'));
  if (savedSize >= 24 && savedSize <= 56) fontSize = savedSize;
} catch {}
let lastFollowedAyah = null, savedThisRun = false;
let history = [];
let voiceSearch = false, voiceText = '', searchWorker, searchRequest = 0, searchTimer;
let voiceEpoch = 0, voiceOpening = false, voiceClosing = false, voiceNavigating = false;
let voiceQuery = null, voiceLiveTimer, voiceLiveQueued = false, voiceLastQuery = '';
let voiceRevision = 0, voiceObservedText = '', voiceCandidate = null, voiceBeganAt = 0;
let voiceStartupContext;
const voiceActivity = createTeacherActivity();
const VOICE_PAUSE_MS = 2000;
// Reserve WebAudio on the original tap, before a previous recitation drains.
// Mobile browsers may reject a newly created context after an awaited action.
document.addEventListener('click', event => {
  const opener = event.target.closest('#book-search, #voice-open');
  if (!event.isTrusted || !opener || opener.disabled || voiceSearch || voiceOpening || voiceStartupContext) return;
  try {
    voiceStartupContext = new AudioContext();
    void voiceStartupContext.resume().catch(() => {});
  } catch { /* startRecording surfaces browser support and permission errors. */ }
}, true);
let scrollFrame;
let mobileAlignmentPending = false;
let mobileAlignmentFrame, mobileReadingStart, mobileHeightFrame;
let micNoticeTimer, micNoticeExpiresAt = 0, pendingMicNotice = '';
function hideMicNotice() {
  clearTimeout(micNoticeTimer); pendingMicNotice = ''; micNoticeExpiresAt = 0;
  const notice = $('mic-notice');
  if (notice.hidePopover && notice.matches(':popover-open')) notice.hidePopover();
  notice.hidden = true;
}
function scheduleMicNoticeDismissal() {
  clearTimeout(micNoticeTimer);
  const notice = $('mic-notice');
  if (!document.hidden && !notice.hidden) {
    micNoticeExpiresAt = Date.now() + 5000;
    micNoticeTimer = setTimeout(hideMicNotice, 5000);
  }
}
function showMicNotice(message) {
  hideMicNotice();
  pendingMicNotice = message;
  if (document.hidden) return;
  const notice = $('mic-notice');
  $('mic-notice-message').textContent = message;
  notice.hidden = false;
  if (notice.showPopover) notice.showPopover();
  else ($('voice-dialog').open ? $('voice-dialog') : document.body).append(notice);
  scheduleMicNoticeDismissal();
}
$('mic-notice-close').addEventListener('click', hideMicNotice);
let layouts = {}, currentPage = 1;
const verseKey = verse => `${verse.surah}:${verse.ayah}`;
let lastRecognitionAt = 0, lastAdvanceAt = 0, lastAudioLogAt = 0, lastTranscript = '', micSettings = {};
let audioDiagnostic = {};
const teacherActivity = createTeacherActivity();
let teacherTranscript = '', teacherGate = false, teacherDraining = false, captureSequence = 0, teacherDrainResolve;
const captureActions = new Map();
function teacherWord(word) {
  if (!word) return null;
  const reference = teacherAudioReference(word);
  if (!reference.combined) return word;
  const verse = chapters.find(item => item.id === word.surah)?.verses.find(item => item.ayah === word.ayah);
  const text = verse?.aya_text.trim().split(/\s+/u);
  return { ...word, audioLabel: text?.slice(reference.split - 1, reference.split + 1).join(' ') || word.accessible };
}
const teacher = createTeacherMode({
  getState: () => ({ phase, voiceSearch, page: currentPage, cursor, word: teacherWord(words[cursor]),
    key: `${currentPage}:${words[cursor]?.surah}:${words[cursor]?.ayah}:${words[cursor]?.position}:${Boolean(words[cursor]?.bismillah)}`,
    nextWords: words.slice(cursor, cursor + 3).map(teacherWord), speechAt: teacherActivity.speechAt, advanceAt: lastAdvanceAt,
    audioAt: audioDiagnostic.receivedAt, captureAt: teacherActivity.captureAt, activity: teacherActivity.diagnostic, pendingChunks }),
  pauseRecognition: pauseForTeacher,
  resumeRecognition: resumeAfterTeacher,
  onEnabledChange(enabled) { if (!enabled) teacherRetry.clear(); },
  onCorrectionPlayed({ word, page }) {
    if (!teacherRetryEnabled || phase !== 'recording' || !teacherGate || page !== currentPage ||
        !teacherRetry.begin(words, word, currentPage, cursor)) return false;
    // Capture is still paused and all queued learner results have drained.
    // Rebase matching on fresh learner audio, keeping the mistake history.
    cursor = teacherRetry.pending.index; segmentStart = cursor;
    committed = [...states]; segmentCarry = ''; alignmentAnchor = null; pageBoundary = null;
    lastTranscript = ''; teacherTranscript = ''; lastFollowedAyah = null;
    savedThisRun = false;
    debug.log('teacher-retry', { page: currentPage, target: debugWord(cursor), frontier: teacherRetry.pending.frontier });
    paint(); followWord(true);
    return true;
  },
  onCorrectionSettled({ word, page, gateReady }) {
    if (page !== currentPage || !teacherRetry.pending?.awaitingReference) return;
    if (phase === 'recording' && teacherGate && gateReady) {
      // A failed or dismissed clip still leaves a fresh recognizer. Let the
      // learner retry the held word instead of waiting forever for audio.
      teacherRetry.activate(page, word);
    } else if (phase === 'recording' && teacher.enabled) {
      // A failed capture/session barrier cannot safely reuse old speech.
      void failEngine('Recitation paused because Teacher could not reset listening safely. Start the microphone again to retry this word.');
    }
  },
  onStateChange: controls,
});

function controlCapture(type) {
  if (!capture) return Promise.reject(new Error('The microphone is unavailable.'));
  return new Promise((resolve, reject) => {
    const id = ++captureSequence;
    const timer = setTimeout(() => { captureActions.delete(id); reject(new Error('The microphone could not pause safely for audio.')); }, 2000);
    captureActions.set(id, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
    capture.port.postMessage({ type, id });
  });
}
function drainCapturedAudio() {
  if (!pendingChunks) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { teacherDrainResolve = null; reject(new Error('Speech recognition is still catching up. Click a word to try again.')); }, 4000);
    teacherDrainResolve = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
  });
}
async function pauseForTeacher(signal) {
  if (phase !== 'recording' || voiceSearch || !worker || !capture) throw new DOMException('Recitation ended.', 'AbortError');
  const heldCorrection = teacherRetry.pending?.awaitingReference === true;
  teacherGate = true;
  teacherDraining = true;
  wordInfo.hide();
  try {
    await controlCapture('pause');
    // PCM submission is paused, but already queued learner results still
    // count. Silence need not find an instant at which the queue is empty.
    await drainCapturedAudio();
  } finally { teacherDraining = false; }
  // Even a dismissed correction must discard the old cumulative speech before
  // capture resumes. The playback job checks cancellation after this barrier.
  if ((signal?.aborted && !heldCorrection) || phase !== 'recording' || !worker) throw new DOMException('Recitation ended.', 'AbortError');
  // New session IDs discard old queued ASR results. The start reply is a FIFO
  // barrier: old inference has finished before the reference voice can play.
  sessionId++; pendingChunks = 0; segmentStart = cursor; committed = [...states]; segmentCarry = '';
  alignmentAnchor = null; pageBoundary = null; lastTranscript = ''; teacherTranscript = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { startResolve = null; reject(new Error('The speech engine did not reset for Teacher mode.')); }, 15000);
    startResolve = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    worker.postMessage({ type: 'start', sessionId, maddTiming: maddEnabled });
  });
  debug.log('teacher-gate', { sessionId, page: currentPage, cursor });
}
async function resumeAfterTeacher({ played = false } = {}) {
  try {
    if (phase === 'recording' && capture) {
      await controlCapture('resume');
      // Only a spoken reference/echo needs a fresh pause clock. A cancelled
      // stale prompt must not start another five-second wait in silence.
      if (played) { teacherActivity.reset(Date.now(), { preserveNoise: true }); lastAdvanceAt = Date.now(); }
      debug.log('teacher-resume', { sessionId, page: currentPage, cursor });
    }
  } catch (error) {
    if (phase === 'recording') void failEngine(error.message);
  } finally { teacherGate = false; teacherDraining = false; controls(); }
}
function debugWord(index) {
  const word = words[index];
  return word ? { index, surah: word.surah, ayah: word.ayah, word: word.position + 1,
    bismillah: Boolean(word.bismillah), text: word.accessible, phoneme: word.phoneme, state: states[index] || 'upcoming' } : null;
}
function debugSnapshot() {
  const now = Date.now();
  return { phase, page: currentPage, sessionId, engineReady, cursor, segmentStart,
    totalWords: words.length, pendingChunks, estimatedQueuedAudioMs: pendingChunks * 320,
    alignmentAnchor: alignmentAnchor ? { cursor: alignmentAnchor.cursor, offset: alignmentAnchor.offset, audio: alignmentAnchor.audio } : null,
    sinceRecognitionMs: lastRecognitionAt ? now - lastRecognitionAt : null,
    sinceAdvanceMs: lastAdvanceAt ? now - lastAdvanceAt : null,
    expected: debugWord(cursor), nearby: words.slice(Math.max(0, cursor - 2), cursor + 5).map((_, i) => debugWord(Math.max(0, cursor - 2) + i)),
    transcript: lastTranscript, segmentCarry, audio: audioDiagnostic, micSettings,
    audioContextState: context?.state || 'closed', status: $('status').textContent };
}
const debug = createDebugPanel(debugSnapshot);
try { history = JSON.parse(localStorage.getItem('hafizassist-history') || '[]'); if (!Array.isArray(history)) history = []; } catch {}
try { document.body.classList.toggle('dark', localStorage.getItem('hafizassist-theme') === 'dark'); } catch {}


function status(message, error = false) {
  if (voiceSearch) { $('voice-status').textContent = message; $('voice-status').classList.toggle('error', error); }
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
  // Keep routine practice messages out of the reading area, but surface problems and setup progress.
  $('status').hidden = voiceSearch || !(error || ['loading', 'starting'].includes(phase));
}
function locked() { return ['loading', 'starting', 'recording', 'stopping'].includes(phase); }
function navigationLocked() {
  return interruptControls ? ['loading', 'starting'].includes(phase) || (phase === 'stopping' && !pendingControlActions) : locked();
}
function runControlAction(action) {
  if (!interruptControls) return Promise.resolve(action());
  // Hold the mic off until the old session has drained and the requested
  // action has finished. Queued ASR must never land on a newly selected page.
  pendingControlActions++;
  controls();
  const operation = controlActionTail.then(async () => {
    if (phase === 'recording' || stopPromise) await stopRecording();
    if (phase !== 'idle') return false;
    await teacher.cancelAndWait();
    if (phase !== 'idle') return false;
    return action();
  }).catch(error => { status(error.message, true); return false; }).finally(() => {
    pendingControlActions--;
    controls();
  });
  controlActionTail = operation;
  return operation;
}
if (interruptControls) {
  // External modules own these click handlers. Replay the requested action
  // after stopping, keeping their existing dialog and accessibility behavior.
  // Word taps stay in the reader's bubble handler, AFTER swipe suppression.
  const deferredControls = '#visibility, #theme, #font-smaller, #font-larger, #reset, #book-search, #book-menu, #book-close, #teacher-enabled, #teacher-voices button, #teacher-voices input, #teacher-replay, #teacher-dismiss, #account-open, #account-dialog button, #account-dialog a';
  let replayingControl = false;
  const replayControl = action => {
    replayingControl = true;
    try { action(); } finally { replayingControl = false; }
  };
  document.addEventListener('click', event => {
    const control = event.target.closest(deferredControls);
    if (replayingControl || !control || voiceSearch || (!pendingControlActions && !['recording', 'stopping'].includes(phase))) return;
    if (control.closest('#teacher-voices') || ['teacher-enabled', 'teacher-replay'].includes(control.id)) teacher.unlock(true);
    event.preventDefault(); event.stopImmediatePropagation();
    void runControlAction(() => { if (control.isConnected && !control.disabled) replayControl(() => control.click()); });
  }, true);
  const beginEditing = event => {
    if (!voiceSearch && phase === 'recording' && event.target.matches('#search, #surah, #ui-language')) {
      // Keep the native input/picker gesture; only the session stops here.
      void runControlAction(() => {});
    }
  };
  document.addEventListener('pointerdown', beginEditing, true);
  document.addEventListener('focusin', beginEditing);
  document.addEventListener('change', event => {
    if (replayingControl || voiceSearch || (!pendingControlActions && !['recording', 'stopping'].includes(phase)) || event.target.id !== 'ui-language') return;
    const select = event.target, value = select.value;
    event.stopImmediatePropagation();
    void runControlAction(() => replayControl(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }));
  }, true);
}
function showSearchLockTip() {
  if (!$('search-lock-info').hidden) $('search-lock-tip').hidden = false;
}
function hideSearchLockTip() { $('search-lock-tip').hidden = true; }
$('search-lock-info').addEventListener('pointerenter', showSearchLockTip);
$('search-lock-info').addEventListener('focus', showSearchLockTip);
$('search-lock-info').addEventListener('click', showSearchLockTip);
$('search-lock-info').addEventListener('pointerleave', () => {
  if (document.activeElement !== $('search-lock-info')) hideSearchLockTip();
});
$('search-lock-info').addEventListener('blur', hideSearchLockTip);
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideSearchLockTip(); });
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.search-surah-row')) hideSearchLockTip();
});
function controls() {
  const busy = ['loading', 'starting', 'stopping'].includes(phase);
  document.body.classList.toggle('reciting', phase === 'recording' && !voiceSearch);
  if (mobileView) {
    const reading = phase === 'recording' && !voiceSearch;
    document.body.classList.toggle('mobile-reciting', reading);
    if (!reading) {
      cancelAnimationFrame(mobileAlignmentFrame);
      mobileAlignmentPending = false; mobileReadingStart = null;
      document.querySelector('main').style.removeProperty('--mobile-reading-tail');
    }
  }
  $('voice-open').disabled = !chapter || navigationLocked();
  const voiceShortcut = $('book-search');
  if (voiceShortcut) {
    voiceShortcut.disabled = $('voice-open').disabled;
    voiceShortcut.title = phase === 'recording' && !interruptControls ? 'Stop the microphone before searching for a verse by voice.'
      : voiceShortcut.disabled ? 'Voice search will be available when Quran loading and microphone setup have finished.'
      : 'Find a verse by voice';
  }
  $('voice-close').disabled = voiceSearch && busy;
  $('voice-record').disabled = busy || pendingControlActions > 0 || voiceClosing || voiceNavigating || (phase === 'idle' && teacher.busy);
  $('voice-record').textContent = phase === 'recording' ? 'Finish search' : busy ? 'Please wait…' : 'Try again';
  $('voice-record').classList.toggle('listening', voiceSearch && phase === 'recording');
  for (const id of ['search', 'search-go', 'surah']) $(id).disabled = navigationLocked() || !chapter;
  const searchLocked = navigationLocked() || !chapter;
  $('search-lock-info').hidden = !searchLocked;
  $('search-lock-tip').textContent = ({
    recording: 'Search is paused while the microphone is on. Press the microphone button to stop reciting, then search or choose a surah.',
    loading: 'Search is paused while the speech model loads. Once recitation starts, stop the microphone to change passages.',
    starting: 'Search is paused while the microphone starts. Stop reciting before changing passages.',
    stopping: 'Finishing recognition. Search will be available again in a moment.',
  })[phase] || 'Search will be available when the Quran text has loaded.';
  if (!searchLocked) hideSearchLockTip();
  $('previous-page').disabled = navigationLocked() || currentPage <= 1;
  $('next-page').disabled = navigationLocked() || currentPage >= 604;
  $('record').disabled = !chapter || Boolean(stopPromise) || pendingControlActions > 0 || swipeTurnPending || ['loading', 'starting', 'stopping'].includes(phase) || (phase === 'idle' && teacher.busy);
  $('reset').disabled = ['loading', 'starting', 'stopping'].includes(phase);
  $('record').classList.toggle('recording', phase === 'recording');
  const recordLabel = ({ loading: 'Loading model…', starting: 'Opening microphone…', recording: 'Stop reciting', stopping: 'Finishing…' })[phase] || 'Start reciting';
  $('record').setAttribute('aria-label', recordLabel);
  $('record').title = recordLabel;
  $('record').setAttribute('aria-pressed', String(phase === 'recording'));
  $('record').setAttribute('aria-busy', String(['loading', 'starting', 'stopping'].includes(phase)));
  teacher.refresh();
  notifyAccountProgress();
}

function formatTime(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
setInterval(() => { $('time').textContent = formatTime(elapsed + (startedAt ? (Date.now() - startedAt) / 1000 : 0)); }, 500);

function paint() {
  let matched = 0, review = 0;
  for (let i = 0; i < elements.length; i++) {
    const state = states[i] || '';
    const concealed = memoryMode && !state;
    elements[i].className = `word ${state} ${i === cursor ? 'next' : ''} ${concealed ? 'concealed' : ''}`;
    const action = bookView ? 'Click to hear this word.' : 'Select to resume here.';
    elements[i].setAttribute('aria-label', concealed ? `Hidden word ${words[i].position + 1}, ayah ${words[i].ayah}. ${action}` : `${words[i].accessible} — ${state === 'review' ? 'needs review' : state || 'upcoming'}. ${action}`);
    if (state === 'matched') matched++;
    if (state === 'review') review++;
  }
  const percentage = words.length ? Math.round((matched + review) / words.length * 100) : 0;
  $('matched').textContent = completedMatched + matched;
  $('mistakes').textContent = completedReview + review;
  const correctTotal = completedMatched + matched, reviewedTotal = completedReview + review;
  $('accuracy').textContent = correctTotal + reviewedTotal ? `${Math.round(correctTotal / (correctTotal + reviewedTotal) * 100)}%` : '—';
  $('progress').value = percentage;
  $('percent').textContent = `${percentage}%`;
  if (words[cursor]) { chapter = chapters.find(c => c.id === words[cursor].surah); $('surah').value = String(chapter.id); }
  const currentAyah = words[cursor] && `${words[cursor].surah}:${words[cursor].ayah}`;
  document.querySelectorAll('.ayah').forEach(row => row.classList.toggle('current', row.dataset.key === currentAyah));
  const currentPosition = currentAyah && `${currentPage}:${cursor}`;
  if (currentPosition && currentPosition !== lastFollowedAyah && phase === 'recording') {
    followWord();
  }
  lastFollowedAyah = currentPosition;
  teacher.refresh();
  if (tajweedReviewEnabled) wordInfo.refresh();
  notifyAccountProgress({ meaningful: ['recording', 'stopping'].includes(phase) && !voiceSearch });
}

// Account checkpoints use the Quran's word coordinates, never the transient
// recognition cursor or transcripts. Historical per-word flags stay local.
function captureAccountProgress() {
  if (!accountProgressReady || !words.length) return null;
  const word = words[cursor] || words.at(-1);
  const snapshot = {
    schema: 1,
    position: { page: currentPage, surah: word.surah, ayah: word.ayah,
      word: word.position, bismillah: Boolean(word.bismillah) },
    totals: { correct: completedMatched + states.filter(state => state === 'matched').length,
      reviewed: completedReview + states.filter(state => state === 'review').length },
  };
  const signature = JSON.stringify(snapshot);
  if (signature !== accountProgressSignature) {
    accountProgressSignature = signature;
    accountProgressUpdatedAt = Date.now();
  }
  return { ...snapshot, updatedAt: accountProgressUpdatedAt };
}

function notifyAccountProgress(options = {}) {
  if (!accountProgressReady || restoringAccountProgress || voiceSearch) return;
  for (const listener of accountProgressListeners) listener(options);
}

function restoreAccountProgress(progress) {
  if (!accountProgressReady || locked() || teacher.busy || voiceSearch) {
    throw new Error('Stop reciting and close voice search before resuming saved progress.');
  }
  const position = progress?.position;
  const verse = chapters.find(item => item.id === position?.surah)?.verses.find(item => item.ayah === position?.ayah);
  const layout = verse && layouts[verseKey(verse)]?.[1];
  const bismillah = position?.bismillah === true;
  const count = bismillah ? chapters[0].verses[0].aya_phonemes_list.length : verse?.aya_phonemes_list.length;
  const onPage = bismillah
    ? position?.ayah === 1 && ![1, 9].includes(position?.surah) && layout?.[0]?.[0] === position?.page
    : layout?.[position?.word]?.[0] === position?.page;
  const totals = progress?.totals;
  if (progress?.schema !== 1 || !Number.isInteger(position?.page) || position.page < 1 || position.page > 604 ||
      !Number.isInteger(position?.word) || position.word < 0 || position.word >= count || !onPage ||
      !Number.isSafeInteger(totals?.correct) || totals.correct < 0 ||
      !Number.isSafeInteger(totals?.reviewed) || totals.reviewed < 0) {
    throw new Error('This saved position does not match the current Quran page data.');
  }
  restoringAccountProgress = true;
  try {
    openPage(position.page);
    const index = words.findIndex(word => word.surah === position.surah && word.ayah === position.ayah &&
      word.position === position.word && Boolean(word.bismillah) === bismillah);
    if (index < 0) throw new Error('This saved position does not match the current Quran page data.');
    cursor = index; segmentStart = index;
    completedMatched = totals.correct; completedReview = totals.reviewed;
    // Restore only the agreed checkpoint and totals. Do not invent previous
    // word highlights or treat account data as recognition evidence.
    committed = [...states]; lastFollowedAyah = null;
    paint(); controls(); followWord(true);
    status('Saved position restored. Start reciting when you’re ready.');
  } finally { restoringAccountProgress = false; }
}

function followWord(force = false) {
  if (mobileReadingStart) {
    if (mobileReadingStart.page === currentPage && mobileReadingStart.cursor === cursor && phase === 'recording') {
      // Font fitting must not replace the mic's first-line alignment with
      // the usual centered-word scroll before the learner has progressed.
      if (!mobileAlignmentPending) alignMobileReadingStart(false);
      return;
    }
    mobileReadingStart = null;
  }
  if (mobileAlignmentPending) return;
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    const element = elements[cursor];
    if (!element || $('voice-dialog').open) return;
    const word = element.getBoundingClientRect();
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    // The Mushaf grows with its text; only the document scrolls.
    if (force || word.top < (mobileView ? 0 : 48) || word.bottom > innerHeight - 64) {
      window.scrollBy({ top: word.top - innerHeight / 3, behavior });
    }
  });
}
function alignMobileReadingStart(reset = true) {
  if (!mobileView || voiceSearch || phase !== 'recording') return;
  if (reset) mobileReadingStart = { page: currentPage, cursor };
  if (!mobileReadingStart || mobileReadingStart.page !== currentPage || mobileReadingStart.cursor !== cursor) return;
  cancelAnimationFrame(scrollFrame);
  cancelAnimationFrame(mobileAlignmentFrame);
  mobileAlignmentPending = true;
  mobileAlignmentFrame = requestAnimationFrame(() => {
    try {
      if (phase !== 'recording' || voiceSearch || $('voice-dialog').open || $('book-settings')?.open ||
          mobileReadingStart?.page !== currentPage || mobileReadingStart?.cursor !== cursor) return;
      fitMushafLines();
      // Use only a recitable row, including Bismillah, never either heading.
      const firstLine = $('ayahs').querySelector('.bismillah-line, .mushaf-line');
      if (!firstLine) return;
      const main = document.querySelector('main');
      main.style.setProperty('--mobile-reading-tail', '0px');
      const viewportTop = window.visualViewport?.offsetTop || 0;
      const target = Math.max(0, window.scrollY + firstLine.getBoundingClientRect().top - viewportTop - 8);
      const normalLimit = Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight);
      // Give even a short opening page enough document height to reach its
      // first reading line. Only the document scrolls; the Mushaf stays whole.
      main.style.setProperty('--mobile-reading-tail', `${Math.max(0, target - normalLimit)}px`);
      window.scrollTo({ top: target, behavior: 'instant' });
    } finally { mobileAlignmentPending = false; mobileAlignmentFrame = null; }
  });
}
if (mobileView) {
  const releaseReadingStart = () => {
    mobileReadingStart = null; mobileAlignmentPending = false;
    cancelAnimationFrame(mobileAlignmentFrame);
  };
  document.querySelector('.reader').addEventListener('pointerdown', releaseReadingStart, { passive: true });
  window.addEventListener('wheel', releaseReadingStart, { passive: true });
  const resizeReadingPage = () => {
    cancelAnimationFrame(mobileHeightFrame);
    mobileHeightFrame = requestAnimationFrame(() => {
      if (mobileReadingStart) alignMobileReadingStart(false);
      else fitMobilePageHeight();
    });
  };
  window.visualViewport?.addEventListener('resize', resizeReadingPage);
  window.addEventListener('resize', resizeReadingPage);
}
function appendWord(row, word, text) {
  const index = words.length; words.push(word);
  const button = document.createElement('button');
  button.className = 'word';
  // Reading pages share one Unicode Quran font with Arabic word details.
  button.textContent = bookView ? word.accessible : text;
  tajweedColors.decorate(button, word);
  button.type = 'button';
  wordInfo.bind(button, index);
  button.addEventListener('click', () => {
    if (bookView) {
      const reference = teacherWord(word);
      if (interruptControls && (pendingControlActions || ['recording', 'stopping'].includes(phase)) && !voiceSearch) {
        teacher.unlock(true);
        void runControlAction(() => { void teacher.hearWord(reference); });
      } else teacher.hearWord(reference);
      return;
    }
    if (locked()) { status('Stop reciting before choosing a different starting word.'); return; }
    teacher.cancel({ reset: true });
    cursor = index; segmentStart = index; segmentCarry = '';
    alignmentAnchor = null;
    pageBoundary = null;
    lastAdvanceAt = Date.now(); debug.log('word-selected', { expected: debugWord(index) });
    states = states.map((state, i) => i < index ? state : undefined); committed = [...states];
    reviewDetails = reviewDetails.map((detail, i) => i < index ? detail : undefined);
    savedThisRun = false; paint();
    status(word.bismillah ? 'Ready from the opening Bismillah.' : `Ready from ayah ${word.surah}:${word.ayah}, word ${word.position + 1}.`);
  });
  row.append(button, document.createTextNode(' ')); elements.push(button);
}

function renderPassage(continuing = false) {
  teacherRetry.clear();
  teacher.cancel({ reset: !continuing, preserveCorrection: continuing });
  wordInfo.hide();
  $('ayahs').replaceChildren(); words = []; elements = [];
  $('ayahs').classList.toggle('opening-page', currentPage <= 2);
  $('page-label').textContent = document.documentElement.dataset.uiLanguage === 'enabled'
    ? arabicNumber.format(currentPage) : `Page ${currentPage}`;
  const verses = chapters.flatMap(c => c.verses).filter(v => layouts[verseKey(v)][1].some(([page]) => page === currentPage));
  const lines = new Map();
  function pageLine(line) {
    if (!lines.has(line)) {
      const row = document.createElement('div'); row.className = 'mushaf-line'; row.lang = 'ar'; row.dir = 'rtl';
      lines.set(line, row); $('ayahs').append(row);
    }
    return lines.get(line);
  }
  for (const verse of verses) {
    const layout = layouts[verseKey(verse)][1];
    if (verse.ayah === 1 && layout[0][0] === currentPage) {
      const heading = document.createElement('h3'); heading.className = 'mushaf-surah-header'; heading.lang = 'ar'; heading.dir = 'rtl';
      heading.textContent = `سورة ${chapters.find(c => c.id === verse.surah).ar}`; $('ayahs').append(heading);
      // Al-Fatihah already includes Bismillah as 1:1; At-Tawbah has no opening Bismillah.
      if (![1, 9].includes(verse.surah)) {
        const row = document.createElement('div');
        row.className = 'bismillah-line'; row.lang = 'ar'; row.dir = 'rtl';
        const opening = chapters[0].verses[0];
        const text = ['بِسْمِ', 'اللَّهِ', 'الرَّحْمَٰنِ', 'الرَّحِيمِ'];
        opening.aya_phonemes_list.forEach((phoneme, position) => {
          appendWord(row, { surah: verse.surah, ayah: 1, position, wordCount: opening.aya_phonemes_list.length, bismillah: true,
            phoneme: normalize(phoneme), accessible: text[position], rules: opening.wordRules[position], reference: opening.referenceWords[position] }, text[position]);
        });
        $('ayahs').append(row);
      }
    }
    // Preserve the source's exact per-word glyph and phoneme mapping.
    const glyphs = verse.aya_ui.trim().split(/\s+/u); glyphs.pop();
    const readable = verse.aya_text.trim().split(/\s+/u);
    verse.aya_phonemes_list.forEach((phoneme, position) => {
      if (layout[position][0] !== currentPage) return;
      appendWord(pageLine(layout[position][1]), { surah: verse.surah, ayah: verse.ayah, position, wordCount: verse.aya_phonemes_list.length,
        phoneme: normalize(phoneme), accessible: readable[position] || `Word ${position + 1}`, rules: verse.wordRules[position], reference: verse.referenceWords[position]
      }, glyphs[position] || readable[position] || '…');
    });
    if (layout.at(-1)[0] === currentPage) {
      const number = document.createElement('span'); number.className = 'ayah-number';
      number.textContent = arabicNumber.format(verse.ayah); number.setAttribute('aria-label', `Ayah ${verse.ayah}`);
      pageLine(layout.at(-1)[1]).append(number);
    }
  }
  const pageChapters = [...new Set(verses.map(v => v.surah))].map(id => chapters.find(c => c.id === id));
  $('surah-ar').textContent = pageChapters.map(c => c.ar).join(' · ');
  const juz = layouts[verseKey(verses[0])][0];
  $('surah-title').textContent = `الجزء ${juzNames[juz - 1] || arabicNumber.format(juz)}`;
  $('surah-title').setAttribute('aria-label', `Juz ${juz}`);
  const passageLabel = `PAGE ${currentPage} · ${pageChapters.map(c => c.en).join(' / ')}`;
  $('passage-label').textContent = passageLabel;
  $('passage-label').dataset.passage = passageLabel;
  if (continuing) {
    states = new Array(words.length); committed = [...states]; reviewDetails = [];
    cursor = 0; segmentStart = 0; lastFollowedAyah = null; paint();
  } else resetSession();
  $('ayahs').scrollTop = 0; controls(); fitMushafLines();
  if (continuing) alignMobileReadingStart();
}
function fitMushafLines() {
  const reader = document.querySelector('.reader'), container = $('ayahs');
  const lines = [...container.querySelectorAll('.mushaf-line, .bismillah-line')];
  const horizontalSpace = element => {
    const style = getComputedStyle(element);
    return ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
      .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
  };
  const naturalWidth = line => {
    const children = [...line.children];
    const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
    return children.reduce((sum, child) => {
      const style = getComputedStyle(child);
      return sum + child.getBoundingClientRect().width + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
    }, gap * Math.max(0, children.length - 1));
  };
  // Measure the actual glyphs at the largest setting, then scale the page and
  // its text together. The parent width, not the resized reader, is the limit.
  lines.forEach(line => line.style.setProperty('--quran-size', '56px'));
  const widest = Math.max(0, ...lines.map(naturalWidth));
  const parent = reader.parentElement;
  const maximum = Math.min(850, parent.getBoundingClientRect().width - horizontalSpace(parent));
  const frame = horizontalSpace(reader) + horizontalSpace(container);
  if (widest && maximum > frame) {
    const fullTextWidth = Math.min(widest + 2, maximum - frame);
    const target = fullTextWidth * fontSize / 56 + frame;
    reader.style.width = `${Math.min(maximum, Math.max(Math.min(360, maximum), target))}px`;
  }
  // Preserve the source Mushaf lines; reduce only lines that exceed the page width.
  $('ayahs').style.setProperty('--quran-size', `${fontSize}px`);
  for (const line of $('ayahs').querySelectorAll('.mushaf-line, .bismillah-line')) {
    let size = fontSize;
    line.style.setProperty('--quran-size', `${size}px`);
    const available = line.clientWidth;
    if (!available) continue;
    const children = [...line.children];
    const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const needed = children.reduce((sum, child) => {
        const style = getComputedStyle(child);
        return sum + child.getBoundingClientRect().width + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
      }, gap * Math.max(0, children.length - 1));
      if (needed <= available - 1) break;
      size *= (available - 2) / needed;
      line.style.setProperty('--quran-size', `${size}px`);
    }
  }
  if (lines.length) {
    // Use one fitted size for every Quran row, including Bismillah. The
    // longest row sets the size so printed lines stay intact on phones too.
    const commonSize = Math.min(...lines.map(line => parseFloat(line.style.getPropertyValue('--quran-size')) || fontSize));
    lines.forEach(line => line.style.setProperty('--quran-size', `${commonSize}px`));
  }
  fitMobilePageHeight();
  $('font-smaller').disabled = fontSize <= 24;
  $('font-larger').disabled = fontSize >= 56;
}
function fitMobilePageHeight() {
  if (!mobileView) return;
  const viewport = window.visualViewport;
  // Leave pinch zoom alone instead of rearranging the text beneath it.
  if (viewport && Math.abs(viewport.scale - 1) > .05) return;
  const container = $('ayahs'), reader = container.closest('.reader');
  const rows = [...container.children];
  // Opening pages and pages with chapter headings keep their natural layout.
  // Only a full page of 15 text rows shares the extra vertical space.
  if (rows.length !== 15 || rows.some(row => !row.classList.contains('mushaf-line'))) {
    container.style.removeProperty('--mobile-line-gap');
    return;
  }
  const first = rows[0].getBoundingClientRect();
  const last = rows.at(-1).getBoundingClientRect();
  const gapCount = rows.length - 1;
  const oldGap = parseFloat(container.style.getPropertyValue('--mobile-line-gap')) || 0;
  // Subtract our previous spacing so repeated fits cannot accumulate gaps.
  const naturalHeight = last.bottom - first.top - oldGap * gapCount;
  const footerHeight = reader.getBoundingClientRect().bottom - last.bottom;
  const top = phase === 'recording' && !voiceSearch
    ? 8 : Math.max(8, first.top - (viewport?.offsetTop || 0));
  const available = (viewport?.height || innerHeight) - top - footerHeight - 12;
  const size = parseFloat(rows[0].style.getPropertyValue('--quran-size')) || fontSize;
  // Width fitting remains the font limit. Add only breathing room between
  // rows; a short screen keeps natural spacing and document scrolling.
  const gap = Math.max(0, Math.min(size * .65, (available - naturalHeight) / gapCount));
  container.style.setProperty('--mobile-line-gap', `${gap}px`);
}
let fittedWidth = 0, fitFrame;
new ResizeObserver(entries => {
  const width = entries[0].contentRect.width;
  if (Math.abs(width - fittedWidth) < .5) return;
  fittedWidth = width;
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    fitMushafLines();
    if (phase === 'recording') followWord();
  });
}).observe(document.querySelector('main'));
function changeFontSize(delta) {
  wordInfo.hide();
  fontSize = Math.max(24, Math.min(56, fontSize + delta));
  try { localStorage.setItem('hafizassist-font-size', String(fontSize)); } catch {}
  fitMushafLines();
  if (phase === 'recording') followWord(true);
}
$('font-smaller').addEventListener('click', () => changeFontSize(-2));
$('font-larger').addEventListener('click', () => changeFontSize(2));
function fontLayoutReady() {
  fitMushafLines();
  if (cursor > 0 || phase === 'recording') followWord(true);
}
document.fonts.ready.then(fontLayoutReady);
document.fonts.addEventListener('loadingdone', fontLayoutReady);
function resetSession() {
  teacherRetry.clear();
  teacher.cancel({ reset: true });
  madd.clear();
  pageBoundary = null;
  wordInfo.hide(); reviewDetails = []; completedMatched = 0; completedReview = 0; completedPages = 0; firstPracticePage = currentPage;
  alignmentAnchor = null;
  debug.log('reset', { page: currentPage });
  lastRecognitionAt = 0; lastAdvanceAt = 0; lastTranscript = ''; audioDiagnostic = {};
  states = new Array(words.length); committed = [...states]; cursor = 0; segmentStart = 0;
  segmentCarry = '';
  elapsed = 0; startedAt = 0; savedThisRun = false; lastFollowedAyah = null;
  $('time').textContent = '00:00'; paint();
  status('Choose a passage, then start when you’re ready.');
  notifyAccountProgress({ meaningful: true });
}
function focusVerse(key) {
  pageBoundary = null;
  alignmentAnchor = null;
  const index = words.findIndex(w => `${w.surah}:${w.ayah}` === key);
  if (index < 0) return;
  cursor = index; segmentStart = index; paint();
  debug.log('verse-selected', { key, expected: debugWord(index) });
  followWord(true);
  status(words[index].bismillah ? 'Begin with Bismillah, then continue into the surah.' : `Ready from ayah ${key}.`);
}

function openPage(page, targetKey) {
  if (locked()) return;
  if (!Number.isInteger(page) || page < 1 || page > 604) { status('Enter a page number from 1 to 604.', true); return; }
  const firstVerse = chapters.flatMap(c => c.verses).find(v => targetKey ? verseKey(v) === targetKey : layouts[verseKey(v)][1].some(([p]) => p === page));
  chapter = chapters.find(c => c.id === firstVerse.surah);
  $('surah').value = String(chapter.id);
  currentPage = page; renderPassage();
  if (targetKey) focusVerse(targetKey);
  else followWord(true);
  notifyAccountProgress({ meaningful: true });
}
const searchName = value => value.normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0670ـ]/g, '').replace(/[أإآٱ]/g, 'ا').toLowerCase().replace(/[^\p{L}\p{N}:]/gu, '');
function searchPassage(event) {
  event.preventDefault();
  const query = $('search').value;
  if (interruptControls) { void runControlAction(() => searchForPassage(query)); return; }
  searchForPassage(query);
}
function searchForPassage(query) {
  if (locked() || !chapter) return;
  const value = query.trim()
    .replace(/[٠-٩]/g, digit => '٠١٢٣٤٥٦٧٨٩'.indexOf(digit))
    .replace(/[۰-۹]/g, digit => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit));
  if (/^\d+$/.test(value)) { openPage(Number(value)); return; }
  const key = value.match(/^(\d+)\s*:\s*(\d+)$/);
  const surah = value.match(/^[sس]\s*:?\s*(\d+)$/i);
  if (key) {
    const normalized = `${Number(key[1])}:${Number(key[2])}`;
    if (layouts[normalized]) { openPage(layouts[normalized][1][0][0], normalized); return; }
  } else {
    const query = searchName(value);
    const found = surah ? chapters.find(c => c.id === Number(surah[1]))
      : ['yasin', 'yaseen', 'يس'].includes(query) ? chapters.find(c => c.id === 36)
      : chapters.find(c => searchName(c.en) === query || searchName(c.ar) === query)
        || (query.length > 1 && chapters.find(c => searchName(c.en).includes(query) || searchName(c.ar).includes(query)));
    if (found) { openPage(layouts[`${found.id}:1`][1][0][0], `${found.id}:1`); return; }
  }
  status('Try a page (7), chapter (S:2), verse (2:255), or surah name (Baqarah).', true);
}

function renderHistory() {
  const list = $('history-list');
  if (!list) return;
  list.replaceChildren();
  if (!history.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Your completed practice sessions will appear here.'; list.append(p); return; }
  for (const item of history.slice(0, 8)) {
    const row = document.createElement('div'); row.className = 'history-item';
    const name = document.createElement('div'); name.textContent = item.passage || `${item.surah} · ${item.from}–${item.to}`;
    const detail = document.createElement('span'); detail.textContent = `${item.matched} matched · ${formatTime(item.seconds)} · ${new Date(item.date).toLocaleDateString()}`;
    row.append(name, detail); list.append(row);
  }
}
function saveSession() {
  if (savedThisRun || elapsed < 1) return;
  savedThisRun = true;
  const entry = { surah: chapter.en, from: words[0]?.ayah, to: words.at(-1)?.ayah, matched: completedMatched + states.filter(s => s === 'matched').length, review: completedReview + states.filter(s => s === 'review').length, seconds: elapsed, date: new Date().toISOString() };
  entry.passage = completedPages ? `Pages ${firstPracticePage} → ${currentPage} · ${completedPages} completed` : $('passage-label').dataset.passage;
  history.unshift(entry); history = history.slice(0, 30);
  try { localStorage.setItem('hafizassist-history', JSON.stringify(history)); } catch { status('Session finished. Browser storage is unavailable, so history cannot be saved.'); }
  renderHistory();
}

function createWorker() {
  const workerUrl = new URL('../recognizer-worker.js', import.meta.url);
  // Identify this loaded app, not a separately fetched server version. This
  // also avoids reusing an HTTP-cached pre-timing worker on local reloads.
  workerUrl.searchParams.set('app', document.querySelector('.app-version').textContent.trim());
  worker = new Worker(workerUrl);
  worker.onerror = () => failEngine('The speech worker could not start. Reload the page using localhost or HTTPS.');
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { status(data.message); $('download').value = data.value; return; }
    if (data.type === 'ready') {
      debug.log('engine-ready');
      clearTimeout(workerTimer); engineReady = true; $('download').hidden = true; $('model-picker').hidden = true;
      engineResolve?.(); engineResolve = null;
      void refreshOfflineStatus(); return;
    }
    if (data.type === 'error') {
      clearTimeout(workerTimer);
      void failEngine(data.message);
      return;
    }
    if (data.sessionId !== sessionId) return;
    if (data.type === 'started') {
      // Restarting the mic after an interrupted correction supplies fresh
      // audio too. A Teacher gate releases its own hold when the job settles.
      if (!teacherGate) teacherRetry.activate(currentPage);
      startResolve?.(); startResolve = null;
    }
    if (data.type === 'ack') {
      pendingChunks = Math.max(0, pendingChunks - 1);
      if (!pendingChunks) { teacherDrainResolve?.(); teacherDrainResolve = null; }
      audioDiagnostic = { processMs: data.processMs, audioMs: data.audioMs, rms: data.rms, peak: data.peak,
        receivedAt: Date.now(), maxProcessMs: Math.max(audioDiagnostic.maxProcessMs || 0, data.processMs || 0),
        maxPendingChunks: Math.max(audioDiagnostic.maxPendingChunks || 0, pendingChunks) };
      if (Date.now() - lastAudioLogAt >= 1000) {
        lastAudioLogAt = Date.now();
        debug.log('audio', { ...audioDiagnostic, pendingChunks,
          sinceRecognitionMs: lastRecognitionAt ? Date.now() - lastRecognitionAt : null,
          sinceAdvanceMs: lastAdvanceAt ? Date.now() - lastAdvanceAt : null });
      }
    }
    if (data.type === 'result' && (!teacherGate || teacherDraining) && ['recording', 'stopping'].includes(phase)) {
      if (voiceSearch) {
        if (data.final) voiceText = (voiceText + data.text).slice(-2000);
        if (!data.final) lastTranscript = data.text;
        else lastTranscript = '';
        const text = voiceSearchText();
        if (text !== voiceObservedText) {
          voiceObservedText = text; voiceRevision++;
          voiceActivity.noteRecognition();
          scheduleLiveVoiceSearch();
        }
      } else {
        const recognized = normalize(data.text);
        const freshSounds = recognized.length > teacherTranscript.length && recognized.startsWith(teacherTranscript);
        if (!teacherGate && !data.final && !data.settled && freshSounds && data.quietMs < 640)
          teacherActivity.noteRecognition();
        teacherTranscript = data.final ? '' : recognized;
        handleRecognition(data);
      }
    }
    if (data.type === 'finished') { finishResolve?.(); finishResolve = null; }
  };
}
function commitRecognitionResult(result, data) {
  const saved = teacherRetryEnabled ? preserveReview(states[result.index], reviewDetails[result.index], result) : result;
  states[result.index] = saved.state; reviewDetails[result.index] = saved.detail;
  if (tajweedLog && result.detail?.vowelChanges?.length) tajweedLog.record({ kind: 'vowel',
    page: currentPage, index: result.index, sessionId: data.sessionId, segment: data.timingSegment,
    word: words[result.index].accessible, surah: words[result.index].surah, ayah: words[result.index].ayah,
    status: 'review', reason: result.detail.reason, expectedPhoneme: words[result.index].phoneme,
    recognizedPhoneme: result.detail.heard, changes: result.detail.vowelChanges });
}

function handleRecognition(data) {
  if (teacherRetry.pending?.awaitingReference) {
    // Keep processing worker acknowledgements outside this handler so the
    // capture barrier can drain. These queued hypotheses cannot pass the error.
    debug.log('teacher-hold-recognition', { sessionId, page: currentPage, cursor });
    return;
  }
  while (true) {

      lastRecognitionAt = Date.now(); lastTranscript = data.text.slice(-6000);
      const cursorBefore = cursor, segmentBefore = segmentStart, carryBefore = segmentCarry;
      const matchingBegan = performance.now();
      const heard = normalize(segmentCarry + data.text);
      const hadAnchor = alignmentAnchor !== null;
      const textBoundary = alignmentAnchor?.cursor === cursor ? locateTranscriptBoundary(alignmentAnchor, heard) : null;
      const audioBoundary = textBoundary === null && alignmentAnchor?.cursor === cursor
        ? locateRecognitionBoundary(alignmentAnchor.audio, data, segmentCarry) : null;
      const boundary = textBoundary ?? audioBoundary;
      const pageOffset = pageBoundary ? locateTranscriptBoundary(pageBoundary, heard)
        ?? locateRecognitionBoundary(pageBoundary.audio, data, segmentCarry) : null;
      if (pageBoundary && pageOffset === null && boundary === null) {
        debug.log('page-boundary-revised', { page: currentPage, final: data.final });
        // Never search an earlier page's audio as if it belongs to the new page.
        if (data.final) { pageBoundary = null; alignmentAnchor = null; segmentStart = cursor; segmentCarry = ''; }
        return;
      }
      if (hadAnchor && boundary === null) {
        // Without either a text or audio boundary, replaying the old segment
        // can trap tracking on a previously completed word. Await fresh audio.
        debug.log('consumed-boundary-unavailable', { page: currentPage, final: data.final, expected: debugWord(cursor) });
        if (data.final) { pageBoundary = null; alignmentAnchor = null; segmentStart = cursor; segmentCarry = ''; }
        return;
      }
      const inputOffset = boundary ?? pageOffset ?? 0;
      const inputStart = boundary === null ? segmentStart : cursor;
      const recoveryEnabled = Date.now() - lastAdvanceAt >= 1800 && heard.length - inputOffset >= 8;
      const retryTarget = teacherRetry.pending;
      const retryMatch = retryTarget?.page === currentPage
        ? teacherRetry.align(words, heard.slice(inputOffset), 'balanced', data.final,
          document.documentElement.dataset.vowelReview === 'experimental',
          { settled: data.settled === true, postVowels: tajweedReviewEnabled }) : null;
      const match = retryMatch || alignSegment(words, inputStart, heard.slice(inputOffset), 'balanced', data.final,
        document.documentElement.dataset.vowelReview === 'experimental',
        { settled: data.settled === true, recover: recoveryEnabled, postVowels: tajweedReviewEnabled });
      const matchingMs = performance.now() - matchingBegan;
      const firstReview = teacherRetryEnabled && teacher.enabled && phase === 'recording' && match.cursor >= cursor
        ? match.results.find(result => result.index >= cursorBefore && result.state === 'review') : null;
      if (firstReview) {
        const retained = match.results.filter(result => result.index >= cursorBefore && result.index <= firstReview.index)
          .map(result => {
            if (result.index !== firstReview.index || !result.detail?.recoveryWord) return result;
            const { recoveryWord, ...detail } = result.detail;
            return { ...result, detail: { ...detail, reason: 'No confident phoneme match. Teacher is helping with this word.' } };
          });
        // Do not commit this hypothesis's later words or retain its transcript
        // tail. Recognition restarts at the error for the learner's own retry.
        for (const result of retained) commitRecognitionResult(result, data);
        teacherRetry.begin(words, words[firstReview.index], currentPage, firstReview.index + 1, { awaitingReference: true });
        cursor = firstReview.index; segmentStart = cursor; committed = [...states]; segmentCarry = '';
        alignmentAnchor = null; pageBoundary = null; savedThisRun = false;
        if (cursor > cursorBefore) lastAdvanceAt = Date.now();
        if (maddEnabled) {
          const prefix = match.diagnostic.alignments.filter(item => item.index + item.merged <= firstReview.index + 1);
          madd.observe(data, words, prefix, inputOffset, carryBefore, currentPage,
            { ...match.diagnostic, alignments: prefix, blockedIndex: cursor, reason: 'teacher-correction-hold' });
        }
        teacher.observe(retained.map(result => ({ ...result, word: teacherWord(words[result.index]) })), currentPage);
        debug.log('teacher-error-hold', { sessionId, page: currentPage, cursorBefore, cursorAfter: cursor,
          discardedAfter: firstReview.index, candidateCursor: match.cursor });
        paint();
        return;
      }
      if (maddEnabled) madd.observe(data, words, match.diagnostic.alignments, inputOffset, segmentCarry, currentPage, match.diagnostic);
      // CTC can revise an earlier part of its cumulative hypothesis. Once a
      // word has advanced the visible cursor, that revision must not rewind
      // the reading position or erase completed highlights.
      const caughtUp = match.cursor >= cursor;
      const retryResult = retryMatch ? teacherRetry.accept(match.results[0], currentPage, cursor) : null;
      if (retryResult?.accepted) teacher.completeRetry?.(teacherWord(words[retryResult.target.index]), currentPage);
      if (caughtUp) {
        for (const result of match.results) {
          if (result.index >= cursor) {
            commitRecognitionResult(result, data);
          }
        }
        cursor = retryResult?.nextCursor ?? match.cursor;
      }
      if (cursor > cursorBefore || retryMatch && match.consumed > 0) {
        if (cursor > cursorBefore) lastAdvanceAt = Date.now();
        alignmentAnchor = { heard, offset: inputOffset + match.consumed, cursor,
          audio: captureRecognitionBoundary(data, inputOffset + match.consumed, segmentCarry) };
      }
      if (caughtUp && phase === 'recording') teacher.observe(match.results.filter(result => result.index >= cursorBefore)
        .map(result => ({ ...result, word: teacherWord(words[result.index]) })), currentPage);
      debug.log('recognition', {
        sessionId, final: data.final, transcript: lastTranscript, transcriptLength: data.text.length,
        normalizedTranscript: heard.slice(-6000), carryBefore, segmentBefore,
        inputStart, inputOffset, boundaryReused: boundary !== null,
        boundarySource: textBoundary !== null ? 'text' : audioBoundary !== null ? 'token-time' : 'segment-start',
        settled: data.settled === true, stableForMs: data.stableForMs, quietMs: data.quietMs, recoveryEnabled,
        anchorFallback: hadAnchor && boundary === null,
        cursorBefore, candidateCursor: match.cursor, cursorAfter: cursor,
        noRewindGuardHeld: !caughtUp, matchingMs, consumed: match.consumed,
        changes: match.results.slice(-40), expected: debugWord(cursor), candidateBlockedWord: debugWord(match.cursor),
        sinceAdvanceMs: lastAdvanceAt ? Date.now() - lastAdvanceAt : null,
        diagnostic: match.diagnostic,
      });
      if (cursor >= words.length && phase === 'recording' && !teacherRetry.pending &&
          !(teacherRetryEnabled && teacher.correctionPending)) {
        const nextOffset = inputOffset + match.consumed;
        completedMatched += states.filter(s => s === 'matched').length;
        completedReview += states.filter(s => s === 'review').length;
        completedPages++;
        debug.log('auto-page-turn', { from: currentPage, to: currentPage === 604 ? 1 : currentPage + 1, nextOffset });
        currentPage = currentPage === 604 ? 1 : currentPage + 1;
        teacher.continuePage(currentPage);
        renderPassage(true);
        // Keep the same audio stream and cumulative transcript. Reuse any
        // already-decoded words beyond this page immediately, even on a final result.
        const audioBoundary = captureRecognitionBoundary(data, nextOffset, segmentCarry);
        alignmentAnchor = { heard, offset: nextOffset, cursor: 0, audio: audioBoundary };
        pageBoundary = { heard, offset: nextOffset, audio: audioBoundary };
        status(`Listening · continued to page ${currentPage}.`);
        continue;
      }
      // A correct retry can leave newly spoken words in the same result.
      // Continue at the saved frontier, without replaying completed audio.
      if (retryResult?.accepted && match.heard.length > match.consumed && cursor < words.length) {
        paint();
        continue;
      }
      if (data.final) {
        pageBoundary = null;
        committed = [...states]; segmentStart = cursor;
        // Carry only audio aligned at the current frontier. A regressed final
        // hypothesis contains old verse audio, not a new unfinished word.
        segmentCarry = caughtUp ? match.heard.slice(match.consumed).slice(-192) : '';
        alignmentAnchor = null;
      }
      paint();
      break;
    
  }
}

function loadEngine(file) {
  if (!worker) createWorker();
  phase = 'loading'; $('download').hidden = false; $('download').value = 0; $('model-picker').hidden = true; controls();
  return new Promise((resolve, reject) => {
    engineResolve = error => error ? reject(error) : resolve();
    workerTimer = setTimeout(() => failEngine('Model loading timed out. Try again or reload the page.'), 180000);
    worker.postMessage({ type: 'init', file });
  });
}

async function releaseAudio() {
  teacher.cancel();
  teacherDrainResolve?.(new DOMException('Microphone closed.', 'AbortError')); teacherDrainResolve = null;
  for (const resolve of captureActions.values()) resolve(new DOMException('Microphone closed.', 'AbortError'));
  captureActions.clear();
  cancelAnimationFrame(animation);
  media?.getTracks().forEach(track => track.stop()); media = null;
  if (capture) capture.port.onmessage = null;
  capture?.disconnect(); source?.disconnect(); mute?.disconnect(); analyser?.disconnect();
  capture = null; source = null; mute = null; analyser = null;
  if (context && context.state !== 'closed') await context.close().catch(() => {});
  context = null;
  $('record').style.removeProperty('--voice-glow');
}
async function failEngine(message) {
  teacher.cancel(); teacherGate = false; teacherDraining = false;
  if (voiceSearch) resetVoiceQueries();
  const interrupted = phase === 'recording' || phase === 'stopping';
  debug.log('engine-error', { message, snapshot: debugSnapshot() });
  phase = 'stopping'; controls();
  clearTimeout(workerTimer); worker?.terminate(); worker = null; engineReady = false;
  if (startedAt) { elapsed += (Date.now() - startedAt) / 1000; startedAt = 0; }
  startResolve?.(new Error(message)); startResolve = null;
  finishResolve?.(new Error(message)); finishResolve = null;
  flushResolve?.(); flushResolve = null;
  await releaseAudio();
  if (interrupted) showMicNotice(message);
  engineResolve?.(new Error(message)); engineResolve = null;
  phase = 'idle'; $('download').hidden = true; $('model-picker').hidden = false;
  status(message, true); controls();
}

function animateLevel() {
  if (!analyser) return;
  const samples = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(samples);
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value - 128) / 128);
  // The analyser drives only the mic animation. Scheduling uses sustained
  // floating-point PCM activity, not isolated peaks or byte-level noise.
  $('record').style.setProperty('--voice-glow', `${5 + Math.min(15, peak * 60)}px`);
  animation = requestAnimationFrame(animateLevel);
}

async function startRecording(file, preparedContext) {
  if (phase !== 'idle' || stopPromise || teacher.busy || pendingControlActions || swipeTurnPending) {
    void preparedContext?.close().catch(() => {});
    return;
  }
  teacher.cancel({ reset: true }); teacherGate = false; teacherDraining = false;
  if (!voiceSearch) teacher.unlock();
  hideMicNotice();
  debug.log('start-request', { page: currentPage, cursor, engineReady });
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    void preparedContext?.close().catch(() => {});
    status('This browser does not support microphone tracking. Use a recent Chrome, Edge, Firefox, or Safari on HTTPS.', true); return;
  }
  if (!voiceSearch && cursor >= words.length) resetSession();
  phase = 'starting'; controls(); status('Allow microphone access to begin.');
  let micTimer, calibrationTimer, calibrationResolve;
  try {
    context = preparedContext || new AudioContext();
    await context.resume();
    // Resume from the original click, then await initialization in this same flow.
    if (!engineReady) await loadEngine(file);
    phase = 'starting'; controls(); status('Allow microphone access to begin.');
    const request = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    let abandoned = false;
    request.then(value => { if (abandoned) value.getTracks().forEach(track => track.stop()); }, () => {});
    try {
      media = await Promise.race([request, new Promise((_, reject) => { micTimer = setTimeout(() => { abandoned = true; reject(new Error('Microphone permission timed out. Allow access, then try again.')); }, 45000); })]);
    } finally { clearTimeout(micTimer); }
    const settings = media.getAudioTracks()[0].getSettings();
    micSettings = { sampleRate: settings.sampleRate, channelCount: settings.channelCount,
      echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl, contextSampleRate: context.sampleRate };
    await context.audioWorklet.addModule(new URL('../audio-worklet.js', import.meta.url));
    capture = new AudioWorkletNode(context, 'recitation-capture');
    source = context.createMediaStreamSource(media); analyser = context.createAnalyser(); analyser.fftSize = 512;
    mute = context.createGain(); mute.gain.value = 0;
    sessionId++; pendingChunks = 0; segmentStart = cursor; committed = [...states]; segmentCarry = '';
    pageBoundary = null;
    alignmentAnchor = null;
    lastRecognitionAt = 0; lastTranscript = ''; teacherTranscript = ''; lastAdvanceAt = Date.now(); teacherActivity.reset(); lastAudioLogAt = 0; audioDiagnostic = {};
    debug.log('session-start', { sessionId, expected: debugWord(cursor), micSettings });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { startResolve = null; reject(new Error('The speech engine did not start. Please retry.')); }, 15000);
      startResolve = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      worker.postMessage({ type: 'start', sessionId, maddTiming: maddEnabled && !voiceSearch });
    });
    let calibrationReady;
    if (!voiceSearch && teacher.enabled) {
      status('Keep quiet for a moment while the microphone adjusts to background sound.');
      calibrationReady = new Promise((resolve, reject) => {
        calibrationResolve = resolve;
        calibrationTimer = setTimeout(() => reject(new Error('The microphone is not providing audio. Start the microphone again.')), 6000);
      });
    }
    capture.port.onmessage = ({ data }) => {
      if (data.controlled) { captureActions.get(data.id)?.(); captureActions.delete(data.id); return; }
      if (data.flushed) { flushResolve?.(); flushResolve = null; return; }
      if (calibrationResolve && phase === 'starting' && data.samples) {
        // The mic is not recording yet. Learn room noise from these startup frames
        // without submitting them to recognition or changing practice counts.
        if (teacherActivity.calibrate(data.samples)) { calibrationResolve(); calibrationResolve = null; }
        return;
      }
      if (teacherGate || !data.samples || !worker || !['recording', 'stopping'].includes(phase)) return;
      if (voiceSearch) voiceActivity.observe(data.samples);
      else teacherActivity.observe(data.samples);
      pendingChunks++;
      if (pendingChunks > 30) { failEngine('This device is processing audio too slowly. Close other tabs, then try a shorter passage.'); return; }
      worker.postMessage({ type: 'audio', samples: data.samples, sessionId }, [data.samples.buffer]);
    };
    media.getAudioTracks()[0].onended = () => {
      if (phase === 'recording') void stopRecording('Your browser or device ended microphone access. Start the microphone again when you’re ready.');
    };
    source.connect(analyser); source.connect(capture); capture.connect(mute); mute.connect(context.destination);
    if (calibrationReady) {
      await calibrationReady;
      clearTimeout(calibrationTimer);
      teacherActivity.reset(Date.now(), { preserveNoise: true });
    }
    phase = 'recording';
    if (voiceSearch) { voiceBeganAt = Date.now(); voiceActivity.reset(voiceBeganAt); }
    else { startedAt = Date.now(); savedThisRun = false; }
    controls(); animateLevel();
    status(voiceSearch ? 'Listening. Recite a few distinctive words; matching verses will appear automatically.' : 'Listening. Recite the highlighted passage at your own pace.');
    alignMobileReadingStart();
  } catch (error) {
    debug.log('start-error', { name: error.name, message: error.message });
    await releaseAudio(); phase = 'idle'; controls();
    const messages = { NotAllowedError: 'Microphone access was denied. Allow it in your browser’s site settings, then try again.', NotFoundError: 'No microphone was found. Connect one, then try again.', NotReadableError: 'The microphone is busy or unavailable. Close other apps using it, then retry.' };
    status(messages[error.name] || error.message, true);
  } finally {
    clearTimeout(calibrationTimer); calibrationResolve = null;
  }
}

async function stopRecording(reason = '', { search = true } = {}) {
  if (stopPromise) return stopPromise;
  if (phase !== 'recording') return;
  debug.log('stop-request', { reason: reason || 'user', snapshot: debugSnapshot() });
  phase = 'stopping'; controls();
  teacher.cancel();
  if (!voiceSearch) { elapsed += (Date.now() - startedAt) / 1000; startedAt = 0; }
  stopPromise = (async () => {
    try {
      if (capture) await new Promise(resolve => {
        const timer = setTimeout(resolve, 1500);
        flushResolve = () => { clearTimeout(timer); resolve(); };
        capture.port.postMessage('flush');
      });
      await releaseAudio();
      if (reason) showMicNotice(reason);
      if (worker) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { finishResolve = null; reject(new Error('Finishing recognition timed out. Your microphone is off. Please reload.')); }, 20000);
        finishResolve = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
        worker.postMessage({ type: 'finish', sessionId });
      });
      phase = 'idle'; controls();
      if (voiceSearch) {
        if (search && !voiceClosing && !voiceNavigating) findVoiceVerse({ final: true });
      } else {
        status(cursor >= words.length ? 'You reached the end of your passage. Take a moment to revisit any highlighted words.' : 'Session paused. Start again to continue, or select a word to revisit it.');
        saveSession(); void accountClient?.flush();
      }
    } catch (error) { await failEngine(error.message); }
    finally { stopPromise = null; controls(); }
  })();
  return stopPromise;
}

function voiceSearchText() { return (voiceText + lastTranscript).trim(); }
function resetVoiceQueries() {
  searchRequest++;
  clearTimeout(searchTimer); clearTimeout(voiceLiveTimer); voiceLiveTimer = null;
  voiceQuery = null; voiceLiveQueued = false; voiceLastQuery = '';
  voiceCandidate = null; voiceRevision = 0; voiceObservedText = '';
}
function scheduleLiveVoiceSearch() {
  if (!voiceSearch || phase !== 'recording' || voiceClosing || voiceNavigating || voiceLiveTimer) return;
  voiceLiveTimer = setTimeout(() => {
    voiceLiveTimer = null;
    if (voiceSearch && phase === 'recording' && !voiceClosing && !voiceNavigating) findVoiceVerse();
  }, 650);
}
async function voiceSearchFailed(message, epoch = voiceEpoch) {
  if (!voiceSearch || epoch !== voiceEpoch) return;
  resetVoiceQueries();
  searchWorker?.terminate(); searchWorker = null;
  await stopRecording('', { search: false });
  if (voiceSearch && epoch === voiceEpoch && !voiceClosing) status(message, true);
}
function renderVoiceResults(results, epoch) {
  $('voice-results').replaceChildren();
  for (const result of results) {
    const [surah, ayah] = result.key.split(':').map(Number);
    const ch = chapters.find(c => c.id === surah), verse = ch?.verses.find(v => v.ayah === ayah);
    if (!verse) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'voice-result';
    const label = document.createElement('span'); label.textContent = `${result.key} · ${ch.en} — ${ch.ar}`;
    const text = document.createElement('span'); text.lang = 'ar'; text.dir = 'rtl'; text.textContent = verse.aya_text;
    button.append(label, text);
    button.onclick = () => { if (epoch === voiceEpoch) void openVoiceResult(result); };
    $('voice-results').append(button);
  }
}
function receiveVoiceMatches(data) {
  const query = voiceQuery;
  if (!voiceSearch || !query || query.epoch !== voiceEpoch || data.id !== query.id || data.id !== searchRequest || voiceClosing || voiceNavigating) return;
  clearTimeout(searchTimer); voiceQuery = null;
  if (data.error) { void voiceSearchFailed(data.error, query.epoch); return; }
  // A partial can be revised while the search worker is busy. Only the
  // currently heard phrase may trigger navigation or replace the result list.
  if (!query.final && (phase !== 'recording' || query.text !== voiceSearchText())) {
    if (phase === 'recording') scheduleLiveVoiceSearch();
    return;
  }
  renderVoiceResults(data.results, query.epoch);
  if (!data.results.length) {
    voiceCandidate = null;
    if (query.final) status(data.short ? 'Recite a longer phrase so we can locate the verse.' : 'No close match found. Try a longer, distinctive passage.', true);
  } else if (data.autoOpenEligible) {
    if (query.final) { void openVoiceResult(data.results[0]); return; }
    const key = data.results[0].key;
    if (voiceCandidate?.key !== key) voiceCandidate = { key, at: Date.now(), revision: query.revision, observations: 1 };
    else if (voiceCandidate.revision !== query.revision) {
      voiceCandidate.revision = query.revision; voiceCandidate.observations++;
    }
    if (voiceCandidate.observations >= 2 && Date.now() - voiceCandidate.at >= 650) {
      // Stop first, then search again using the drained final ASR text.
      // An early unique hypothesis never navigates directly.
      void stopRecording();
      return;
    }
  } else voiceCandidate = null;
  if (data.results.length) status(data.results.length > 1
    ? 'Select your verse. Similar passages appear in several places.'
    : query.final ? 'Select your verse. Similar passages may appear in several places.'
    : 'Listening. Recite a few distinctive words; matching verses will appear automatically.');
  if (voiceLiveQueued) { voiceLiveQueued = false; scheduleLiveVoiceSearch(); }
}
function findVoiceVerse({ final = false } = {}) {
  if (!voiceSearch || voiceClosing || voiceNavigating || (!final && phase !== 'recording')) return;
  if (final) {
    // Invalidate an in-flight partial even if final ASR contains no text.
    searchRequest++; voiceQuery = null;
    clearTimeout(searchTimer); clearTimeout(voiceLiveTimer); voiceLiveTimer = null; voiceLiveQueued = false;
    $('voice-results').replaceChildren();
  }
  const text = voiceSearchText();
  if (!text) { if (final) status('No speech recognized. Try again and recite several words.', true); return; }
  if (!final && voiceQuery) { voiceLiveQueued = true; return; }
  if (!final && text === voiceLastQuery) return;
  if (!searchWorker) {
    try {
      searchWorker = new Worker(new URL('./voice-search-worker.js', import.meta.url), { type: 'module' });
      const activeWorker = searchWorker;
      searchWorker.onmessage = ({ data }) => { if (searchWorker === activeWorker) receiveVoiceMatches(data); };
      searchWorker.onerror = () => { if (searchWorker === activeWorker) void voiceSearchFailed('Voice search could not load. Please try again.'); };
      searchWorker.postMessage({ type: 'init', verses: chapters.flatMap(c => c.verses).map(v => ({ key: verseKey(v), phonemes: v.aya_phonemes_list })) });
    } catch { void voiceSearchFailed('Voice search could not load. Please try again.'); return; }
  }
  if (final) {
    status('Checking matching verses…');
  }
  voiceLastQuery = text;
  const id = ++searchRequest, epoch = voiceEpoch;
  voiceQuery = { id, epoch, text, final, revision: voiceRevision };
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (id === searchRequest && epoch === voiceEpoch) void voiceSearchFailed('Search took too long. Please try a shorter phrase.', epoch);
  }, 30000);
  searchWorker.postMessage({ type: 'search', id, text });
}
async function openVoiceResult(result) {
  if (!voiceSearch || voiceClosing || voiceNavigating || !layouts[result.key]) return;
  const epoch = voiceEpoch;
  voiceNavigating = true; resetVoiceQueries(); controls();
  try {
    // Tapping any candidate also stops and drains capture before changing the
    // Quran page. No voice-search result is fed into practice word tracking.
    await stopRecording('', { search: false });
    if (!voiceSearch || epoch !== voiceEpoch || voiceClosing || phase !== 'idle') return;
    voiceSearch = false; voiceEpoch++; $('voice-dialog').close();
    const page = layouts[result.key][1][result.word]?.[0] || layouts[result.key][1][0][0];
    openPage(page, result.key);
    const index = words.findIndex(w => !w.bismillah && `${w.surah}:${w.ayah}` === result.key && w.position === result.word);
    if (index >= 0) { cursor = index; segmentStart = index; paint(); followWord(true); }
    status(`Found ayah ${result.key}. Start reciting to continue from the highlighted word.`);
  } finally { voiceNavigating = false; controls(); }
}
async function startVoiceSearchAttempt() {
  if (!voiceSearch || phase !== 'idle' || stopPromise || voiceClosing || voiceNavigating) return;
  resetVoiceQueries(); voiceText = ''; lastTranscript = ''; $('voice-results').replaceChildren();
  const prepared = voiceStartupContext; voiceStartupContext = null;
  await startRecording(undefined, prepared);
}
$('voice-open').addEventListener('click', () => { void openVoiceSearch(); });
async function openVoiceSearch() {
  if (voiceOpening || voiceSearch) return;
  voiceOpening = true;
  try {
    await runControlAction(() => {
      if (locked()) return;
      teacher.cancel();
      voiceSearch = true; voiceEpoch++; voiceClosing = false; voiceNavigating = false;
      $('voice-dialog').showModal(); controls();
    });
    await startVoiceSearchAttempt();
  } finally {
    voiceOpening = false;
    if (voiceStartupContext) { void voiceStartupContext.close().catch(() => {}); voiceStartupContext = null; }
    controls();
  }
}
$('voice-record').addEventListener('click', async () => {
  if (!voiceSearch) return;
  if (phase === 'recording') { await stopRecording(); return; }
  await startVoiceSearchAttempt();
});
async function closeVoiceSearch() {
  if (['loading', 'starting'].includes(phase) || voiceClosing) return;
  voiceClosing = true; resetVoiceQueries(); controls();
  try {
    await stopRecording('', { search: false });
    voiceSearch = false; voiceEpoch++; $('voice-dialog').close();
    status('Voice search closed. Your practice position is unchanged.');
  } finally { voiceClosing = false; controls(); }
}
setInterval(() => {
  if (!voiceSearch || phase !== 'recording' || voiceClosing || voiceNavigating || document.hidden) return;
  const now = Date.now();
  // Use fresh microphone activity, including held vowels, rather than the
  // arrival time of delayed ASR results to decide the reader has finished.
  if (voiceSearchText() && voiceActivity.captureAt && now - voiceActivity.captureAt < 1500 && now - voiceActivity.speechAt >= VOICE_PAUSE_MS) void stopRecording();
  else if (!voiceSearchText() && now - voiceBeganAt >= 30000) void stopRecording();
}, 200);
$('voice-close').addEventListener('click', closeVoiceSearch);
$('voice-dialog').addEventListener('cancel', event => { event.preventDefault(); void closeVoiceSearch(); });

$('record').addEventListener('click', () => phase === 'recording' ? void stopRecording() : void startRecording());
$('model-file').addEventListener('change', event => { const file = event.target.files[0]; if (file) void startRecording(file); event.target.value = ''; });
$('reset').addEventListener('click', async () => { await stopRecording(); resetSession(); });
$('previous-page').addEventListener('click', () => { const target = currentPage - 1; void runControlAction(() => openPage(target)); });
$('next-page').addEventListener('click', () => { const target = currentPage + 1; void runControlAction(() => openPage(target)); });
if (mobileView) {
  let swipeStartPage;
  const canSwipePage = direction => Boolean(chapter) && (phase === 'idle' || (interruptControls && phase === 'recording')) &&
    !pendingControlActions && !voiceSearch && !document.hidden &&
    !$('voice-dialog').open && !$('book-settings')?.open && !document.body.classList.contains('teacher-panel-open') &&
    currentPage + direction >= 1 && currentPage + direction <= 604;
  const stopSwipes = setupMobilePageSwipe({
    reader: document.querySelector('.reader'),
    canTurn: canSwipePage,
    onSwipeStart() { swipeStartPage = currentPage; wordInfo.hide(); },
    async beforeTurn(direction) {
      if (currentPage !== swipeStartPage || !canSwipePage(direction)) return false;
      if (interruptControls) {
        // This callback runs only after release passes the 70% distance test.
        // A short drag never stops the mic, cancels Teacher, or changes pages.
        swipeTurnPending = true;
        controls();
        await runControlAction(() => {});
      } else teacher.cancel();
      return currentPage === swipeStartPage && canSwipePage(direction);
    },
    turnPage(direction) {
      if (phase !== 'idle' || currentPage !== swipeStartPage || !canSwipePage(direction)) return false;
      const page = currentPage + direction;
      openPage(page);
      return currentPage === page;
    },
    onTurnEnd() { swipeTurnPending = false; controls(); },
  });
  window.addEventListener('pagehide', event => { if (!event.persisted) stopSwipes(); });
}
$('search-form').addEventListener('submit', searchPassage);
$('surah').addEventListener('change', () => {
  const key = `${$('surah').value}:1`;
  void runControlAction(() => { if (!locked() && layouts[key]) openPage(layouts[key][1][0][0], key); });
});
$('visibility').addEventListener('click', () => {
  wordInfo.hide();
  memoryMode = !memoryMode;
  const button = $('visibility');
  button.setAttribute('aria-pressed', String(memoryMode));
  button.title = memoryMode ? 'Show all Quran text' : 'Hide upcoming words';
  button.setAttribute('aria-label', button.title);
  $('eye-open').hidden = memoryMode;
  $('eye-closed').hidden = !memoryMode;
  paint();
});
$('theme').addEventListener('click', () => { const dark = document.body.classList.toggle('dark'); try { localStorage.setItem('hafizassist-theme', dark ? 'dark' : 'light'); } catch {} });
window.addEventListener('pagehide', () => {
  media?.getTracks().forEach(track => track.stop()); worker?.terminate(); void context?.close();
  void voiceStartupContext?.close().catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (phase === 'recording') void stopRecording('Recitation paused because the page was hidden. Start the microphone again to continue.');
  } else if (pendingMicNotice) {
    if (!micNoticeExpiresAt) showMicNotice(pendingMicNotice);
    else if (Date.now() >= micNoticeExpiresAt) hideMicNotice();
  }
});

async function init() {
  try {
    renderHistory();
    const response = await fetch(new URL('../data/quran.json', import.meta.url));
    if (!response.ok) throw new Error('Quran reference data could not be loaded. Reload the page to try again.');
    const data = await response.json();
    const layoutResponse = await fetch(new URL('../data/mushaf-layout.json', import.meta.url));
    if (!layoutResponse.ok) throw new Error('Mushaf page data could not be loaded. Reload the page to try again.');
    layouts = await layoutResponse.json();
    let tajweed = {}, tajweedUnavailable = false;
    try {
      const referenceResponse = await fetch(new URL('../data/tajweed-words.json', import.meta.url));
      if (!referenceResponse.ok) throw new Error('Tajweed reference unavailable');
      tajweed = await referenceResponse.json();
    } catch { tajweedUnavailable = true; }
    const map = new Map();
    for (const [key, verse] of Object.entries(data.verses)) {
      const [surah, ayah] = key.split(':').map(Number);
      if (!map.has(surah)) map.set(surah, { id: surah, en: verse.suraname_en, ar: verse.suraname_ar, verses: [] });
      map.get(surah).verses.push({ ...verse, surah, ayah, wordRules: wordRules(verse, data.rule_names), referenceWords: referenceWords(verse, tajweed[surah]?.[ayah]) });
    }
    chapters = [...map.values()].sort((a, b) => a.id - b.id);
    chapters.forEach(c => c.verses.sort((a, b) => a.ayah - b.ayah));
    $('surah').replaceChildren(...chapters.map(c => new Option(`${c.id}. ${c.en} — \u2067${c.ar}\u2069`, String(c.id))));
    openPage(1);
    if (tajweedUnavailable) status('The full Tajweed reference could not load. Basic annotations are available; reopen while connected to load the full reference.', true);
    cancelAnimationFrame(scrollFrame); // Keep the controls visible on initial load.
  } catch (error) { $('ayahs').textContent = 'Unable to load the Quran passage.'; status(error.message, true); }
}
void init().then(() => {
  accountProgressReady = Boolean(chapter && words.length);
  accountClient = createAccounts({
    capture: captureAccountProgress,
    restore: restoreAccountProgress,
    isBusy: () => !accountProgressReady || locked() || teacher.busy || voiceSearch,
    subscribe(listener) {
      accountProgressListeners.add(listener);
      return () => accountProgressListeners.delete(listener);
    },
  });
  accountClient.changed({ initial: true });
}).catch(error => console.error('Account controls could not load:', error));
// Colour data loads independently so unavailable annotations cannot hold up
// Quran reading. If it arrives later, decorate the currently displayed page.
void tajweedColors.load().then(loaded => {
  if (!loaded) return;
  elements.forEach((button, index) => tajweedColors.decorate(button, words[index]));
  if (elements.length) fitMushafLines();
});
void setupOffline();
