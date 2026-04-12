require('dotenv').config();
const Discord = require('discord.js');
const { GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const yts = require('yt-search');
const youtubedl = require('youtube-dl-exec');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const prefix = process.env.PREFIX || '!';
const token = process.env.DISCORD_TOKEN;

const client = new Discord.Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const queue = new Map();

client.once('ready', () => {
    console.log(`Bot is online! Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith(prefix)) return;

    const serverQueue = queue.get(message.guild.id);
    const command = message.content.slice(prefix.length).split(' ')[0].toLowerCase();

    switch (command) {
        case 'play':
        case 'p':
            execute(message, serverQueue);
            break;
        case 'skip':
        case 's':
            skip(message, serverQueue);
            break;
        case 'stop':
            stop(message, serverQueue);
            break;
        case 'queue':
        case 'q':
            showQueue(message, serverQueue);
            break;
        case 'pause':
            pause(message, serverQueue);
            break;
        case 'resume':
        case 'r':
            resume(message, serverQueue);
            break;
        case 'nowplaying':
        case 'np':
            nowPlaying(message, serverQueue);
            break;
        case 'volume':
        case 'v':
            setVolume(message, serverQueue);
            break;
        case 'help':
        case 'h':
            showHelp(message);
            break;
        default:
            message.channel.send(`❌ Comando inválido! Use \`${prefix}help\` para ver os comandos disponíveis.`);
    }
});

async function execute(message, serverQueue) {
    const args = message.content.split(' ');
    const voiceChannel = message.member.voice.channel;

    if (!voiceChannel) {
        return message.channel.send('❌ Você precisa estar em um canal de voz para tocar música!');
    }

    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
        return message.channel.send('❌ Eu preciso de permissões para entrar e falar no seu canal de voz!');
    }

    if (!args[1]) {
        return message.channel.send('❌ Por favor, forneça uma URL do YouTube ou um termo de busca!');
    }

    let song = {};
    const searchMsg = await message.channel.send('🔍 Buscando música...');

    try {
        const query = args.slice(1).join(' ');
        console.log(`[DEBUG] Query received: ${query}`);

        // Check if it's a YouTube URL
        const isUrl = query.includes('youtube.com') || query.includes('youtu.be');

        if (isUrl) {
            console.log(`[DEBUG] YouTube URL detected`);
            // Get video info using yt-dlp
            const info = await youtubedl(query, {
                dumpSingleJson: true,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
            });
            song = {
                title: info.title,
                url: query,
                duration: formatDuration(info.duration),
                requestedBy: message.author.tag
            };
            console.log(`[DEBUG] Video info retrieved: ${song.title}`);
        } else {
            // Search for the video using yt-search
            console.log(`[DEBUG] Searching for: ${query}`);
            const searchResults = await yts(query);
            const videos = searchResults.videos;

            if (!videos.length) {
                searchMsg.delete().catch(() => {});
                return message.channel.send('❌ Nenhum vídeo encontrado!');
            }

            const video = videos[0];
            song = {
                title: video.title,
                url: video.url,
                duration: video.timestamp,
                requestedBy: message.author.tag
            };
            console.log(`[DEBUG] Found video: ${song.title} - ${song.url}`);
        }
        searchMsg.delete().catch(() => {});
    } catch (error) {
        console.error('[ERROR] Search/Info error:', error);
        searchMsg.delete().catch(() => {});
        return message.channel.send('❌ Não foi possível encontrar informações do vídeo!');
    }

    if (!serverQueue) {
        const queueContruct = {
            textChannel: message.channel,
            voiceChannel: voiceChannel,
            connection: null,
            player: null,
            songs: [],
            volume: 5,
            playing: true,
        };

        queue.set(message.guild.id, queueContruct);
        queueContruct.songs.push(song);

        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
            });
            queueContruct.connection = connection;
            playSong(message.guild, queueContruct.songs[0]);
        } catch (err) {
            console.error(err);
            queue.delete(message.guild.id);
            return message.channel.send(`❌ Erro ao conectar: ${err.message}`);
        }
    } else {
        serverQueue.songs.push(song);
        return message.channel.send(`✅ **${song.title}** foi adicionada à fila! (Posição: ${serverQueue.songs.length})`);
    }
}

