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
