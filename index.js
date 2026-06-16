const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, NoSubscriberBehavior } = require('@discordjs/voice');
const express = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');

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
app.listen(PORT, () => console.log(`Web Server รันบนพอร์ต ${PORT}`));

let VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || '1272435838470455371';
let GUILD_ID = process.env.GUILD_ID || '1272435838470455366';
let voiceConnection = null;
let audioPlayer = null;

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log(`ffmpeg path: ${ffmpegPath}`);

    // สร้าง player ตัวเดียวใช้ตลอด
    audioPlayer = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });

    audioPlayer.on('error', err => console.error('Player error:', err.message));
    audioPlayer.on(AudioPlayerStatus.Playing, () => console.log('▶ Playing'));
    audioPlayer.on(AudioPlayerStatus.Idle, () => console.log('⏹ Idle'));

    connectToVoice();
});

function connectToVoice() {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return console.error("ไม่พบเซิร์ฟเวอร์");
    const channel = guild.channels.cache.get(VOICE_CHANNEL_ID);
    if (!channel) return console.error("ไม่พบห้อง Voice");
    try {
        voiceConnection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfMute: false,
            selfDeaf: false
        });
        voiceConnection.subscribe(audioPlayer);
        console.log(`บอทเข้าห้อง ${channel.name} แล้ว!`);
    } catch (error) {
        console.error("เกิดข้อผิดพลาด:", error);
    }
}

client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.member.id === client.user.id && !newState.channelId) {
        console.log("บอทหลุด กำลังเชื่อมต่อใหม่...");
        setTimeout(() => connectToVoice(), 5000);
    }
});

// ===============================================
// Helper: Download จาก Google Drive
// ===============================================
async function downloadFromDrive(fileId, destPath) {
    const url = `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
    console.log(`Downloading: ${fileId}`);
    const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        timeout: 30000,
        maxRedirects: 10,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);
        writer.on('finish', () => {
            const size = fs.statSync(destPath).size;
            console.log(`Downloaded: ${size} bytes`);
            resolve(size);
        });
        writer.on('error', reject);
    });
}

// ===============================================
// Helper: เล่นไฟล์ด้วย ffmpeg → Ogg/Opus
// ===============================================
function playFile(filePath) {
    return new Promise((resolve, reject) => {
        // แปลงเป็น ogg/opus ก่อนแล้วเล่น ไม่ต้องใช้ @discordjs/opus
        const outPath = filePath.replace('.mp3', '.ogg');

        const ff = spawn(ffmpegPath, [
            '-i', filePath,
            '-c:a', 'libopus',
            '-b:a', '96k',
            '-vbr', 'on',
            '-ar', '48000',
            '-ac', '2',
            '-y',
            outPath
        ]);

        ff.stderr.on('data', d => console.log('ffmpeg:', d.toString().trim()));

        ff.on('close', (code) => {
            try { fs.unlinkSync(filePath); } catch (_) {}

            if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`));

            const resource = createAudioResource(outPath, {
                inputType: StreamType.OggOpus,
            });

            audioPlayer.play(resource);
            console.log('Playing ogg/opus...');

            const onIdle = () => {
                try { fs.unlinkSync(outPath); } catch (_) {}
                audioPlayer.removeListener(AudioPlayerStatus.Idle, onIdle);
                resolve();
            };
            audioPlayer.once(AudioPlayerStatus.Idle, onIdle);
        });

        ff.on('error', reject);
    });
}

// ===============================================
// API: Status
// ===============================================
app.get('/status', (req, res) => {
    res.json({
        connected: !!voiceConnection,
        guildId: GUILD_ID,
        channelId: VOICE_CHANNEL_ID,
        botTag: client.user ? client.user.tag : null
    });
});

// ===============================================
// API: เชื่อมต่อห้อง
// ===============================================
app.post('/connect', (req, res) => {
    const { guildId, channelId } = req.body;
    if (!guildId || !channelId) return res.status(400).json({ error: 'กรุณาส่ง guildId และ channelId' });
    GUILD_ID = guildId;
    VOICE_CHANNEL_ID = channelId;
    if (voiceConnection) { voiceConnection.destroy(); voiceConnection = null; }
    connectToVoice();
    res.json({ success: true, message: 'เชื่อมต่อห้องใหม่แล้ว!' });
});

// ===============================================
// API: เล่นเสียงจาก Google Drive
// ===============================================
app.post('/play', async (req, res) => {
    const { driveId } = req.body;
    if (!driveId) return res.status(400).json({ error: 'กรุณาส่ง driveId' });
    if (!voiceConnection) return res.status(503).json({ error: 'บอทยังไม่ได้เชื่อมต่อห้องเสียง' });

    const outputPath = `/tmp/sound_${Date.now()}.mp3`;

    try {
        const size = await downloadFromDrive(driveId, outputPath);
        if (size < 1000) throw new Error('ไฟล์เล็กเกินไป อาจไม่ใช่ MP3');
        res.json({ success: true, message: 'กำลังเล่นเสียง!' });
        await playFile(outputPath);
    } catch (error) {
        console.error('Play Error:', error.message);
        try { fs.unlinkSync(outputPath); } catch (_) {}
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

// ===============================================
// API: TTS
// ===============================================
app.post('/speak', async (req, res) => {
    const { text, lang } = req.body;
    if (!text) return res.status(400).json({ error: 'กรุณาส่ง text' });
    if (!voiceConnection) return res.status(503).json({ error: 'บอทยังไม่ได้เชื่อมต่อห้องเสียง' });

    const outputPath = `/tmp/speech_${Date.now()}.mp3`;
    const language = lang || 'th';

    try {
        execSync(`gtts-cli "${text.replace(/"/g, "'")}" --lang ${language} --output ${outputPath}`);
        res.json({ success: true, message: `กำลังพูด: "${text}"` });
        await playFile(outputPath);
    } catch (error) {
        console.error('TTS Error:', error.message);
        try { fs.unlinkSync(outputPath); } catch (_) {}
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

client.login(process.env.DISCORD_TOKEN);