async function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);

    if (!serverQueue) {
        return;
    }

    if (!song) {
        if (serverQueue.connection) {
            serverQueue.connection.destroy();
        }
        queue.delete(guild.id);
        return;
    }

    if (!serverQueue.player) {
        serverQueue.player = createAudioPlayer();
        serverQueue.connection.subscribe(serverQueue.player);

        serverQueue.player.on(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        });

        serverQueue.player.on('error', error => {
            console.error(`[ERROR] Player Error: ${error.message}`);
            serverQueue.textChannel.send('❌ Erro ao reproduzir a música. Pulando para a próxima...');
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        });
    }

    try {
        console.log(`[DEBUG] Attempting to stream: ${song.url}`);

        // Use youtube-dl-exec to get the audio stream and pipe through ffmpeg
        const ytdlProcess = youtubedl.exec(song.url, {
            output: '-',
            quiet: true,
            format: 'bestaudio[ext=webm][acodec=opus]/bestaudio/best',
        }, { stdio: ['ignore', 'pipe', 'pipe'] });

        if (!ytdlProcess.stdout) {
            throw new Error('Não foi possível criar o stream de áudio do yt-dlp');
        }

        // Pipe yt-dlp output through ffmpeg to get proper PCM/Opus audio
        const ffmpegProcess = spawn(ffmpegPath, [
            '-i', 'pipe:0',
            '-analyzeduration', '0',
            '-loglevel', '0',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'ignore'] });

        ytdlProcess.stdout.pipe(ffmpegProcess.stdin);

        // Handle yt-dlp errors
        ytdlProcess.stderr?.on('data', (data) => {
            console.error(`[ERROR] yt-dlp stderr: ${data.toString()}`);
        });

        ytdlProcess.on('error', (error) => {
            console.error(`[ERROR] yt-dlp process error: ${error.message}`);
        });

        ffmpegProcess.on('error', (error) => {
            console.error(`[ERROR] ffmpeg process error: ${error.message}`);
        });

        console.log(`[DEBUG] Stream created, creating audio resource...`);

        const resource = createAudioResource(ffmpegProcess.stdout, {
            inputType: StreamType.Raw,
            inlineVolume: true,
            metadata: {
                title: song.title,
            },
        });

        resource.volume.setVolume(serverQueue.volume / 10);
        serverQueue.player.play(resource);
        serverQueue.playing = true;


        console.log(`[DEBUG] Now playing: ${song.title}`);
        serverQueue.textChannel.send(`🎵 Tocando agora: **${song.title}** [${song.duration || 'N/A'}]\n*Pedido por: ${song.requestedBy}*`);
    } catch (error) {
        console.error(`[ERROR] Stream error: ${error.message}`);
        console.error(`[ERROR] Full error:`, error);
        serverQueue.textChannel.send(`❌ Erro ao iniciar a reprodução: ${error.message}`);
        serverQueue.songs.shift();
        if (serverQueue.songs.length > 0) {
            playSong(guild, serverQueue.songs[0]);
        } else {
            if (serverQueue.connection) {
                serverQueue.connection.destroy();
            }
            queue.delete(guild.id);
        }
    }
}

function skip(message, serverQueue) {
    if (!message.member.voice.channel) {
        return message.channel.send('❌ Você precisa estar em um canal de voz para pular a música!');
    }
    if (!serverQueue || !serverQueue.songs.length) {
        return message.channel.send('❌ Não há música para pular!');
    }
    message.channel.send('⏭️ Música pulada!');
    serverQueue.player.stop();
}

function stop(message, serverQueue) {
    if (!message.member.voice.channel) {
        return message.channel.send('❌ Você precisa estar em um canal de voz para parar a música!');
    }
    if (!serverQueue) {
        return message.channel.send('❌ Não há música tocando!');
    }
    message.channel.send('⏹️ Música parada e fila limpa!');
    serverQueue.songs = [];
    if (serverQueue.player) {
        serverQueue.player.stop();
    }
    if (serverQueue.connection) {
        serverQueue.connection.destroy();
    }
    queue.delete(message.guild.id);
}

