// ── SyncBeats — Room Logic ──────────────────────────────────────
// Direct iframe embed + YouTube IFrame JS API for state detection
// + Socket.io sync + Queue + Chat

const socket = io();

// ── State ──────────────────────────────────────────────────────
let ytPlayer = null;        // YouTube JS API player instance
let isPlayerReady = false;
let isSyncing = false;      // flag to prevent echo when receiving sync events
let lastKnownTime = 0;      // track time to detect seeks
let lastPlayerState = -1;   // track state changes
let queue = [];
let currentIndex = -1;
let username = '';
let roomCode = '';
let unreadChat = 0;
let activeTab = 'queue';
let currentVideoId = null;
let seekCheckInterval = null;

// ── DOM Elements ────────────────────────────────────────────────
const roomCodeText = document.getElementById('room-code-text');
const copyCodeBtn = document.getElementById('copy-code-btn');
const shareBtn = document.getElementById('share-btn');
const userCount = document.getElementById('user-count');
const playerPlaceholder = document.getElementById('player-placeholder');
const nowPlayingTitle = document.getElementById('now-playing-title');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const playPauseBtn = document.getElementById('play-pause-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const urlInput = document.getElementById('youtube-url-input');
const addSongBtn = document.getElementById('add-song-btn');
const searchResults = document.getElementById('search-results');
const queueList = document.getElementById('queue-list');
const queueCount = document.getElementById('queue-count');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');
const chatBadge = document.getElementById('chat-badge');
const userList = document.getElementById('user-list');
const toastContainer = document.getElementById('toast-container');
const playerContainer = document.getElementById('youtube-player-container');

// Tab buttons
const tabBtns = document.querySelectorAll('.tab-btn');
const panels = {
    queue: document.getElementById('queue-panel'),
    chat: document.getElementById('chat-panel'),
    users: document.getElementById('users-panel')
};

// ── Init ──────────────────────────────────────────────────────
function init() {
    // Get room code from URL
    const params = new URLSearchParams(window.location.search);
    roomCode = params.get('room');
    username = sessionStorage.getItem('syncbeats-username') || localStorage.getItem('syncbeats-username') || '';
    const action = sessionStorage.getItem('syncbeats-action');

    if (!roomCode || !username) {
        window.location.href = '/';
        return;
    }

    roomCodeText.textContent = roomCode;

    // Load YouTube IFrame API for state detection
    loadYouTubeAPI();

    // Join or create based on action
    if (action === 'create') {
        socket.emit('create-room', { username }, (response) => {
            if (response.success) {
                roomCode = response.code;
                roomCodeText.textContent = roomCode;
                window.history.replaceState(null, '', `/room.html?room=${roomCode}`);
                localStorage.setItem('syncbeats-last-room', roomCode);
                addSystemMessage(`You created room ${roomCode}`);
                updateUserList([username]);
            }
        });
    } else {
        socket.emit('join-room', { username, code: roomCode }, (response) => {
            if (response.success) {
                localStorage.setItem('syncbeats-last-room', roomCode);
                addSystemMessage(`You joined room ${roomCode}`);
                if (response.state) {
                    queue = response.state.queue || [];
                    currentIndex = response.state.currentIndex;
                    renderQueue();
                    updateUserList(response.state.users);

                    if (currentIndex >= 0 && queue[currentIndex]) {
                        const startTime = response.state.currentTime || 0;
                        const shouldPlay = response.state.isPlaying;
                        waitForAPI(() => {
                            loadVideo(queue[currentIndex].videoId, startTime, shouldPlay);
                        });
                    }
                }
            } else {
                alert(response.error || 'Failed to join room');
                window.location.href = '/';
            }
        });
    }

    setupEventListeners();
    setupSocketListeners();
}

// ── YouTube IFrame API ─────────────────────────────────────────
let ytAPIReady = false;

function loadYouTubeAPI() {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
}

window.onYouTubeIframeAPIReady = function () {
    ytAPIReady = true;
    console.log('🎬 YouTube IFrame API loaded');
};

function waitForAPI(callback) {
    if (ytAPIReady) {
        callback();
    } else {
        const check = setInterval(() => {
            if (ytAPIReady) {
                clearInterval(check);
                callback();
            }
        }, 200);
    }
}

// ── Load Video ─────────────────────────────────────────────────
// Uses YT.Player to create the player — gives us full event control
// (state changes, current time, seek detection)

function loadVideo(videoId, startTime = 0, autoplay = true) {
    playerPlaceholder.classList.add('hidden');
    currentVideoId = videoId;

    // Stop seek check interval from previous video
    if (seekCheckInterval) {
        clearInterval(seekCheckInterval);
        seekCheckInterval = null;
    }

    // Destroy existing player
    if (ytPlayer && typeof ytPlayer.destroy === 'function') {
        try { ytPlayer.destroy(); } catch (e) { }
        ytPlayer = null;
    }

    // Remove any leftover iframe
    const existingIframe = playerContainer.querySelector('iframe');
    if (existingIframe) existingIframe.remove();

    // Ensure the target div exists
    let targetDiv = document.getElementById('youtube-player');
    if (!targetDiv) {
        targetDiv = document.createElement('div');
        targetDiv.id = 'youtube-player';
        playerContainer.insertBefore(targetDiv, playerPlaceholder);
    }

    // Create player via YT.Player API
    isPlayerReady = false;
    ytPlayer = new YT.Player('youtube-player', {
        width: '100%',
        height: '100%',
        videoId: videoId,
        playerVars: {
            autoplay: autoplay ? 1 : 0,
            controls: 1,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            start: Math.floor(startTime),
            iv_load_policy: 3,
            fs: 1,
            origin: window.location.origin
        },
        events: {
            onReady: (event) => {
                isPlayerReady = true;
                lastKnownTime = startTime;
                lastPlayerState = autoplay ? YT.PlayerState.PLAYING : YT.PlayerState.CUED;
                updatePlayPauseUI(autoplay);

                // Start seek detection polling
                startSeekDetection();

                // Setup Media Session for background/lock screen controls
                updateMediaSession();
                console.log('✅ Player ready, video:', videoId);
            },
            onStateChange: (event) => {
                handleStateChange(event.data);
            },
            onError: (event) => {
                console.warn('⚠️ YouTube error:', event.data);
                handlePlayerError(event.data);
            }
        }
    });

    // Style the iframe when it's created
    const observer = new MutationObserver(() => {
        const iframe = playerContainer.querySelector('iframe');
        if (iframe) {
            iframe.style.borderRadius = '10px';
            iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
            observer.disconnect();
        }
    });
    observer.observe(playerContainer, { childList: true, subtree: true });

    // Update now playing title
    const song = queue[currentIndex];
    if (song) {
        nowPlayingTitle.textContent = song.title;
    }
    renderQueue();
}

// ── State Change Handler ────────────────────────────────────────
function handleStateChange(state) {
    if (isSyncing) return; // Don't emit if we're applying a sync event

    if (state === YT.PlayerState.PLAYING) {
        updatePlayPauseUI(true);
        const currentTime = ytPlayer.getCurrentTime();
        lastKnownTime = currentTime;
        socket.emit('sync-play', { currentTime });
    } else if (state === YT.PlayerState.PAUSED) {
        updatePlayPauseUI(false);
        const currentTime = ytPlayer.getCurrentTime();
        lastKnownTime = currentTime;
        socket.emit('sync-pause', { currentTime });
    } else if (state === YT.PlayerState.ENDED) {
        // Auto-play next in queue
        if (currentIndex < queue.length - 1) {
            socket.emit('next-song');
        }
    }

    lastPlayerState = state;
}

// ── Seek Detection ──────────────────────────────────────────────
// YouTube doesn't fire a "seek" event, so we poll getCurrentTime()
// and detect jumps > 2 seconds that aren't natural playback progression

function startSeekDetection() {
    if (seekCheckInterval) clearInterval(seekCheckInterval);

    seekCheckInterval = setInterval(() => {
        if (!isPlayerReady || !ytPlayer || isSyncing) return;

        try {
            const currentTime = ytPlayer.getCurrentTime();
            const playerState = ytPlayer.getPlayerState();

            // Only detect seeks while playing
            if (playerState === YT.PlayerState.PLAYING) {
                const expectedTime = lastKnownTime + 1; // ~1 second per check
                const timeDiff = Math.abs(currentTime - expectedTime);

                if (timeDiff > 3) {
                    // User seeked! Emit sync-seek
                    console.log(`⏩ Seek detected: ${lastKnownTime.toFixed(1)}s → ${currentTime.toFixed(1)}s`);
                    socket.emit('sync-seek', { currentTime });
                }
            }

            lastKnownTime = currentTime;
        } catch (e) {
            // Player might not be ready
        }
    }, 1000); // Check every second
}

// ── Error Handling ──────────────────────────────────────────────
function handlePlayerError(errorCode) {
    const song = queue[currentIndex];
    if (!song) return;

    if (errorCode === 101 || errorCode === 150) {
        showToast('This video blocks embedding. Try another URL.', 'info');
    } else if (errorCode === 100) {
        showToast('Video not found or removed.', 'info');
    } else {
        // Fallback: try loading via direct iframe embed
        showToast('Retrying with fallback player...', 'info');
        loadVideoFallback(song.videoId);
    }
}

// Fallback: direct iframe embed (works on local IPs where YT API fails)
function loadVideoFallback(videoId) {
    if (ytPlayer && typeof ytPlayer.destroy === 'function') {
        try { ytPlayer.destroy(); } catch (e) { }
        ytPlayer = null;
    }

    const existingIframe = playerContainer.querySelector('iframe');
    if (existingIframe) existingIframe.remove();

    const params = new URLSearchParams({
        autoplay: '1', controls: '1', modestbranding: '1',
        rel: '0', playsinline: '1', enablejsapi: '1', fs: '1'
    });

    const iframe = document.createElement('iframe');
    iframe.id = 'yt-iframe';
    iframe.src = `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.frameBorder = '0';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.style.borderRadius = '10px';

    playerContainer.insertBefore(iframe, playerPlaceholder);
    isPlayerReady = true;
    showToast('Playing in fallback mode (sync limited)', 'info');
}

function updatePlayPauseUI(isPlaying) {
    playIcon.classList.toggle('hidden', isPlaying);
    pauseIcon.classList.toggle('hidden', !isPlaying);
}

// ── Extract YouTube Video ID ────────────────────────────────────
function extractVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/ // Direct video ID
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// ── Fetch video title from oEmbed ────────────────────────────────
async function fetchVideoTitle(videoId) {
    try {
        const res = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
        const data = await res.json();
        return data.title || `Video ${videoId}`;
    } catch {
        return `Video ${videoId}`;
    }
}

// ── Event Listeners ────────────────────────────────────────────
function setupEventListeners() {
    // Copy room code
    copyCodeBtn.addEventListener('click', () => {
        copyToClipboard(roomCode);
        showToast('Room code copied!', 'success');
    });

    // Share room link
    shareBtn.addEventListener('click', () => {
        const shareUrl = `${window.location.origin}/room.html?room=${roomCode}`;
        const shareData = {
            title: 'SyncBeats — Listen Together',
            text: `Join my SyncBeats room! Code: ${roomCode}`,
            url: shareUrl
        };

        // Use native share on mobile, clipboard on desktop
        if (navigator.share) {
            navigator.share(shareData).catch(() => { });
        } else {
            copyToClipboard(shareUrl);
            showToast('Room link copied to clipboard!', 'success');
        }
    });

    // Add song
    addSongBtn.addEventListener('click', addSong);
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            // If search results visible and query is not a URL, add first result
            if (!searchResults.classList.contains('hidden') && !extractVideoId(urlInput.value.trim())) {
                const firstResult = searchResults.querySelector('.search-result-item');
                if (firstResult) firstResult.click();
                return;
            }
            addSong();
        }
    });

    // Search as you type (debounced)
    let searchTimeout = null;
    urlInput.addEventListener('input', () => {
        const value = urlInput.value.trim();
        clearTimeout(searchTimeout);

        // If it looks like a URL, don't search
        if (!value || extractVideoId(value)) {
            searchResults.classList.add('hidden');
            return;
        }

        // Debounce: search after 400ms of no typing
        searchTimeout = setTimeout(() => searchYouTube(value), 400);
    });

    // Close search results on click outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            searchResults.classList.add('hidden');
        }
    });

    // Player controls
    playPauseBtn.addEventListener('click', () => {
        if (!isPlayerReady || !ytPlayer || currentIndex < 0) return;
        try {
            const state = ytPlayer.getPlayerState();
            if (state === YT.PlayerState.PLAYING) {
                ytPlayer.pauseVideo();
            } else {
                ytPlayer.playVideo();
            }
        } catch (e) {
            // Player not ready
        }
    });

    nextBtn.addEventListener('click', () => {
        if (currentIndex < queue.length - 1) {
            socket.emit('next-song');
        }
    });

    prevBtn.addEventListener('click', () => {
        if (currentIndex > 0) {
            socket.emit('play-song', { index: currentIndex - 1 });
        }
    });

    // Tabs
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            switchTab(tab);
        });
    });

    // Chat
    sendChatBtn.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChat();
    });
}

async function addSong() {
    const url = urlInput.value.trim();
    if (!url) return;

    const videoId = extractVideoId(url);
    if (!videoId) {
        // Not a URL — trigger search instead
        searchYouTube(url);
        return;
    }

    addSongBtn.disabled = true;
    const title = await fetchVideoTitle(videoId);

    socket.emit('add-to-queue', { videoId, title });
    urlInput.value = '';
    searchResults.classList.add('hidden');
    addSongBtn.disabled = false;
    urlInput.focus();
}

async function searchYouTube(query) {
    if (!query || query.length < 2) return;

    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const results = await res.json();

        if (results.length === 0) {
            searchResults.innerHTML = '<div class="search-empty">No results found</div>';
            searchResults.classList.remove('hidden');
            return;
        }

        searchResults.innerHTML = results.map(r => `
            <div class="search-result-item" data-video-id="${r.videoId}" data-title="${escapeHtml(r.title)}">
                <img class="search-thumb" src="${r.thumbnail}" alt="" loading="lazy">
                <div class="search-result-info">
                    <div class="search-result-title">${escapeHtml(r.title)}</div>
                    <div class="search-result-meta">${escapeHtml(r.channel)} ${r.duration ? '· ' + r.duration : ''}</div>
                </div>
            </div>
        `).join('');

        // Click to add
        searchResults.querySelectorAll('.search-result-item').forEach(item => {
            item.addEventListener('click', () => {
                const videoId = item.dataset.videoId;
                const title = item.dataset.title;
                socket.emit('add-to-queue', { videoId, title });
                urlInput.value = '';
                searchResults.classList.add('hidden');
                showToast('Added to queue!', 'success');
            });
        });

        searchResults.classList.remove('hidden');
    } catch (e) {
        console.error('Search error:', e);
    }
}

function sendChat() {
    const message = chatInput.value.trim();
    if (!message) return;
    socket.emit('chat-message', { message });
    chatInput.value = '';
}

function switchTab(tab) {
    activeTab = tab;
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    Object.entries(panels).forEach(([key, panel]) => {
        panel.classList.toggle('hidden', key !== tab);
    });

    if (tab === 'chat') {
        unreadChat = 0;
        chatBadge.classList.add('hidden');
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

// ── Socket Listeners ───────────────────────────────────────────
function setupSocketListeners() {
    // User joined
    socket.on('user-joined', (data) => {
        addSystemMessage(`${data.username} joined the room`);
        showToast(`${data.username} joined! 🎧`, 'info');
        updateUserList(data.users);
    });

    // User left
    socket.on('user-left', (data) => {
        addSystemMessage(`${data.username} left the room`);
        updateUserList(data.users);
    });

    // Queue updated
    socket.on('queue-updated', (data) => {
        queue = data.queue;
        currentIndex = data.currentIndex;
        renderQueue();

        const newSong = queue[queue.length - 1];
        if (newSong) {
            showToast(`🎵 "${newSong.title}" added by ${newSong.addedBy}`, 'info');
        }

        // Auto-play first song
        if (data.autoPlay && currentIndex >= 0) {
            waitForAPI(() => {
                loadVideo(queue[currentIndex].videoId);
            });
        }
    });

    // Queue reordered
    socket.on('queue-reordered', (data) => {
        queue = data.queue;
        currentIndex = data.currentIndex;
        renderQueue();
    });

    // Sync play
    socket.on('sync-play', (data) => {
        if (currentIndex < 0 || !currentVideoId) return;
        isSyncing = true;

        if (isPlayerReady && ytPlayer) {
            try {
                const diff = Math.abs(ytPlayer.getCurrentTime() - data.currentTime);
                if (diff > 2) {
                    ytPlayer.seekTo(data.currentTime, true);
                }
                ytPlayer.playVideo();
                lastKnownTime = data.currentTime;
            } catch (e) { }
        }
        updatePlayPauseUI(true);

        setTimeout(() => { isSyncing = false; }, 500);
    });

    // Sync pause
    socket.on('sync-pause', (data) => {
        if (currentIndex < 0 || !currentVideoId) return;
        isSyncing = true;

        if (isPlayerReady && ytPlayer) {
            try {
                ytPlayer.seekTo(data.currentTime, true);
                ytPlayer.pauseVideo();
                lastKnownTime = data.currentTime;
            } catch (e) { }
        }
        updatePlayPauseUI(false);

        setTimeout(() => { isSyncing = false; }, 500);
    });

    // Sync seek — the key new feature!
    socket.on('sync-seek', (data) => {
        if (!currentVideoId) return;
        isSyncing = true;

        if (isPlayerReady && ytPlayer) {
            try {
                ytPlayer.seekTo(data.currentTime, true);
                lastKnownTime = data.currentTime;
                console.log(`⏩ Synced seek to ${data.currentTime.toFixed(1)}s`);
            } catch (e) { }
        }

        setTimeout(() => { isSyncing = false; }, 1000);
    });

    // Play specific song
    socket.on('play-song', (data) => {
        currentIndex = data.index;
        if (queue[currentIndex]) {
            waitForAPI(() => {
                loadVideo(queue[currentIndex].videoId);
            });
        }
    });

    // Chat message
    socket.on('chat-message', (data) => {
        addChatMessage(data);
        if (activeTab !== 'chat') {
            unreadChat++;
            chatBadge.textContent = unreadChat;
            chatBadge.classList.remove('hidden');

            // Show popup notification
            if (data.username !== username) {
                const preview = data.message.length > 50 ? data.message.slice(0, 50) + '…' : data.message;
                showChatPopup(data.username, preview);
            }
        }
    });
}

// ── UI Rendering ────────────────────────────────────────────────
function renderQueue() {
    queueCount.textContent = `${queue.length} song${queue.length !== 1 ? 's' : ''}`;

    if (queue.length === 0) {
        queueList.innerHTML = `
      <div class="empty-state">
        <p>🎵 Queue is empty</p>
        <p class="empty-hint">Add a YouTube URL to get started</p>
      </div>`;
        return;
    }

    queueList.innerHTML = queue.map((song, i) => `
    <div class="queue-item ${i === currentIndex ? 'active' : ''}" data-index="${i}">
      <span class="queue-item-index">${i === currentIndex ? '▶' : i + 1}</span>
      <div class="queue-item-info">
        <div class="queue-item-title">${escapeHtml(song.title)}</div>
        <div class="queue-item-by">Added by ${escapeHtml(song.addedBy)}</div>
      </div>
      <div class="queue-item-actions">
        ${i > 0 ? `<button class="reorder-btn" data-dir="up" data-index="${i}" title="Move up">▲</button>` : ''}
        ${i < queue.length - 1 ? `<button class="reorder-btn" data-dir="down" data-index="${i}" title="Move down">▼</button>` : ''}
      </div>
      ${i === currentIndex ? `
        <div class="playing-indicator">
          <span></span><span></span><span></span>
        </div>` : ''}
    </div>
  `).join('');

    // Click to play song from queue
    queueList.querySelectorAll('.queue-item').forEach(item => {
        item.addEventListener('click', (e) => {
            // Don't trigger play if clicking reorder buttons
            if (e.target.closest('.reorder-btn')) return;
            const index = parseInt(item.dataset.index);
            if (index !== currentIndex) {
                socket.emit('play-song', { index });
            }
        });
    });

    // Reorder buttons
    queueList.querySelectorAll('.reorder-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index);
            const dir = btn.dataset.dir;
            const toIndex = dir === 'up' ? index - 1 : index + 1;
            socket.emit('reorder-queue', { fromIndex: index, toIndex });
        });
    });
}

function addChatMessage(data) {
    const emptyState = chatMessages.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isMe = data.username === username;

    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg';
    msgEl.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-name" style="${isMe ? 'color: var(--accent-purple)' : ''}">${escapeHtml(data.username)}</span>
      <span class="chat-msg-time">${time}</span>
    </div>
    <div class="chat-msg-text">${escapeHtml(data.message)}</div>
  `;
    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
    const emptyState = chatMessages.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg chat-msg-system';
    msgEl.innerHTML = `<div class="chat-msg-text">${escapeHtml(text)}</div>`;
    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateUserList(users) {
    userCount.textContent = users.length;

    userList.innerHTML = users.map((u, i) => `
    <li class="user-list-item">
      <div class="user-avatar">${u.charAt(0).toUpperCase()}</div>
      <span class="user-name">${escapeHtml(u)}</span>
      ${u === username ? '<span class="user-badge">You</span>' : ''}
    </li>
  `).join('');
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => {
            fallbackCopy(text);
        });
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    textArea.remove();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Start ──────────────────────────────────────────────────────
init();

// ── Chat Popup Notification ─────────────────────────────────────
function showChatPopup(sender, preview) {
    // Remove any existing popup
    const existing = document.querySelector('.chat-popup');
    if (existing) existing.remove();

    const popup = document.createElement('div');
    popup.className = 'chat-popup';
    popup.innerHTML = `
        <div class="chat-popup-header">
            <span class="chat-popup-avatar">${sender.charAt(0).toUpperCase()}</span>
            <span class="chat-popup-name">${escapeHtml(sender)}</span>
        </div>
        <div class="chat-popup-text">${escapeHtml(preview)}</div>
    `;

    // Click to open chat tab
    popup.addEventListener('click', () => {
        switchTab('chat');
        popup.remove();
    });

    toastContainer.appendChild(popup);
    setTimeout(() => {
        if (popup.parentNode) popup.remove();
    }, 4000);
}

// ── Media Session API (lock screen / background controls) ─────────
function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;

    const song = queue[currentIndex];
    if (!song) return;

    navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.addedBy ? `Added by ${song.addedBy}` : 'SyncBeats',
        album: 'SyncBeats Room',
        artwork: currentVideoId ? [
            { src: `https://i.ytimg.com/vi/${currentVideoId}/mqdefault.jpg`, sizes: '320x180', type: 'image/jpeg' },
            { src: `https://i.ytimg.com/vi/${currentVideoId}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }
        ] : []
    });

    navigator.mediaSession.setActionHandler('play', () => {
        if (ytPlayer) ytPlayer.playVideo();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
        if (ytPlayer) ytPlayer.pauseVideo();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
        if (currentIndex > 0) socket.emit('play-song', { index: currentIndex - 1 });
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
        if (currentIndex < queue.length - 1) socket.emit('next-song');
    });
}

// ── Background Audio Keep-Alive ──────────────────────────────────
// A silent audio context keeps the browser audio session active,
// preventing YouTube from pausing when the tab is backgrounded.
let bgAudioCtx = null;
function initBackgroundAudio() {
    if (bgAudioCtx) return;
    try {
        bgAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        // Create a silent oscillator
        const osc = bgAudioCtx.createOscillator();
        const gain = bgAudioCtx.createGain();
        gain.gain.value = 0.001; // Nearly silent
        osc.connect(gain);
        gain.connect(bgAudioCtx.destination);
        osc.start();
    } catch (e) {
        // AudioContext may not be available
    }
}

// Start the background audio on first user interaction
document.addEventListener('click', () => {
    initBackgroundAudio();
}, { once: true });
