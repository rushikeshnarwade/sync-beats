// ── SyncBeats — Homepage Logic ──────────────────────────────────
const socket = io();

const usernameInput = document.getElementById('username-input');
const goBtn = document.getElementById('go-btn');
const roomCodeInput = document.getElementById('room-code-input');
const errorToast = document.getElementById('error-toast');

// Pre-fill username from localStorage if saved
const savedName = localStorage.getItem('syncbeats-username');
if (savedName) {
    usernameInput.value = savedName;
}

// Pre-fill last room code from localStorage
const lastRoom = localStorage.getItem('syncbeats-last-room');
if (lastRoom) {
    roomCodeInput.value = lastRoom;
}

// Auto-focus: if name is saved, focus room code; otherwise focus name
if (savedName) {
    roomCodeInput.focus();
} else {
    usernameInput.focus();
}

// Auto-uppercase room code + update button label dynamically
roomCodeInput.addEventListener('input', () => {
    roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    updateButtonLabel();
});

function updateButtonLabel() {
    const code = roomCodeInput.value.trim();
    const span = goBtn.querySelector('span');
    span.textContent = code.length > 0 ? 'Join Room' : 'Create Room';
}

// Set label on load
updateButtonLabel();

function getUsername() {
    const name = usernameInput.value.trim();
    if (!name) {
        showError('Please enter your name first!');
        usernameInput.focus();
        return null;
    }
    return name;
}

function showError(msg) {
    errorToast.textContent = msg;
    errorToast.classList.remove('hidden');
    clearTimeout(errorToast._timer);
    errorToast._timer = setTimeout(() => errorToast.classList.add('hidden'), 3000);
}

// Smart button: create or join based on room code
goBtn.addEventListener('click', handleGo);

function handleGo() {
    const username = getUsername();
    if (!username) return;

    const code = roomCodeInput.value.trim().toUpperCase();

    if (code) {
        // Join existing room
        if (code.length < 4) {
            showError('Room code must be at least 4 characters');
            roomCodeInput.focus();
            return;
        }

        goBtn.disabled = true;
        goBtn.querySelector('span').textContent = 'Joining...';

        socket.emit('join-room', { username, code }, (response) => {
            if (response.success) {
                sessionStorage.setItem('syncbeats-username', username);
                localStorage.setItem('syncbeats-username', username);
                sessionStorage.setItem('syncbeats-action', 'join');
                window.location.href = `/room.html?room=${code}`;
            } else {
                showError(response.error || 'Room not found');
                goBtn.disabled = false;
                updateButtonLabel();
            }
        });
    } else {
        // Create new room
        goBtn.disabled = true;
        goBtn.querySelector('span').textContent = 'Creating...';

        socket.emit('create-room', { username }, (response) => {
            if (response.success) {
                sessionStorage.setItem('syncbeats-username', username);
                localStorage.setItem('syncbeats-username', username);
                sessionStorage.setItem('syncbeats-action', 'create');
                window.location.href = `/room.html?room=${response.code}`;
            } else {
                showError('Failed to create room. Try again.');
                goBtn.disabled = false;
                updateButtonLabel();
            }
        });
    }
}

// Enter key handling
usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (usernameInput.value.trim()) {
            roomCodeInput.focus();
        }
    }
});

roomCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleGo();
});

// ── Saved Playlists Logic ───────────────────────────────────────
const playlistsSection = document.getElementById('playlists-section');
const playlistsGrid = document.getElementById('playlists-grid');
const modal = document.getElementById('playlist-modal');
const modalTitle = document.getElementById('modal-playlist-name');
const modalInfo = document.getElementById('modal-playlist-info');
const modalNewRoomBtn = document.getElementById('modal-new-room-btn');
const modalRejoinBtn = document.getElementById('modal-rejoin-btn');
const modalDeleteBtn = document.getElementById('modal-delete-btn');
const modalCloseBtn = document.getElementById('modal-close-btn');

let selectedPlaylist = null;

function loadPlaylists() {
    const playlists = JSON.parse(localStorage.getItem('syncbeats-playlists') || '[]');
    if (playlists.length === 0) {
        playlistsSection.classList.add('hidden');
        return;
    }

    playlistsSection.classList.remove('hidden');
    playlistsGrid.innerHTML = playlists.map(p => `
        <div class="glass-card playlist-card" onclick="openPlaylistModal('${p.id}')">
            <div class="playlist-icon">💾</div>
            <div class="playlist-info">
                <h3>${escapeHtml(p.name)}</h3>
                <p>${p.songs.length} songs • ${new Date(p.createdAt).toLocaleDateString()}</p>
            </div>
        </div>
    `).join('');
}

// Global scope for onclick
window.openPlaylistModal = (id) => {
    const playlists = JSON.parse(localStorage.getItem('syncbeats-playlists') || '[]');
    selectedPlaylist = playlists.find(p => p.id === id);
    if (!selectedPlaylist) return;

    modalTitle.textContent = selectedPlaylist.name;
    modalInfo.textContent = `${selectedPlaylist.songs.length} songs • Originally in room ${selectedPlaylist.roomCode}`;
    modalRejoinBtn.querySelector('span').textContent = `Rejoin Room ${selectedPlaylist.roomCode}`;

    modal.classList.remove('hidden');
};

function closeModal() {
    modal.classList.add('hidden');
    selectedPlaylist = null;
}

modalCloseBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
});

// Load playlist -> New Room
modalNewRoomBtn.addEventListener('click', () => {
    if (!selectedPlaylist) return;
    const username = getUsername();
    if (!username) return;

    // Create room
    socket.emit('create-room', { username }, (response) => {
        if (response.success) {
            sessionStorage.setItem('syncbeats-username', username);
            sessionStorage.setItem('syncbeats-action', 'create');

            // Store playlist to be loaded in the new room
            sessionStorage.setItem('syncbeats-pending-playlist', JSON.stringify(selectedPlaylist));

            window.location.href = `/room.html?room=${response.code}`;
        }
    });
});

// Load playlist -> Rejoin Original Room
modalRejoinBtn.addEventListener('click', () => {
    if (!selectedPlaylist) return;
    const username = getUsername();
    if (!username) return;

    // Check if room code is valid format
    const code = selectedPlaylist.roomCode;

    // Join room
    socket.emit('join-room', { username, code }, (response) => {
        if (response.success) {
            sessionStorage.setItem('syncbeats-username', username);
            sessionStorage.setItem('syncbeats-action', 'join');

            // Store playlist to be loaded
            sessionStorage.setItem('syncbeats-pending-playlist', JSON.stringify(selectedPlaylist));

            window.location.href = `/room.html?room=${code}`;
        } else {
            // Room might verify expired/deleted, ask to create new
            if (confirm(`Room ${code} no longer exists. Create a new room with this playlist?`)) {
                modalNewRoomBtn.click();
            }
        }
    });
});

modalDeleteBtn.addEventListener('click', () => {
    if (!selectedPlaylist || !confirm(`Delete playlist "${selectedPlaylist.name}"?`)) return;

    const playlists = JSON.parse(localStorage.getItem('syncbeats-playlists') || '[]');
    const newPlaylists = playlists.filter(p => p.id !== selectedPlaylist.id);
    localStorage.setItem('syncbeats-playlists', JSON.stringify(newPlaylists));

    closeModal();
    loadPlaylists();
    showError('Playlist deleted');
});

function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Initial load
loadPlaylists();
