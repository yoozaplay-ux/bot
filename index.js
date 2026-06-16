// ✅ ต้อง require opus และ set ffmpeg path ก่อนเสมอ
require('@discordjs/opus');
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

const { Client, GatewayIntentBits } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    StreamType,
    entersState,
    VoiceConnectionStatus
} = require('@discordjs/voice');
const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Web Server กำลังรันบนพอร์ต ${PORT}`);
});

let VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || '';
let GUILD_ID = process.env.GUILD_ID || '';
let voiceConnection = null;
let currentPlayer = null;

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    if (GUILD_ID && VOICE_CHANNEL_ID) {
        connectToVoice();
    }
});

async function connectToVoice() {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return console.error("❌ ไม่พบเซิร์ฟเวอร์ที่ระบุ");
    const channel = guild.channels.cache.get(VOICE_CHANNEL_ID);
    if (!channel) return console.error("❌ ไม่พบห้อง Voice ที่ระบุ");

    try {
        if (voiceConnection) {
            voiceConnection.destroy();
            voiceConnection = null;
        }

        voiceConnection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfMute: false,
            selfDeaf: false
        });

        // ✅ รอให้เชื่อมต่อสำเร็จจริง ๆ
        await entersState(voiceConnection, VoiceConnectionStatus.Ready, 15_000);
        console.log(`✅ บอทเข้าห้อง "${channel.name}" เรียบร้อย!`);

        voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(voiceConnection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
            } catch {
                console.log('🔄 หลุดจากห้อง กำลังเชื่อมต่อใหม่...');
                voiceConnection.destroy();
                voiceConnection = null;
                setTimeout(() => connectToVoice(), 5000);
            }
        });

    } catch (error) {
        console.error("❌ เกิดข้อผิดพลาดในการเข้าห้องเสียง:", error);
        if (voiceConnection) {
            voiceConnection.destroy();
            voiceConnection = null;
        }
    }
}

// ===============================================
// Helper: Download จาก Google Drive (แก้ไขให้ถูกต้อง)
// ===============================================
function downloadFromDrive(fileId, destPath) {
    return new Promise((resolve, reject) => {
        // ✅ วิธีที่ถูกต้อง: ดึง confirm token จาก cookie ก่อน แล้ว download จริง
        const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

        const follow = (currentUrl, redirectCount = 0, cookies = '') => {
            if (redirectCount > 15) return reject(new Error('Too many redirects'));

            const mod = currentUrl.startsWith('https') ? https : http;
            const urlObj = new URL(currentUrl);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    ...(cookies ? { 'Cookie': cookies } : {})
                }
            };

            const req = mod.get(options, (res) => {
                console.log(`[${res.statusCode}] ${currentUrl.substring(0, 80)}`);

                // จัดการ redirect
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const location = res.headers.location;
                    if (!location) return reject(new Error('Redirect without location'));
                    const newCookies = parseCookies(res.headers['set-cookie'], cookies);
                    res.resume();
                    return follow(
                        location.startsWith('http') ? location : `https://drive.google.com${location}`,
                        redirectCount + 1,
                        newCookies
                    );
                }

                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                // ✅ ตรวจสอบว่าได้ HTML (virus warning) หรือ binary จริง
                const contentType = res.headers['content-type'] || '';
                if (contentType.includes('text/html')) {
                    // รวบรวม HTML เพื่อหา confirm token
                    let html = '';
                    res.on('data', chunk => { html += chunk.toString(); });
                    res.on('end', () => {
                        // หา confirm token ใน HTML
                        const match = html.match(/confirm=([0-9A-Za-z_\-]+)/);
                        if (match) {
                            const confirmUrl = `https://drive.google.com/uc?export=download&confirm=${match[1]}&id=${fileId}`;
                            const newCookies = parseCookies(res.headers['set-cookie'], cookies);
                            console.log(`🔑 Found confirm token, retrying...`);
                            return follow(confirmUrl, redirectCount + 1, newCookies);
                        }
                        // ลอง UUID-based confirm token (Google Drive ใหม่)
                        const uuidMatch = html.match(/uuid=([^&"]+)/);
                        if (uuidMatch) {
                            const confirmUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t&uuid=${uuidMatch[1]}`;
                            return follow(confirmUrl, redirectCount + 1, cookies);
                        }
                        reject(new Error('ได้รับ HTML แทน binary — ไฟล์อาจ private หรือ link ผิด'));
                    });
                    return;
                }

                // ✅ เป็น binary จริง — บันทึกไฟล์
                const file = fs.createWriteStream(destPath);
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    // ตรวจสอบขนาดไฟล์
                    const stat = fs.statSync(destPath);
                    if (stat.size < 1000) {
                        fs.unlinkSync(destPath);
                        return reject(new Error(`ไฟล์เล็กเกินไป (${stat.size} bytes) — อาจ download ไม่สำเร็จ`));
                    }
                    console.log(`✅ Downloaded ${stat.size} bytes`);
                    resolve();
                });
                file.on('error', reject);
            });

            req.on('error', reject);
        };

        follow(initialUrl);
    });
}

function parseCookies(setCookieHeader, existingCookies = '') {
    if (!setCookieHeader) return existingCookies;
    const newCookies = Array.isArray(setCookieHeader)
        ? setCookieHeader.map(c => c.split(';')[0]).join('; ')
        : setCookieHeader.split(';')[0];
    return existingCookies ? `${existingCookies}; ${newCookies}` : newCookies;
}

// ===============================================
// Helper: เล่นเสียงจากไฟล์
// ===============================================
function playAudio(filePath) {
    return new Promise((resolve, reject) => {
        if (!voiceConnection) return reject(new Error('บอทยังไม่ได้เชื่อมต่อกับห้องเสียง'));

        // หยุดเสียงเดิมก่อน
        if (currentPlayer) {
            currentPlayer.stop(true);
        }

        const player = createAudioPlayer();
        currentPlayer = player;

        // ✅ ระบุ inputType เป็น OggOpus หรือ Arbitrary (ffmpeg จะแปลงให้)
        const resource = createAudioResource(filePath, {
            inputType: StreamType.Arbitrary,
        });

        voiceConnection.subscribe(player);
        player.play(resource);

        player.on(AudioPlayerStatus.Idle, () => {
            currentPlayer = null;
            try { fs.unlinkSync(filePath); } catch (_) {}
            resolve();
        });

        player.on('error', (err) => {
            currentPlayer = null;
            try { fs.unlinkSync(filePath); } catch (_) {}
            reject(err);
        });
    });
}

// ===============================================
// API: สถานะ
// ===============================================
app.get('/status', (req, res) => {
    res.json({
        connected: !!(voiceConnection &&
            voiceConnection.state.status === VoiceConnectionStatus.Ready),
        guildId: GUILD_ID,
        channelId: VOICE_CHANNEL_ID,
        botTag: client.user ? client.user.tag : null
    });
});

// ===============================================
// API: เชื่อมต่อห้อง
// ===============================================
app.post('/connect', async (req, res) => {
    const { guildId, channelId } = req.body;
    if (!guildId || !channelId) {
        return res.status(400).json({ error: 'กรุณาส่ง guildId และ channelId' });
    }
    GUILD_ID = guildId;
    VOICE_CHANNEL_ID = channelId;

    try {
        await connectToVoice();
        res.json({ success: true, message: 'เชื่อมต่อห้องใหม่เรียบร้อยแล้ว!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===============================================
// API: เล่นเสียงจาก Google Drive
// ===============================================
app.post('/play', async (req, res) => {
    const { driveId } = req.body;
    if (!driveId) return res.status(400).json({ error: 'กรุณาส่ง driveId มาด้วย' });
    if (!voiceConnection) return res.status(503).json({ error: 'บอทยังไม่ได้เชื่อมต่อกับห้องเสียง' });

    const outputPath = `/tmp/sound_${Date.now()}.mp3`;

    try {
        console.log(`⬇️ Downloading Drive ID: ${driveId}`);
        await downloadFromDrive(driveId, outputPath);

        res.json({ success: true, message: 'กำลังเล่นเสียง!' });

        // เล่นหลัง response (ไม่รอให้เล่นเสร็จ)
        playAudio(outputPath).catch(err => {
            console.error('Play error:', err.message);
        });

    } catch (error) {
        console.error('❌ Play Error:', error.message);
        try { fs.unlinkSync(outputPath); } catch (_) {}
        res.status(500).json({ error: 'เกิดข้อผิดพลาด', detail: error.message });
    }
});

// ===============================================
// API: TTS (Text-to-Speech)
// ===============================================
app.post('/speak', async (req, res) => {
    const { text, lang } = req.body;
    if (!text) return res.status(400).json({ error: 'กรุณาส่ง text มาด้วย' });
    if (!voiceConnection) return res.status(503).json({ error: 'บอทยังไม่ได้เชื่อมต่อกับห้องเสียง' });

    const outputPath = `/tmp/speech_${Date.now()}.mp3`;
    const language = lang || 'th';

    try {
        // ✅ ใช้ python3 -m gtts แทน gtts-cli เพื่อความเสถียร
        const safeText = text.replace(/"/g, "'").replace(/\\/g, '');
        execSync(`python3 -m gtts "${safeText}" --lang ${language} --output ${outputPath}`, {
            timeout: 15000
        });

        // ตรวจสอบว่าไฟล์มีจริง
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 100) {
            throw new Error('TTS สร้างไฟล์เสียงไม่สำเร็จ');
        }

        res.json({ success: true, message: `กำลังพูด: "${text}"` });

        playAudio(outputPath).catch(err => {
            console.error('TTS play error:', err.message);
        });

    } catch (error) {
        console.error('❌ TTS Error:', error.message);
        try { fs.unlinkSync(outputPath); } catch (_) {}
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการแปลงเสียง', detail: error.message });
    }
});

client.login(process.env.DISCORD_TOKEN);
