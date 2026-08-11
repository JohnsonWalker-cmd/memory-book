(() => {
  function fatal(message) {
    const el = document.getElementById('auth-message');
    el.hidden = false;
    el.textContent = message;
  }

  if (!window.supabase) {
    fatal("Couldn't load the Supabase library. Check your internet connection and reload.");
    return;
  }

  const config = window.MEMORY_BOOK_CONFIG;
  if (!config || !config.supabaseUrl || !config.supabaseAnonKey) {
    fatal('Missing configuration — put your Supabase URL and anon key in config.js (see README step 2).');
    return;
  }

  const { supabaseUrl, supabaseAnonKey } = config;
  const sb = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  const PHOTO_BUCKET = 'memory-photos';

  // --- DOM refs ---
  const authScreen = document.getElementById('auth-screen');
  const appScreen = document.getElementById('app-screen');
  const googleSignInBtn = document.getElementById('google-signin-btn');
  const authMessage = document.getElementById('auth-message');
  const userEmailEl = document.getElementById('user-email');
  const signOutBtn = document.getElementById('sign-out-btn');

  const menuBtn = document.getElementById('menu-btn');
  const headerMenu = document.getElementById('header-menu');

  const memoriesList = document.getElementById('memories-list');
  const emptyState = document.getElementById('empty-state');
  const addMemoryBtn = document.getElementById('add-memory-btn');
  const addMemoryModal = document.getElementById('add-memory-modal');
  const addMemoryForm = document.getElementById('add-memory-form');
  const cancelMemoryBtn = document.getElementById('cancel-memory-btn');

  const detailModal = document.getElementById('detail-modal');
  const detailContent = document.getElementById('detail-content');
  const closeDetailBtn = document.getElementById('close-detail-btn');
  const notesList = document.getElementById('notes-list');
  const addNoteForm = document.getElementById('add-note-form');
  const noteInput = document.getElementById('note-input');

  let currentUserEmail = null;
  let currentMemoryId = null;
  let memoriesCache = [];

  // --- Auth ---
  googleSignInBtn.addEventListener('click', async () => {
    authMessage.hidden = true;
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href },
    });
    if (error) {
      authMessage.hidden = false;
      authMessage.textContent = `Error: ${error.message}`;
    }
  });

  signOutBtn.addEventListener('click', async () => {
    closeMenu();
    await sb.auth.signOut();
  });

  // --- Header menu (phones only; the panel is a plain inline row above 600px,
  // where .menu-btn is display:none and .header-right is always visible) ---
  function closeMenu() {
    headerMenu.classList.remove('open');
    menuBtn.setAttribute('aria-expanded', 'false');
  }

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't immediately hit the document handler below
    const open = headerMenu.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', (e) => {
    if (!headerMenu.classList.contains('open')) return;
    if (!headerMenu.contains(e.target)) closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (headerMenu.classList.contains('open')) {
      closeMenu();
      menuBtn.focus();
    }
  });

  // Rotating to landscape (or resizing past the breakpoint) turns the panel
  // back into an inline row; drop the class so it isn't left "open".
  window.matchMedia('(max-width: 600px)').addEventListener('change', closeMenu);

  sb.auth.onAuthStateChange((_event, session) => {
    if (session?.user?.email) {
      currentUserEmail = session.user.email;
      showApp();
    } else {
      currentUserEmail = null;
      showAuth();
    }
  });

  function showAuth() {
    authScreen.hidden = false;
    appScreen.hidden = true;

    // Drop the previous account's data: signed photo URLs stay valid for an
    // hour, so leaving the cards up would show them to whoever signs in next
    // on a shared device.
    unsubscribeRealtime();
    closeMenu();
    memoriesCache = [];
    currentMemoryId = null;
    memoriesList.replaceChildren();
    notesList.replaceChildren();
    detailContent.replaceChildren();
    detailModal.hidden = true;
    addMemoryModal.hidden = true;
    emptyState.hidden = true;
    userEmailEl.textContent = '';
  }

  function showApp() {
    authScreen.hidden = true;
    appScreen.hidden = false;
    userEmailEl.textContent = currentUserEmail;
    loadMemories();
    subscribeRealtime();
  }

  // --- Add memory modal ---
  addMemoryBtn.addEventListener('click', () => {
    addMemoryForm.reset();
    document.getElementById('memory-date').value = todayLocal();
    addMemoryModal.hidden = false;
  });

  cancelMemoryBtn.addEventListener('click', () => {
    addMemoryModal.hidden = true;
  });

  addMemoryModal.addEventListener('click', (e) => {
    if (e.target === addMemoryModal) addMemoryModal.hidden = true;
  });

  detailModal.addEventListener('click', (e) => {
    if (e.target === detailModal) {
      detailModal.hidden = true;
      currentMemoryId = null;
    }
  });

  addMemoryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('memory-title').value.trim();
    const memory_date = document.getElementById('memory-date').value;
    const description = document.getElementById('memory-description').value.trim();
    const file = document.getElementById('memory-photo').files[0];

    const submitBtn = addMemoryForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    let uploadedPath = null;
    try {
      let image_path = null;
      if (file) {
        image_path = storageKeyFor(file);
        const { error: uploadError } = await sb.storage
          .from(PHOTO_BUCKET)
          .upload(image_path, file);
        if (uploadError) throw uploadError;
        uploadedPath = image_path;
      }

      const { error: insertError } = await sb
        .from('memories')
        .insert({ title, memory_date, description, image_path });
      if (insertError) throw insertError;

      uploadedPath = null;
      addMemoryModal.hidden = true;
      loadMemories();
    } catch (err) {
      // The photo uploaded but the row didn't land — drop the object rather
      // than leaving it in the bucket with nothing referencing it.
      if (uploadedPath) {
        await sb.storage.from(PHOTO_BUCKET).remove([uploadedPath]).catch(() => {});
      }
      alert(`Couldn't save memory: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save memory';
    }
  });

  // --- Load & render memories ---
  // Concurrent runs are common (a write plus the realtime event it triggers).
  // Without a token the slowest query wins the DOM regardless of age, so a
  // stale list can overwrite a fresh one — e.g. a just-deleted card reappearing.
  let loadMemoriesToken = 0;

  async function loadMemories() {
    const token = ++loadMemoriesToken;

    const { data, error } = await sb
      .from('memories')
      .select('*')
      .order('memory_date', { ascending: false });

    if (error) {
      console.error(error);
      return;
    }
    if (token !== loadMemoriesToken) return;

    const cards = await Promise.all(data.map(renderMemoryCard));
    if (token !== loadMemoriesToken) return;

    memoriesCache = data;
    emptyState.hidden = data.length > 0;
    memoriesList.replaceChildren(...cards);
  }

  async function getSignedUrl(path) {
    if (!path) return null;
    const { data, error } = await sb.storage
      .from(PHOTO_BUCKET)
      .createSignedUrl(path, 3600);
    if (error) {
      console.error(error);
      return null;
    }
    return data.signedUrl;
  }

  async function renderMemoryCard(memory) {
    const card = document.createElement('div');
    card.className = 'memory-card';
    card.addEventListener('click', () => openDetail(memory.id));

    const imgUrl = await getSignedUrl(memory.image_path);
    card.innerHTML = `
      ${imgUrl ? `<img src="${escapeAttr(imgUrl)}" alt="${escapeAttr(memory.title)}">` : ''}
      <div class="memory-card-body">
        <h3>${escapeHtml(memory.title)}</h3>
        <div class="memory-meta">${formatDate(memory.memory_date)} · ${escapeHtml(memory.author_email)}</div>
        <p>${escapeHtml(memory.description || '')}</p>
      </div>
    `;
    return card;
  }

  // --- Detail modal & notes ---
  async function openDetail(memoryId) {
    currentMemoryId = memoryId;
    const memory = memoriesCache.find((m) => m.id === memoryId);
    if (!memory) return;

    const imgUrl = await getSignedUrl(memory.image_path);
    // Another card may have been opened while the signed URL was in flight;
    // writing now would pair this memory's content with the other one's notes
    // and delete button.
    if (currentMemoryId !== memoryId) return;

    detailContent.innerHTML = `
      <h2>${escapeHtml(memory.title)}</h2>
      <div class="detail-meta">${formatDate(memory.memory_date)} · ${escapeHtml(memory.author_email)}</div>
      ${imgUrl ? `<img src="${escapeAttr(imgUrl)}" alt="${escapeAttr(memory.title)}">` : ''}
      <p>${escapeHtml(memory.description || '')}</p>
      ${memory.author_email === currentUserEmail
        ? '<button type="button" class="delete-memory-btn" id="delete-memory-btn">Delete this memory</button>'
        : ''}
    `;

    const deleteBtn = document.getElementById('delete-memory-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => deleteMemory(memoryId));
    }

    detailModal.hidden = false;
    loadNotes(memoryId);
  }

  closeDetailBtn.addEventListener('click', () => {
    detailModal.hidden = true;
    currentMemoryId = null;
  });

  async function deleteMemory(memoryId) {
    if (!confirm('Delete this memory and its notes?')) return;

    const imagePath = memoriesCache.find((m) => m.id === memoryId)?.image_path;

    const { error } = await sb.from('memories').delete().eq('id', memoryId);
    if (error) {
      alert(`Couldn't delete: ${error.message}`);
      return;
    }

    // Row is gone, so the object is unreachable from the UI either way — a
    // failure here only wastes quota, and shouldn't block the delete.
    if (imagePath) {
      const { error: removeError } = await sb.storage.from(PHOTO_BUCKET).remove([imagePath]);
      if (removeError) console.error(removeError);
    }

    detailModal.hidden = true;
    currentMemoryId = null;
    loadMemories();
  }

  async function loadNotes(memoryId) {
    const { data, error } = await sb
      .from('notes')
      .select('*')
      .eq('memory_id', memoryId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error(error);
      return;
    }

    notesList.innerHTML = data
      .map(
        (note) => `
      <div class="note">
        <div>${escapeHtml(note.body)}</div>
        <div class="note-meta">${escapeHtml(note.author_email)} · ${formatDateTime(note.created_at)}</div>
      </div>
    `
      )
      .join('');
    notesList.scrollTop = notesList.scrollHeight;
  }

  addNoteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = noteInput.value.trim();
    if (!body || !currentMemoryId) return;

    const { error } = await sb
      .from('notes')
      .insert({ memory_id: currentMemoryId, body });
    if (error) {
      alert(`Couldn't add note: ${error.message}`);
      return;
    }
    noteInput.value = '';
    loadNotes(currentMemoryId);
  });

  // --- Realtime ---
  let realtimeChannel = null;
  function subscribeRealtime() {
    if (realtimeChannel) return;

    realtimeChannel = sb.channel('memory-book-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'memories' }, () => {
        loadMemories();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, (payload) => {
        const memoryId = payload.new?.memory_id || payload.old?.memory_id;
        if (memoryId && memoryId === currentMemoryId) {
          loadNotes(memoryId);
        }
      })
      .subscribe();
  }

  // Tear the channel down on sign-out so the next sign-in gets a fresh
  // subscription rather than relying on the old one surviving the auth change.
  function unsubscribeRealtime() {
    if (!realtimeChannel) return;
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  // --- Helpers ---
  // Today in the user's own timezone. (input.valueAsDate reads/writes UTC, so
  // it pre-fills tomorrow for anyone west of UTC during their evening.)
  function todayLocal() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  // Storage keys go in a URL path, so keep the random name and a plain
  // extension rather than passing through a phone/messenger filename that may
  // contain '#', '?', '/' or control characters.
  function storageKeyFor(file) {
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(file.name || '');
    const ext = match ? `.${match[1].toLowerCase()}` : '';
    return `${crypto.randomUUID()}${ext}`;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  function formatDateTime(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleString();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str ?? '').replace(/"/g, '&quot;');
  }
})();

