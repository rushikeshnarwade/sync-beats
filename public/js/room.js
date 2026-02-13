// ── SyncBeats — Room Logic ──────────────────────────────────────
// YouTube IFrame API + Socket.io sync + Queue + Chat

const socket = io();

// ── State ──────────────────────────────────────────────────────
let player = null;
let isPlayerReady = false;
let isSyncing = false; // flag to prevent echo when receiving sync events
let queue = [];
let currentIndex = -1;
let username = '';
let roomCode = '';
let unreadChat = 0;
let activeTab = 'queue';
let pendingState = null; // store state to apply once player is ready
let currentVideoId = null;

// ── DOM Elements ────────────────────────────────────────────────
const roomCodeText = document.getElementById('room-code-text');
const copyCodeBtn = document.getElementById('copy-code-btn');
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

    // Initialize YouTube player using direct iframe embed (works on local IPs + mobile)
    initPlayer();

    // Join or create based on action
    if (action === 'create') {
        socket.emit('create-room', { username }, (response) => {
            if (response.success) {
                roomCode = response.code;
                roomCodeText.textContent = roomCode;
                // Update URL without reload
                window.history.replaceState(null, '', `/room.html?room=${roomCode}`);
                addSystemMessage(`You created room ${roomCode}`);
                updateUserList([username]);
            }
        });
    } else {
        socket.emit('join-room', { username, code: roomCode }, (response) => {
            if (response.success) {
                addSystemMessage(`You joined room ${roomCode}`);
                // Apply existing state
                if (response.state) {
                    queue = response.state.queue || [];
                    currentIndex = response.state.currentIndex;
                    renderQueue();
                    updateUserList(response.state.users);

                    if (currentIndex >= 0 && queue[currentIndex]) {
                        const startTime = response.state.currentTime || 0;
                        const shouldPlay = response.state.isPlaying;
                        loadVideo(queue[currentIndex].videoId, startTime, shouldPlay);
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

// ── YouTube Player — Direct Iframe Embed ────────────────────────
// Using direct iframe embed instead of YouTube IFrame JS API
// Reason: YT IFrame JS API fails on local network IPs (192.168.x.x)
// with "Video unavailable" because YouTube blocks the Referer header.
// Direct embed iframes work regardless of the hosting origin.

function initPlayer() {
    // Player is initialized on first video load
    isPlayerReady = true;
}

function loadVideo(videoId, startTime = 0, autoplay = true) {
    playerPlaceholder.classList.add('hidden');
    currentVideoId = videoId;

    // Build YouTube embed URL with all needed parameters
    const params = new URLSearchParams({
        autoplay: autoplay ? '1' : '0',
        controls: '1',
        modestbranding: '1',
        rel: '0',
        playsinline: '1',
        start: Math.floor(startTime).toString(),
        enablejsapi: '1',
        iv_load_policy: '3',
        fs: '1'
    });

    const embedUrl = `https://www.youtube.com/embed/${videoId}?${params.toString()}`;

    // Create or replace iframe
    const existingIframe = playerContainer.querySelector('iframe');
    if (existingIframe) {
        existingIframe.remove();
    }

    const iframe = document.createElement('iframe');
    iframe.id = 'yt-iframe';
    iframe.src = embedUrl;
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.frameBorder = '0';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.style.borderRadius = '10px';

    // Insert before placeholder
    playerContainer.insertBefore(iframe, playerPlaceholder);

    // Update now playing title
    const song = queue[currentIndex];
    if (song) {
        nowPlayingTitle.textContent = song.title;
    }

    updatePlayPauseUI(autoplay);
    renderQueue();
}

function updatePlayPauseUI(isPlaying) {
    playIcon.classList.toggle('hidden', isPlaying);
    pauseIcon.classList.toggle('hidden', !isPlaying);
}

// ── Iframe PostMessage Controls ─────────────────────────────────
// YouTube iframes support postMessage API for basic controls

function postPlayerCommand(command, args) {
    const iframe = document.getElementById('yt-iframe');
    if (!iframe || !iframe.contentWindow) return;

    iframe.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func: command,
        args: args || []
    }), '*');
}

function playerPlay() {
    postPlayerCommand('playVideo');
    updatePlayPauseUI(true);
}

function playerPause() {
    postPlayerCommand('pauseVideo');
    updatePlayPauseUI(false);
}

function playerSeekTo(time) {
    postPlayerCommand('seekTo', [time, true]);
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
        navigator.clipboard.writeText(roomCode).then(() => {
            showToast('Room code copied!', 'success');
        }).catch(() => {
            // Fallback for mobile/non-HTTPS
            const textArea = document.createElement('textarea');
            textArea.value = roomCode;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            textArea.remove();
            showToast('Room code copied!', 'success');
        });
    });

    // Add song
    addSongBtn.addEventListener('click', addSong);
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addSong();
    });

    // Player controls — these use postMessage to control the iframe
    playPauseBtn.addEventListener('click', () => {
        if (currentIndex < 0 || !currentVideoId) return;
        // Toggle: we track state locally since we can't query iframe state reliably
        const isCurrentlyPlaying = pauseIcon.classList.contains('hidden') === false;
        if (isCurrentlyPlaying) {
            playerPause();
            socket.emit('sync-pause', { currentTime: 0 }); // approximate
        } else {
            playerPlay();
            socket.emit('sync-play', { currentTime: 0 }); // approximate
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
        showToast('Invalid YouTube URL. Try pasting a full YouTube link.', 'info');
        return;
    }

    addSongBtn.disabled = true;
    const title = await fetchVideoTitle(videoId);

    socket.emit('add-to-queue', { videoId, title });
    urlInput.value = '';
    addSongBtn.disabled = false;
    urlInput.focus();
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
            loadVideo(queue[currentIndex].videoId);
        }
    });

    // Sync play — reload iframe at correct time and autoplay
    socket.on('sync-play', (data) => {
        if (currentIndex < 0 || !currentVideoId) return;
        if (data.currentTime > 0) {
            // Reload the video at the synced timestamp with autoplay
            loadVideo(currentVideoId, data.currentTime, true);
        } else {
            playerPlay();
        }
    });

    // Sync pause
    socket.on('sync-pause', (data) => {
        if (currentIndex < 0 || !currentVideoId) return;
        playerPause();
    });

    // Sync seek
    socket.on('sync-seek', (data) => {
        if (!currentVideoId) return;
        // Reload at new position
        loadVideo(currentVideoId, data.currentTime, true);
    });

    // Play specific song
    socket.on('play-song', (data) => {
        currentIndex = data.index;
        if (queue[currentIndex]) {
            loadVideo(queue[currentIndex].videoId);
        }
    });

    // Chat message
    socket.on('chat-message', (data) => {
        addChatMessage(data);
        if (activeTab !== 'chat') {
            unreadChat++;
            chatBadge.textContent = unreadChat;
            chatBadge.classList.remove('hidden');
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
      ${i === currentIndex ? `
        <div class="playing-indicator">
          <span></span><span></span><span></span>
        </div>` : ''}
    </div>
  `).join('');

    // Click to play song from queue
    queueList.querySelectorAll('.queue-item').forEach(item => {
        item.addEventListener('click', () => {
            const index = parseInt(item.dataset.index);
            if (index !== currentIndex) {
                socket.emit('play-song', { index });
            }
        });
    });
}

function addChatMessage(data) {
    // Remove empty state if present
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
    // Remove empty state if present
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

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Start ──────────────────────────────────────────────────────
init();
