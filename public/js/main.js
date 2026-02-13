// ── SyncBeats — Homepage Logic ──────────────────────────────────
const socket = io();

const usernameInput = document.getElementById('username-input');
const createBtn = document.getElementById('create-room-btn');
const joinBtn = document.getElementById('join-room-btn');
const roomCodeInput = document.getElementById('room-code-input');
const errorToast = document.getElementById('error-toast');

// Pre-fill username from localStorage if saved
const savedName = localStorage.getItem('syncbeats-username');
if (savedName) {
    usernameInput.value = savedName;
}

// Auto-focus username input
usernameInput.focus();

// Auto-uppercase room code
roomCodeInput.addEventListener('input', () => {
    roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

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

// Create Room
createBtn.addEventListener('click', () => {
    const username = getUsername();
    if (!username) return;

    createBtn.disabled = true;
    createBtn.querySelector('span').textContent = 'Creating...';

    socket.emit('create-room', { username }, (response) => {
        if (response.success) {
            // Store username for room page
            sessionStorage.setItem('syncbeats-username', username);
            localStorage.setItem('syncbeats-username', username);
            sessionStorage.setItem('syncbeats-action', 'create');
            window.location.href = `/room.html?room=${response.code}`;
        } else {
            showError('Failed to create room. Try again.');
            createBtn.disabled = false;
            createBtn.querySelector('span').textContent = 'Create Room';
        }
    });
});

// Join Room
joinBtn.addEventListener('click', attemptJoin);
roomCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptJoin();
});

function attemptJoin() {
    const username = getUsername();
    if (!username) return;

    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code || code.length < 4) {
        showError('Please enter a valid room code');
        roomCodeInput.focus();
        return;
    }

    joinBtn.disabled = true;
    joinBtn.querySelector('span').textContent = 'Joining...';

    socket.emit('join-room', { username, code }, (response) => {
        if (response.success) {
            sessionStorage.setItem('syncbeats-username', username);
            localStorage.setItem('syncbeats-username', username);
            sessionStorage.setItem('syncbeats-action', 'join');
            window.location.href = `/room.html?room=${code}`;
        } else {
            showError(response.error || 'Room not found');
            joinBtn.disabled = false;
            joinBtn.querySelector('span').textContent = 'Join';
        }
    });
}

// Allow Enter key on username to move to next action
usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (roomCodeInput.value.trim()) {
            attemptJoin();
        } else {
            roomCodeInput.focus();
        }
    }
});