// --- PWA: install, updates, offline status ---
// Deliberately outside the main IIFE: that one returns early if the Supabase
// library or config.js is missing, and the shell should still register its
// worker and report connectivity in that state.
(() => {
  const offlineBanner = document.getElementById('offline-banner');
  const updateBanner = document.getElementById('update-banner');
  const reloadBtn = document.getElementById('reload-btn');

  function syncOnlineStatus() {
    offlineBanner.hidden = navigator.onLine;
  }

  window.addEventListener('online', syncOnlineStatus);
  window.addEventListener('offline', syncOnlineStatus);
  syncOnlineStatus();

  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    let registration;
    try {
      // Relative path so the scope follows the deploy directory (project
      // pages live under /<repo-name>/, not the domain root).
      registration = await navigator.serviceWorker.register('./sw.js');
    } catch (err) {
      console.error('Service worker registration failed:', err);
      return;
    }

    // An update is only worth announcing if a worker is already in control —
    // otherwise this is the first install and there is nothing to replace.
    function promptForUpdate() {
      if (!navigator.serviceWorker.controller) return;
      updateBanner.hidden = false;
    }

    // A worker that finished installing during an earlier visit is already
    // parked in `waiting`, and `updatefound` has long since fired — so without
    // this check the prompt would be silently missed and the update would sit
    // there until the browser eventually discarded the old worker.
    if (registration.waiting) promptForUpdate();

    registration.addEventListener('updatefound', () => {
      const incoming = registration.installing;
      if (!incoming) return;

      incoming.addEventListener('statechange', () => {
        if (incoming.state === 'installed') promptForUpdate();
      });
    });

    // The browser only looks for a new sw.js on navigation. An installed PWA
    // can stay alive on a phone for days without one, so ask explicitly when
    // the app comes back to the foreground or regains a connection —
    // throttled, since visibilitychange fires on every app switch.
    const UPDATE_CHECK_INTERVAL = 60 * 1000;
    let lastUpdateCheck = Date.now();

    function checkForUpdate() {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      if (Date.now() - lastUpdateCheck < UPDATE_CHECK_INTERVAL) return;
      lastUpdateCheck = Date.now();
      registration.update().catch(() => {
        // Offline or the server is unreachable — nothing to do, we'll retry
        // on the next foreground.
      });
    }

    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('online', checkForUpdate);
    window.addEventListener('focus', checkForUpdate);

    reloadBtn.addEventListener('click', () => {
      reloadBtn.disabled = true;
      if (registration.waiting) {
        registration.waiting.postMessage('SKIP_WAITING');
      } else {
        // Nothing waiting (rare: the worker was replaced between prompt and
        // tap). A plain reload still lands the user on the current version.
        window.location.reload();
      }
    });

    // Reload once the replacement worker has taken over, so the page and the
    // worker never disagree about which shell version is live.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
})();

