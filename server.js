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

        // Delete room if empty
        if (room.users.length === 0) {
            rooms.delete(socket.roomCode);
            console.log(`🗑️ Room ${socket.roomCode} deleted (empty)`);
        }

        console.log(`🔌 ${socket.username} disconnected from room ${socket.roomCode}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🎧 SyncBeats is running at http://localhost:${PORT}\n`);
});