function showQueue(message, serverQueue) {
    if (!serverQueue || !serverQueue.songs.length) {
        return message.channel.send('📭 A fila está vazia!');
    }

    const songs = serverQueue.songs;
    let queueMessage = '🎶 **Fila de Músicas:**\n\n';

    songs.forEach((song, index) => {
        if (index === 0) {
            queueMessage += `▶️ **Tocando agora:** ${song.title} [${song.duration || 'N/A'}]\n\n`;
        } else {
            queueMessage += `**${index}.** ${song.title} [${song.duration || 'N/A'}]\n`;
        }
    });

    queueMessage += `\n📊 **Total:** ${songs.length} música(s)`;
    message.channel.send(queueMessage);
}

function pause(message, serverQueue) {
    if (!message.member.voice.channel) {
        return message.channel.send('❌ Você precisa estar em um canal de voz!');
    }
    if (!serverQueue || !serverQueue.player) {
        return message.channel.send('❌ Não há música tocando!');
    }
    if (!serverQueue.playing) {
        return message.channel.send('⏸️ A música já está pausada!');
    }

    serverQueue.player.pause();
    serverQueue.playing = false;
    message.channel.send('⏸️ Música pausada!');
}

function resume(message, serverQueue) {
    if (!message.member.voice.channel) {
        return message.channel.send('❌ Você precisa estar em um canal de voz!');
    }
    if (!serverQueue || !serverQueue.player) {
        return message.channel.send('❌ Não há música para retomar!');
    }
    if (serverQueue.playing) {
        return message.channel.send('▶️ A música já está tocando!');
    }

    serverQueue.player.unpause();
    serverQueue.playing = true;
    message.channel.send('▶️ Música retomada!');
}

function nowPlaying(message, serverQueue) {
    if (!serverQueue || !serverQueue.songs.length) {
        return message.channel.send('❌ Não há música tocando no momento!');
    }

    const song = serverQueue.songs[0];
    message.channel.send(`🎵 **Tocando agora:** ${song.title} [${song.duration || 'N/A'}]\n*Pedido por: ${song.requestedBy}*`);
}

function setVolume(message, serverQueue) {
    const args = message.content.split(' ');

    if (!message.member.voice.channel) {
        return message.channel.send('❌ Você precisa estar em um canal de voz!');
    }

    if (!args[1]) {
        const currentVol = serverQueue ? serverQueue.volume * 10 : 50;
        return message.channel.send(`🔊 Volume atual: **${currentVol}%**\nUse \`${prefix}volume <0-100>\` para alterar.`);
    }

    const volume = parseInt(args[1]);
    if (isNaN(volume) || volume < 0 || volume > 100) {
        return message.channel.send('❌ Por favor, insira um número entre 0 e 100!');
    }

    if (!serverQueue) {
        return message.channel.send('❌ Não há música tocando!');
    }

    serverQueue.volume = volume / 10;
    if (serverQueue.player && serverQueue.player.state.resource) {
        serverQueue.player.state.resource.volume.setVolume(volume / 100);
    }
    message.channel.send(`🔊 Volume alterado para **${volume}%**`);
}

function showHelp(message) {
    const helpMessage = `
🎵 **Comandos do Bot de Música** 🎵

\`${prefix}play <url/nome>\` ou \`${prefix}p\` - Toca uma música do YouTube
\`${prefix}skip\` ou \`${prefix}s\` - Pula a música atual
\`${prefix}stop\` - Para a música e limpa a fila
\`${prefix}queue\` ou \`${prefix}q\` - Mostra a fila de músicas
\`${prefix}pause\` - Pausa a música atual
\`${prefix}resume\` ou \`${prefix}r\` - Retoma a música pausada
\`${prefix}nowplaying\` ou \`${prefix}np\` - Mostra a música atual
\`${prefix}volume <0-100>\` ou \`${prefix}v\` - Ajusta o volume
\`${prefix}help\` ou \`${prefix}h\` - Mostra esta mensagem

**Exemplos:**
\`${prefix}play never gonna give you up\`
\`${prefix}play https://youtube.com/watch?v=...\`
\`${prefix}volume 50\`
`;
    message.channel.send(helpMessage);
}

function formatDuration(seconds) {
    if (!seconds) return 'N/A';
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

client.login(token);