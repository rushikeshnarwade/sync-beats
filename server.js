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
app.use(express.json());

// ── YouTube Search API Proxy ──────────────────────────────────────────
// Uses YouTube's own InnerTube API (always available, no API key needed)

app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);

    try {
        // Method 1: YouTube InnerTube API
        const results = await searchInnerTube(query);
        if (results.length > 0) return res.json(results);
    } catch (e) {
        console.error('InnerTube search failed:', e.message);
    }

    try {
        // Method 2: Scrape YouTube search HTML
        const results = await searchYouTubeHTML(query);
        return res.json(results);
    } catch (e) {
        console.error('HTML search failed:', e.message);
        return res.json([]);
    }
});

async function searchInnerTube(query) {
    const response = await fetch('https://www.youtube.com/youtubei/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            context: {
                client: {
                    clientName: 'WEB',
                    clientVersion: '2.20240101.00.00',
                    hl: 'en',
                    gl: 'US'
                }
            },
            query: query
        }),
        signal: AbortSignal.timeout(6000)
    });

    if (!response.ok) throw new Error(`InnerTube: ${response.status}`);
    const data = await response.json();

    // Navigate the nested response structure
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const results = [];
    for (const item of contents) {
        const video = item.videoRenderer;
        if (!video || !video.videoId) continue;

        const title = video.title?.runs?.map(r => r.text).join('') || '';
        const channel = video.ownerText?.runs?.map(r => r.text).join('') || '';
        const duration = video.lengthText?.simpleText || '';

        results.push({
            videoId: video.videoId,
            title,
            channel,
            duration,
            thumbnail: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`
        });

        if (results.length >= 8) break;
    }
    return results;
}

async function searchYouTubeHTML(query) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(6000)
    });

    if (!response.ok) throw new Error(`YT HTML: ${response.status}`);
    const html = await response.text();

    // Extract ytInitialData JSON from the page
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s);
    if (!match) throw new Error('Could not parse YouTube page');

    const data = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const results = [];
    for (const item of contents) {
        const video = item.videoRenderer;
        if (!video || !video.videoId) continue;

        results.push({
            videoId: video.videoId,
            title: video.title?.runs?.map(r => r.text).join('') || '',
            channel: video.ownerText?.runs?.map(r => r.text).join('') || '',
            duration: video.lengthText?.simpleText || '',
            thumbnail: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`
        });

        if (results.length >= 8) break;
    }
    return results;
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

    // Load saved playlist (bulk add)
    socket.on('load-playlist', (data) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !data.songs || !Array.isArray(data.songs)) return;

        for (const song of data.songs) {
            room.queue.push({ videoId: song.videoId, title: song.title, addedBy: socket.username });
        }

        const autoPlay = room.currentIndex === -1 && room.queue.length > 0;
        if (autoPlay) room.currentIndex = 0;

        io.to(socket.roomCode).emit('queue-updated', {
            queue: room.queue,
            currentIndex: room.currentIndex,
            autoPlay
        });
        console.log(`📂 Playlist loaded in ${socket.roomCode}: ${data.songs.length} songs`);
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
