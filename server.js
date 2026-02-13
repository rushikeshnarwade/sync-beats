const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── YouTube Search API Proxy ──────────────────────────────────────────
// Uses Invidious instances (no API key needed) with Piped fallback
const INVIDIOUS_INSTANCES = [
    'https://vid.puffyan.us',
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de'
];

app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);

    // Try Invidious instances
    for (const instance of INVIDIOUS_INSTANCES) {
        try {
            const url = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
            const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
            if (!response.ok) continue;
            const data = await response.json();
            const results = data.slice(0, 8).map(v => ({
                videoId: v.videoId,
                title: v.title,
                channel: v.author,
                duration: formatDuration(v.lengthSeconds),
                thumbnail: v.videoThumbnails?.[4]?.url || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`
            }));
            return res.json(results);
        } catch (e) { /* try next instance */ }
    }

    // Fallback: Piped API
    try {
        const url = `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(query)}&filter=videos`;
        const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
        const data = await response.json();
        const results = (data.items || []).slice(0, 8).map(v => ({
            videoId: v.url?.replace('/watch?v=', ''),
            title: v.title,
            channel: v.uploaderName,
            duration: formatDuration(v.duration),
            thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.url?.replace('/watch?v=', '')}/mqdefault.jpg`
        }));
        return res.json(results);
    } catch (e) {
        return res.json([]);
    }
});

function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── In-memory room store ──────────────────────────────────────────────
const rooms = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1 to avoid confusion
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function createRoom(hostName) {
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));
    rooms.set(code, {
        code,
        host: null, // will be set to socket id
        users: [],
        queue: [],
        currentIndex: -1,
        isPlaying: false,
        currentTime: 0,
        lastSyncTimestamp: Date.now()
    });
    return code;
}

// ── Socket.io events ──────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`⚡ Connected: ${socket.id}`);

    // Create a room
    socket.on('create-room', (data, callback) => {
        const code = createRoom(data.username);
        const room = rooms.get(code);
        room.host = socket.id;
        room.users.push({ id: socket.id, username: data.username });
        socket.join(code);
        socket.roomCode = code;
        socket.username = data.username;
        callback({ success: true, code });
        console.log(`🎵 Room ${code} created by ${data.username}`);
    });

    // Join a room
    socket.on('join-room', (data, callback) => {
        const code = data.code.toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) {
            callback({ success: false, error: 'Room not found. Check the code and try again.' });
            return;
        }
        room.users.push({ id: socket.id, username: data.username });
        // Cancel expiry timer if room was going to be cleaned up
        if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = null;
        }
        socket.join(code);
        socket.roomCode = code;
        socket.username = data.username;

        // Calculate actual current time if playing
        let currentTime = room.currentTime;
        if (room.isPlaying) {
            const elapsed = (Date.now() - room.lastSyncTimestamp) / 1000;
            currentTime += elapsed;
        }

        callback({
            success: true,
            state: {
                queue: room.queue,
                currentIndex: room.currentIndex,
                isPlaying: room.isPlaying,
                currentTime,
                users: room.users.map(u => u.username)
            }
        });

        socket.to(code).emit('user-joined', { username: data.username, users: room.users.map(u => u.username) });
        console.log(`👋 ${data.username} joined room ${code}`);
    });

    // Add song to queue
    socket.on('add-to-queue', (data) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;
        const song = { videoId: data.videoId, title: data.title, addedBy: socket.username };
        room.queue.push(song);

        // If this is the first song, auto-play it
        const autoPlay = room.currentIndex === -1;
        if (autoPlay) room.currentIndex = 0;

        io.to(socket.roomCode).emit('queue-updated', {
            queue: room.queue,
            currentIndex: room.currentIndex,
            autoPlay
        });
        console.log(`🎶 Song added to ${socket.roomCode}: ${data.title}`);
    });

    // Sync play
    socket.on('sync-play', (data) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;
        room.isPlaying = true;
        room.currentTime = data.currentTime;
        room.lastSyncTimestamp = Date.now();
        socket.to(socket.roomCode).emit('sync-play', { currentTime: data.currentTime, by: socket.username });
    });

    // Sync pause
    socket.on('sync-pause', (data) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;
        room.isPlaying = false;
        room.currentTime = data.currentTime;
        room.lastSyncTimestamp = Date.now();
        socket.to(socket.roomCode).emit('sync-pause', { currentTime: data.currentTime, by: socket.username });
    });

    // Sync seek
    socket.on('sync-seek', (data) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;
        room.currentTime = data.currentTime;
        room.lastSyncTimestamp = Date.now();
        socket.to(socket.roomCode).emit('sync-seek', { currentTime: data.currentTime, by: socket.username });
    });

    // Play specific song from queue
    socket.on('play-song', (data) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;
        room.currentIndex = data.index;
        room.currentTime = 0;
        room.isPlaying = true;
        room.lastSyncTimestamp = Date.now();
        io.to(socket.roomCode).emit('play-song', { index: data.index, by: socket.username });
    });

    // Skip to next song
    socket.on('next-song', () => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.currentIndex >= room.queue.length - 1) return;
        room.currentIndex++;
        room.currentTime = 0;
        room.isPlaying = true;
        room.lastSyncTimestamp = Date.now();
        io.to(socket.roomCode).emit('play-song', { index: room.currentIndex, by: socket.username });
    });

    // Reorder queue
    socket.on('reorder-queue', (data) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;
        const { fromIndex, toIndex } = data;
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= room.queue.length || toIndex >= room.queue.length) return;

        // Move the song
        const [moved] = room.queue.splice(fromIndex, 1);
        room.queue.splice(toIndex, 0, moved);

        // Update currentIndex if it was affected
        if (room.currentIndex === fromIndex) {
            room.currentIndex = toIndex;
        } else if (fromIndex < room.currentIndex && toIndex >= room.currentIndex) {
            room.currentIndex--;
        } else if (fromIndex > room.currentIndex && toIndex <= room.currentIndex) {
            room.currentIndex++;
        }

        io.to(socket.roomCode).emit('queue-reordered', {
            queue: room.queue,
            currentIndex: room.currentIndex
        });
    });

    // Chat message
    socket.on('chat-message', (data) => {
        io.to(socket.roomCode).emit('chat-message', {
            username: socket.username,
            message: data.message,
            timestamp: Date.now()
        });
    });

    // Disconnect
    socket.on('disconnect', () => {
        if (!socket.roomCode) return;
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        room.users = room.users.filter(u => u.id !== socket.id);
        io.to(socket.roomCode).emit('user-left', {
            username: socket.username,
            users: room.users.map(u => u.username)
        });

        // Keep room alive for 30 min when empty so users can rejoin
        if (room.users.length === 0) {
            // Clear any existing cleanup timer
            if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
            room.cleanupTimer = setTimeout(() => {
                const r = rooms.get(socket.roomCode);
                if (r && r.users.length === 0) {
                    rooms.delete(socket.roomCode);
                    console.log(`🗑️ Room ${socket.roomCode} expired after 30 min`);
                }
            }, 30 * 60 * 1000); // 30 minutes
            console.log(`⏳ Room ${socket.roomCode} is empty — will expire in 30 min`);
        }

        console.log(`🔌 ${socket.username} disconnected from room ${socket.roomCode}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🎧 SyncBeats is running at http://localhost:${PORT}\n`);
});
