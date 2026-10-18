// Move controls before loading the shared app; all layouts keep shared behavior.
function setupBookLayout() {
  const settings = document.createElement('dialog');
  settings.id = 'book-settings';
  settings.setAttribute('aria-label', 'Search and reading settings');
  settings.innerHTML = '<div class="book-settings-heading"><button type="button" class="icon-button" id="book-close" aria-label="Close reading settings">×</button></div>';
  document.body.append(settings);
  const section = (title, element) => {
    const group = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = title; group.append(heading, element); settings.append(group);
  };
  section('Go to a passage', document.querySelector('.search-surah-row'));
  const recorder = document.querySelector('.recorder-main');
  const record = document.getElementById('record');
  const visibility = document.getElementById('visibility');
  const practiceActions = document.querySelector('.practice-actions');
  practiceActions.insertBefore(document.getElementById('theme'), document.querySelector('.font-controls'));
  document.getElementById('theme').title = 'Switch color theme';
  section('Practice & text size', practiceActions);
  if (document.documentElement.dataset.tajweedReview === 'experimental') {
    const timing = document.createElement('div'); timing.className = 'tajweed-preview-settings';
    const label = document.createElement('label'); label.htmlFor = 'tajweed-speed'; label.textContent = 'Recitation pace';
    const select = document.createElement('select'); select.id = 'tajweed-speed';
    for (const [value, text] of [['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
    }
    select.value = 'normal';
    try {
      const saved = localStorage.getItem('recitealquran-tajweed-speed');
      if (['fast', 'normal', 'slow'].includes(saved)) select.value = saved;
    } catch {}
    select.addEventListener('change', () => {
      try { localStorage.setItem('recitealquran-tajweed-speed', select.value); } catch {}
    });
    const note = document.createElement('p'); note.id = 'tajweed-preview-note'; note.className = 'hint';
    note.textContent = 'Experimental timing estimates appear when you hover over a recited word. Pace changes apply to new estimates.';
    select.setAttribute('aria-describedby', note.id);
    timing.append(label, select, note); section('Tajweed preview', timing);
  }
  const tajweedColoursEnabled = document.documentElement.dataset.tajweedColors === 'preview';
  if (tajweedColoursEnabled) {
    const colours = document.createElement('div'); colours.className = 'tajweed-colour-settings';
    const legend = document.createElement('ul'); legend.className = 'tajweed-colour-legend';
    for (const [group, label] of [['madd', 'Madd'], ['ghunnah', 'Ghunnah'], ['idgham', 'Idgham'], ['ikhfa', 'Ikhfa & Iqlab'], ['qalqalah', 'Qalqalah'], ['silent', 'Silent letters']]) {
      const item = document.createElement('li'); item.dataset.tajweedColour = group;
      const swatch = document.createElement('span'); swatch.className = 'tajweed-colour-swatch'; swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, document.createTextNode(label)); legend.append(item);
    }
    const note = document.createElement('p'); note.className = 'hint';
    note.textContent = 'Use the Tajweed button below Teacher to show or hide colours. Colours are a reading guide; they do not assess your recitation.';
    const status = document.createElement('p'); status.id = 'tajweed-colors-status'; status.className = 'hint';
    status.setAttribute('role', 'status'); status.textContent = 'Preparing Tajweed colours…';
    colours.append(legend, note, status); section('Tajweed colours', colours);
  }
  // Keep audio status available to assistive technology without a settings block.
  const teacherStatus = document.createElement('p');
  teacherStatus.id = 'teacher-status'; teacherStatus.className = 'sr-only';
  teacherStatus.setAttribute('role', 'status');
  document.body.append(teacherStatus);
  const teacherFeedback = document.createElement('aside');
  teacherFeedback.id = 'teacher-feedback'; teacherFeedback.hidden = true;
  teacherFeedback.setAttribute('popover', 'manual');
  teacherFeedback.setAttribute('aria-label', 'Teacher feedback');
  teacherFeedback.setAttribute('aria-live', 'polite');
  teacherFeedback.innerHTML = '<div class="teacher-feedback-heading"><span id="teacher-feedback-label"></span><button id="teacher-dismiss" type="button" class="icon-button" aria-label="Dismiss teacher feedback">×</button></div><p id="teacher-feedback-word" lang="ar" dir="rtl"></p><p id="teacher-feedback-detail"></p><button id="teacher-replay" type="button">Replay word</button>';
  document.body.append(teacherFeedback);
  const session = document.createElement('div');
  session.className = 'book-session';
  session.append(document.querySelector('.recitation-counts'), document.querySelector('.session-inline'));
  section('This recitation', session);
  // Keep Settings for reading controls. Existing local practice data is
  // retained, but its history panel and explanatory footer are not shown.
  for (const selector of ['.history', '.privacy-note', 'main > footer']) {
    document.querySelector(selector)?.remove();
  }
  const control = (id, label, icon) => {
    const button = document.createElement('button');
    button.id = id; button.type = 'button'; button.className = 'icon-button book-control';
    button.setAttribute('aria-label', label); button.title = label; button.innerHTML = icon;
    return button;
  };
  // Original vector miniatures share the account icon's curved emerald tile,
  // lit edges and raised ivory details; no remote images are needed offline.
  const orbSymbol = (key, className, detail) => `<svg class="book-orb-symbol ${className}" width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${key}-back" x1="7" y1="3" x2="43" y2="48" gradientUnits="userSpaceOnUse"><stop stop-color="var(--control-light)"/><stop offset="1" stop-color="var(--control-deep)"/></linearGradient>
      <linearGradient id="${key}-ivory" x1="14" y1="12" x2="34" y2="36" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset="1" stop-color="var(--control-ivory)"/></linearGradient>
    </defs>
    <rect x="4" y="6" width="40" height="39" rx="14" fill="var(--control-edge)"/>
    <rect x="4" y="3" width="40" height="40" rx="14" fill="url(#${key}-back)"/>
    <path d="M8 20v-4a9 9 0 0 1 9-9h12" stroke="#fff" stroke-opacity=".4" stroke-width="1.7" stroke-linecap="round"/>
    ${detail}
  </svg>`;
  const textPageSymbol = hidden => {
    const key = hidden ? 'book-page-hidden' : 'book-page-visible';
    return orbSymbol(key, 'book-visibility-symbol', `
      <path d="M17 11h10l6 6v17a2 2 0 0 1-2 2H17a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2Z" fill="var(--control-edge)" fill-opacity=".4" transform="translate(.7 1.5)"/>
      <path d="M17 11h10l6 6v17a2 2 0 0 1-2 2H17a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2Z" fill="url(#${key}-ivory)"/>
      <path d="M27 11v4a2 2 0 0 0 2 2h4" fill="var(--control-light)" fill-opacity=".4" stroke="var(--control-deep)" stroke-opacity=".25" stroke-width="1" stroke-linejoin="round"/>
      <path d="M17.5 15v17.5" stroke="#fff" stroke-opacity=".8" stroke-width="1" stroke-linecap="round"/>
      ${hidden ? '' : '<path d="M22 20.5h7m-10 4h10m-8 4h8m-10 4h10" stroke="var(--control-deep)" stroke-width="1.6" stroke-linecap="round"/>'}`);
  };
  // Retain the existing state hooks so text hiding and accessibility stay intact.
  document.getElementById('eye-open').innerHTML = textPageSymbol(false);
  document.getElementById('eye-closed').innerHTML = textPageSymbol(true);
  record.innerHTML = `<svg class="book-mic-symbol" width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="book-mic-back" x1="7" y1="3" x2="43" y2="48" gradientUnits="userSpaceOnUse"><stop stop-color="var(--control-light)"/><stop offset="1" stop-color="var(--control-deep)"/></linearGradient>
      <linearGradient id="book-mic-metal" x1="18" y1="11" x2="31" y2="34" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset="1" stop-color="var(--control-ivory)"/></linearGradient>
    </defs>
    <rect x="4" y="6" width="40" height="39" rx="14" fill="var(--control-edge)"/>
    <rect x="4" y="3" width="40" height="40" rx="14" fill="url(#book-mic-back)"/>
    <path d="M8 20v-4a9 9 0 0 1 9-9h12" stroke="#fff" stroke-opacity=".4" stroke-width="1.7" stroke-linecap="round"/>
    <rect x="18.5" y="11.5" width="12" height="20" rx="6" fill="#092e27" fill-opacity=".2"/>
    <path d="M24 30v7m-5 0h10M15.5 22v1a8.5 8.5 0 0 0 17 0v-1" stroke="var(--control-edge)" stroke-opacity=".5" stroke-width="2.8" stroke-linecap="round" transform="translate(0 1)"/>
    <path d="M24 30v7m-5 0h10M15.5 22v1a8.5 8.5 0 0 0 17 0v-1" stroke="url(#book-mic-metal)" stroke-width="2.5" stroke-linecap="round"/>
    <rect x="18" y="10" width="12" height="19" rx="6" fill="url(#book-mic-metal)"/>
    <path d="M21 14.5a3 3 0 0 1 3-2.5" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M20.5 18h7m-7 3h7m-7 3h7" stroke="var(--control-deep)" stroke-opacity=".38" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;
  const teacherSymbol = off => {
    const key = off ? 'book-teacher-off' : 'book-teacher-on';
    return `<svg class="teacher-symbol" width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="${key}-back" x1="7" y1="3" x2="43" y2="48" gradientUnits="userSpaceOnUse"><stop stop-color="var(--control-light)"/><stop offset="1" stop-color="var(--control-deep)"/></linearGradient>
        <linearGradient id="${key}-figure" x1="11" y1="15" x2="28" y2="38" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset="1" stop-color="var(--control-ivory)"/></linearGradient>
        <linearGradient id="${key}-board" x1="27" y1="11" x2="39" y2="29" gradientUnits="userSpaceOnUse"><stop stop-color="var(--control-board)"/><stop offset="1" stop-color="var(--control-deep)"/></linearGradient>
      </defs>
      <rect x="4" y="6" width="40" height="39" rx="14" fill="var(--control-edge)"/>
      <rect x="4" y="3" width="40" height="40" rx="14" fill="url(#${key}-back)"/>
      <path d="M8 20v-4a9 9 0 0 1 9-9h12" stroke="#fff" stroke-opacity=".4" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M32 29v6m-4 0h8" stroke="var(--control-edge)" stroke-width="2" stroke-linecap="round" transform="translate(0 1)"/>
      <path d="M32 28v6m-4 0h8" stroke="var(--control-ivory)" stroke-width="1.8" stroke-linecap="round"/>
      <rect x="24.5" y="11.5" width="15.5" height="18" rx="2.7" fill="var(--control-edge)" fill-opacity=".55"/>
      <rect x="23" y="10" width="16" height="18" rx="2.5" fill="url(#${key}-board)" stroke="var(--control-ivory)" stroke-width="1.5"/>
      <path d="M26 13h6" stroke="#fff" stroke-opacity=".35" stroke-width="1" stroke-linecap="round"/>
      <g fill="var(--control-edge)" fill-opacity=".32" transform="translate(1 1.5)"><circle cx="16" cy="19" r="5.5"/><path d="M8.5 37V30c0-4.7 2.6-7.3 7.5-7.3s7.5 2.6 7.5 7.3v7Z"/></g>
      <circle cx="16" cy="18" r="5.5" fill="url(#${key}-figure)"/>
      <path d="M8.5 36V29c0-4.7 2.6-7.3 7.5-7.3s7.5 2.6 7.5 7.3v7Z" fill="url(#${key}-figure)"/>
      <path d="M12.5 15.5a4 4 0 0 1 4-1.3" stroke="#fff" stroke-opacity=".8" stroke-width="1.1" stroke-linecap="round"/>
      <path d="M11 31v3" stroke="#fff" stroke-opacity=".45" stroke-width="1.1" stroke-linecap="round"/>
      <g class="teacher-pointer"><path d="m20.5 26.5 7-5" stroke="var(--control-edge)" stroke-opacity=".4" stroke-width="4" stroke-linecap="round" transform="translate(0 1)"/><path d="m20.5 26 7-5" stroke="url(#${key}-figure)" stroke-width="3.6" stroke-linecap="round"/><path d="m27 21 7-8" stroke="var(--control-ivory)" stroke-width="1.5" stroke-linecap="round"/></g>
      ${off ? '<path d="M32 23h4" stroke="var(--control-ivory)" stroke-opacity=".8" stroke-width="1.5" stroke-linecap="round"/>' : '<path d="m31 22 1.7 1.7 3.8-4.2" stroke="#e4fbc8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'}
    </svg>`;
  };
  const teacherToggle = control('teacher-enabled', 'Turn Teacher on',
    `<span id="teacher-icon-on" hidden>${teacherSymbol(false)}</span><span id="teacher-icon-off">${teacherSymbol(true)}</span>`);
  teacherToggle.setAttribute('aria-pressed', 'false');
  const pauseWords = document.documentElement.dataset.teacherPauseWords === '3' ? 'up to the next three words' : 'the next word';
  const teacherHelp = `When Teacher is on, a five-second quiet pause plays ${pauseWords}. If a word is flagged as a possible mistake, Teacher recites that one word correctly so you can listen and try again.`;
  teacherToggle.dataset.help = teacherHelp;
  teacherToggle.removeAttribute('title'); // Use one styled tooltip, without a second native bubble.
  const teacherTooltip = document.createElement('span');
  teacherTooltip.id = 'teacher-tooltip'; teacherTooltip.className = 'book-teacher-tooltip';
  teacherTooltip.setAttribute('role', 'tooltip'); teacherTooltip.textContent = teacherHelp;
  teacherToggle.append(teacherTooltip);
  teacherToggle.setAttribute('aria-describedby', teacherTooltip.id);
  const tajweedToggle = tajweedColoursEnabled ? control('tajweed-colors-toggle', 'Show Tajweed colours',
    '<svg class="tajweed-colour-symbol" width="28" height="28" viewBox="0 0 32 32" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 8C11 5 7 5 3 6v19c4-1 8-1 13 2 5-3 9-3 13-2V6c-4-1-8-1-13 2Z" fill="var(--tajweed-icon-paper)" stroke="var(--tajweed-icon-line)" stroke-width="1.6"/><path d="M16 8v19" stroke="var(--tajweed-icon-line)" stroke-width="1.4"/><path class="tajweed-icon-madd" d="M6 11c3-1 5 0 7 1m-7 4c2-.5 4 0 7 1" stroke-width="2"/><path class="tajweed-icon-ghunnah" d="M20 11c2-1 4-1 6-1m-6 5c2-1 4-1 6-1" stroke-width="2"/><path class="tajweed-icon-qalqalah" d="M6 21c2-.5 4 0 7 1m7-2c2-1 4-1 6-1" stroke-width="2"/></svg>') : null;
  if (tajweedToggle) {
    tajweedToggle.setAttribute('aria-pressed', 'false');
    tajweedToggle.setAttribute('aria-describedby', 'tajweed-colors-status');
    tajweedToggle.disabled = true;
  }
  const searchButton = control('book-search', 'Find a verse by voice', orbSymbol('book-search-icon', 'book-search-symbol', `
    <path d="m28 27 7 7" stroke="var(--control-edge)" stroke-width="5.7" stroke-linecap="round" transform="translate(.5 1.4)"/>
    <circle cx="21.5" cy="20.5" r="9" stroke="var(--control-edge)" stroke-width="3.5" transform="translate(.5 1.4)"/>
    <circle cx="21.5" cy="20.5" r="8.7" fill="var(--control-deep)" fill-opacity=".26"/>
    <path d="m28 27 7 7" stroke="url(#book-search-icon-ivory)" stroke-width="5" stroke-linecap="round"/>
    <circle cx="21.5" cy="20.5" r="8.7" stroke="url(#book-search-icon-ivory)" stroke-width="3.1"/>
    <path d="M15.8 20a5.9 5.9 0 0 1 5.5-5.3m9.1 14.8 3.7 3.7" stroke="#fff" stroke-opacity=".85" stroke-width="1.25" stroke-linecap="round"/>`));
  const menu = control('book-menu', 'Open reading settings', orbSymbol('book-settings-icon', 'book-settings-symbol', `
    <path d="M12 16h24M12 24h24M12 32h24" stroke="var(--control-edge)" stroke-opacity=".45" stroke-width="2.7" stroke-linecap="round" transform="translate(.5 1.5)"/>
    <path d="M12 16h24M12 24h24M12 32h24" stroke="url(#book-settings-icon-ivory)" stroke-width="2.2" stroke-linecap="round"/>
    <g fill="var(--control-edge)" fill-opacity=".5" transform="translate(.7 1.5)"><circle cx="18" cy="16" r="3.8"/><circle cx="30" cy="24" r="3.8"/><circle cx="22" cy="32" r="3.8"/></g>
    <g fill="url(#book-settings-icon-ivory)"><circle cx="18" cy="16" r="3.5"/><circle cx="30" cy="24" r="3.5"/><circle cx="22" cy="32" r="3.5"/></g>
    <path d="M16.2 14.5h1.5m10.5 8h1.5m-9.5 8h1.5" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>`));
  for (const button of [searchButton, menu]) {
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
  }
  menu.setAttribute('aria-controls', settings.id);
  searchButton.setAttribute('aria-controls', 'voice-dialog');
  searchButton.disabled = true;
  record.classList.add('book-control'); visibility.classList.add('book-control');
  recorder.append(record, teacherToggle);
  if (tajweedToggle) recorder.append(tajweedToggle);
  recorder.append(visibility, searchButton, menu);
  // Browser zoom, sidebars and font size all change the available gutter.
  // Measure the centered page instead of assigning a desktop breakpoint.
  const reader = document.querySelector('.reader');
  let placementFrame;
  function placeControls() {
    const mobile = document.documentElement.dataset.layout === 'mobile';
    const narrow = document.documentElement.clientWidth <= 600;
    const hasGutter = reader.getBoundingClientRect().left >= 78;
    document.body.classList.toggle('book-controls-top', mobile || narrow || !hasGutter);
  }
  function schedulePlacement() {
    cancelAnimationFrame(placementFrame);
    placementFrame = requestAnimationFrame(placeControls);
  }
  placeControls();
  new ResizeObserver(schedulePlacement).observe(reader);
  window.addEventListener('resize', schedulePlacement);
  let settingsOpener = menu;
  function openSettings(opener, target) {
    settingsOpener = opener;
    if (!settings.open) {
      if (!document.body.classList.contains('book-controls-top')) settings.show();
      else settings.showModal();
      document.body.classList.add('book-settings-open');
      menu.setAttribute('aria-expanded', 'true');
    }
    target.focus();
  }
  searchButton.addEventListener('click', () => {
    const voiceOpen = document.getElementById('voice-open');
    if (!voiceOpen.disabled) voiceOpen.click();
  });
  menu.addEventListener('click', () => {
    if (settings.open) { settings.close(); return; }
    openSettings(menu, document.getElementById('book-close'));
  });
  settings.addEventListener('close', () => {
    document.body.classList.remove('book-settings-open');
    menu.setAttribute('aria-expanded', 'false');
    if (settings.contains(document.activeElement)) settingsOpener.focus();
  });
  settings.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); settings.close(); }
  });
  document.getElementById('book-close').addEventListener('click', () => settings.close());
  settings.addEventListener('click', event => {
    if (event.target !== settings) return;
    const bounds = settings.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) settings.close();
  });
  // Close before the shared handler opens voice search.
  document.getElementById('voice-open').addEventListener('click', () => settings.close());
  const voiceDialog = document.getElementById('voice-dialog');
  const voiceClose = document.getElementById('voice-close');
  let dismissVoicePending = false;
  voiceDialog.addEventListener('click', event => {
    if (event.target !== voiceDialog) return;
    const bounds = voiceDialog.getBoundingClientRect();
    if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
    dismissVoicePending = voiceClose.disabled;
    if (!dismissVoicePending) voiceClose.click();
  });
  new MutationObserver(() => {
    if (dismissVoicePending && !voiceClose.disabled && voiceDialog.open) {
      dismissVoicePending = false; voiceClose.click();
    }
  }).observe(voiceClose, { attributes: true, attributeFilter: ['disabled'] });
  voiceDialog.addEventListener('close', () => { dismissVoicePending = false; searchButton.setAttribute('aria-expanded', 'false'); });
  new MutationObserver(() => searchButton.setAttribute('aria-expanded', String(voiceDialog.open)))
    .observe(voiceDialog, { attributes: true, attributeFilter: ['open'] });
  // Successful navigation closes the panel; invalid queries remain visible.
  const passageObserver = new MutationObserver(() => { if (settings.open) settings.close(); });
  passageObserver.observe(document.getElementById('ayahs'), { childList: true });
}

// Surface module-load errors instead of leaving the original loading message.
(() => {
  const passage = document.getElementById('ayahs');
  if (location.protocol === 'file:') {
    const page = location.pathname.split('/').pop() || 'index.html';
    passage.textContent = `Open this page through your local server: http://localhost:5173/${page}. Opening the HTML file directly cannot load the Quran app.`;
    return;
  }
  try { setupBookLayout(); }
  catch (error) { console.error('Book layout setup failed:', error); }
  const languageReady = document.documentElement.dataset.uiLanguage === 'enabled'
    ? import('./ui-language.js').then(module => module.setupLanguageControls()).catch(error => {
      console.error('Language settings could not load:', error);
    }) : Promise.resolve();
  languageReady.then(() => import('./app.js')).catch(error => {
    passage.replaceChildren();
    const message = document.createElement('p');
    message.textContent = 'The Quran app could not start: ' + error.message;
    const help = document.createElement('p');
    help.textContent = 'Please copy this error when reporting the problem.';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.textContent = 'Reload page';
    retry.addEventListener('click', () => location.reload());
    passage.append(message, help, retry);
    console.error('Quran app startup failed:', error);
  });
})();



