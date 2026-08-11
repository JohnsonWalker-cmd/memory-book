(() => {
  if (!window.supabase) {
    document.getElementById('auth-message').hidden = false;
    document.getElementById('auth-message').textContent =
      "Couldn't load the Supabase library. Check your internet connection and reload.";
    return;
  }

  const { supabaseUrl, supabaseAnonKey } = window.MEMORY_BOOK_CONFIG;
  const sb = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  const PHOTO_BUCKET = 'memory-photos';

  // --- DOM refs ---
  const authScreen = document.getElementById('auth-screen');
  const appScreen = document.getElementById('app-screen');
  const googleSignInBtn = document.getElementById('google-signin-btn');
  const authMessage = document.getElementById('auth-message');
  const userEmailEl = document.getElementById('user-email');
  const signOutBtn = document.getElementById('sign-out-btn');

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
    await sb.auth.signOut();
  });

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
    document.getElementById('memory-date').valueAsDate = new Date();
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

    try {
      let image_path = null;
      if (file) {
        image_path = `${crypto.randomUUID()}-${file.name}`;
        const { error: uploadError } = await sb.storage
          .from(PHOTO_BUCKET)
          .upload(image_path, file);
        if (uploadError) throw uploadError;
      }

      const { error: insertError } = await sb
        .from('memories')
        .insert({ title, memory_date, description, image_path });
      if (insertError) throw insertError;

      addMemoryModal.hidden = true;
      loadMemories();
    } catch (err) {
      alert(`Couldn't save memory: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save memory';
    }
  });

  // --- Load & render memories ---
  async function loadMemories() {
    const { data, error } = await sb
      .from('memories')
      .select('*')
      .order('memory_date', { ascending: false });

    if (error) {
      console.error(error);
      return;
    }

    memoriesCache = data;
    emptyState.hidden = data.length > 0;
    memoriesList.innerHTML = '';

    for (const memory of data) {
      const card = await renderMemoryCard(memory);
      memoriesList.appendChild(card);
    }
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
    detailContent.innerHTML = `
      <h2>${escapeHtml(memory.title)}</h2>
      <div class="detail-meta">${formatDate(memory.memory_date)} · ${escapeHtml(memory.author_email)}</div>
      ${imgUrl ? `<img src="${escapeAttr(imgUrl)}" alt="${escapeAttr(memory.title)}">` : ''}
      <p>${escapeHtml(memory.description || '')}</p>
      ${memory.author_email === currentUserEmail
        ? '<button class="delete-memory-btn" id="delete-memory-btn">Delete this memory</button>'
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
    const { error } = await sb.from('memories').delete().eq('id', memoryId);
    if (error) {
      alert(`Couldn't delete: ${error.message}`);
      return;
    }
    detailModal.hidden = true;
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
  let realtimeSubscribed = false;
  function subscribeRealtime() {
    if (realtimeSubscribed) return;
    realtimeSubscribed = true;

    sb.channel('memory-book-changes')
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

  // --- Helpers ---
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

