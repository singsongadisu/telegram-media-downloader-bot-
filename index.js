/**
 * Load environment variables from .env file
 * This makes sensitive configuration available via process.env
 */
require('dotenv').config();

// Import required Node.js modules
const TelegramBot = require('node-telegram-bot-api'); // Main Telegram bot library
const { exec, execSync } = require('child_process'); // For executing shell commands
const fs = require('fs'); // File system operations
const path = require('path'); // Path manipulation
const crypto = require('crypto'); // Cryptographic functions (for generating session IDs)
const readline = require('readline'); // Reading command line output

/**
 * Configuration Constants
 * These values control the bot's behavior and should be modified carefully
 */

// Get bot token from environment variables (more secure than hardcoding)
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  // Fail fast if token is missing
  console.error('Missing BOT_TOKEN environment variable');
  process.exit(1);
}

// Define folder for downloaded files (creates in project root/downloads)
const DOWNLOAD_FOLDER = path.join(__dirname, 'downloads');

/**
 * Determine yt-dlp executable path based on operating system
 * - Windows: Uses bundled yt-dlp.exe in tools folder
 * - Other OS: Assumes yt-dlp is installed system-wide
 */
const YT_DLP_PATH = process.platform === 'win32' 
    ? path.join(__dirname, 'tools', 'yt-dlp.exe')
    : 'yt-dlp';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB (Telegram's file size limit for bots)
const PROGRESS_UPDATE_INTERVAL = 3000; // Update progress every 3 seconds (3000ms)
const MIN_PROGRESS_CHANGE = 5; // Only update if progress changes by at least 5%

/**
 * Ensure downloads directory exists
 * Creates the folder if it doesn't exist, including parent directories
 */
if (!fs.existsSync(DOWNLOAD_FOLDER)) {
    fs.mkdirSync(DOWNLOAD_FOLDER, { recursive: true });
}

/**
 * Initialize Telegram Bot
 * Uses long-polling method to receive updates
 */
const bot = new TelegramBot(TOKEN, {
    polling: {
        interval: 300, // Check for updates every 300ms
        autoStart: true, // Start polling immediately
        params: {
            timeout: 10 // HTTP request timeout in seconds
        }
    },
    request: {
        timeout: 60000 // 60 second timeout for API requests
    }
});

/**
 * Emoji Constants
 * Centralized emoji definitions for consistent usage throughout the bot
 */
const EMOJI = {
    WAVE: '👋', MUSIC: '🎵', VIDEO: '🎬', DOWNLOAD: '⏬',
    UPLOAD: '📤', SUCCESS: '✅', ERROR: '❌', WARNING: '⚠️',
    OPTIONS: '⚙️', LINK: '🔗', CLOCK: '⏳', TRASH: '🗑️',
    HEART: '❤️', PROGRESS: '📊', INFO: 'ℹ️', GLOBE: '🌐',
    AUDIO: '🎧', BITRATE: '🔊', QUALITY: '📶', CANCEL: '❌'
};

/**
 * Text Formatting Utilities
 * Helper functions for HTML formatting in Telegram messages
 */
const fmt = {
    // Wraps text in Telegram's bold HTML tags
    bold: (text) => `<b>${text}</b>`,
    
    // Wraps text in Telegram's italic HTML tags  
    italic: (text) => `<i>${text}</i>`,
    
    // Formats text as monospace/code
    code: (text) => `<code>${text}</code>`,
    
    // Creates clickable links
    link: (text, url) => `<a href="${url}">${text}</a>`,
    
    // Preserves whitespace and formatting
    pre: (text) => `<pre>${text}</pre>`
};

/**
 * Active Downloads Tracking
 * Uses a Map to store download sessions by chat ID
 */
const activeDownloads = new Map();

/**
 * Welcome Message
 * The introductory message shown to users when they start the bot
 */
const welcomeMessage = `${EMOJI.WAVE} ${fmt.bold('Media Downloader Pro')}

${fmt.italic('A social media downloader bot developed by @singsongadisu')}

${fmt.bold('Features:')}
• Download from YouTube, Instagram, TikTok and more
• Multiple quality options
• Real-time progress tracking
• Automatic format conversion
• File size checking

${fmt.bold('How to use:')}
1. Send me any media link
2. I'll show you download options
3. Get your file (under 50MB)

${fmt.italic('Note: Some platforms may have restrictions')}`;

/**
 * Helper Functions
 * These support the main bot functionality
 */

/**
 * Sanitizes filenames to remove illegal characters and ensure safety
 * @param {string} filename - Original potentially unsafe filename
 * @returns {string} Sanitized filename safe for filesystem use
 */
function sanitizeFilename(filename) {
    return filename
        .replace(/[<>:"\/\\|?*]/g, '') // Remove filesystem-illegal characters
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove control characters
        .replace(/\s+/g, ' ') // Collapse multiple spaces to single space
        .replace(/^\.+|\.+$/g, '') // Remove leading/trailing dots
        .trim()
        .substring(0, 100); // Truncate to 100 characters
}

/**
 * Creates a visual progress bar using emoji blocks
 * @param {number} percent - Completion percentage (0-100)
 * @returns {string} Visual progress bar representation
 */
function createProgressBar(percent) {
    const filled = Math.round(percent / 10); // Calculate number of filled blocks
    return `${'🟩'.repeat(filled)}${'⬜️'.repeat(10 - filled)} ${percent}%`;
}

/**
 * Cleans up temporary/downloaded files
 * @param {...string} files - File paths to delete
 */
async function cleanupFiles(...files) {
    for (const file of files) {
        try {
            if (file && fs.existsSync(file)) {
                fs.unlinkSync(file); // Delete each file
            }
        } catch (err) {
            console.error('Error cleaning up file:', err);
        }
    }
}

/**
 * Gets the original filename from a media URL using yt-dlp
 * @param {string} url - Media URL to check
 * @returns {string} Sanitized filename with extension
 */
async function getOriginalFilename(url) {
    try {
        // Command to extract original filename using yt-dlp
        const command = `"${YT_DLP_PATH}" --get-filename -o "%(title)s.%(ext)s" --no-warnings "${url}"`;
        
        // Execute synchronously and get filename
        const filename = execSync(command, { 
            encoding: 'utf-8',
            windowsHide: true // Hide terminal window on Windows
        }).trim();
        
        // Sanitize the filename
        const sanitized = filename
            .replace(/[<>:"\/\\|?*]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
            
        // Ensure filename has an extension
        if (!sanitized.includes('.')) {
            return `${sanitized}.mp4`; // Default to mp4 if no extension
        }
        return sanitized;
    } catch (error) {
        console.error('Error getting filename:', error.message);
        // Fallback filename with timestamp if extraction fails
        return `media_${Date.now().toString(36)}.mp4`;
    }
}

/**
 * Gets detailed information about a video using yt-dlp
 * @param {string} url - Video URL to analyze
 * @returns {object} Video metadata including title, duration, etc.
 */
async function getVideoInfo(url) {
    try {
        // Command to get full video info as JSON
        const infoCommand = `"${YT_DLP_PATH}" --dump-json --no-warnings "${url}"`;
        const infoStr = execSync(infoCommand, { 
            encoding: 'utf-8', 
            maxBuffer: 10 * 1024 * 1024, // 10MB max output buffer
            windowsHide: true
        }).trim();
        
        const info = JSON.parse(infoStr); // Parse JSON response
        const originalFilename = await getOriginalFilename(url);
        const cleanTitle = originalFilename.replace(/\.[^/.]+$/, ''); // Remove extension

        return {
            title: info.title || cleanTitle, // Fallback to filename if no title
            cleanTitle: cleanTitle,
            platform: info.extractor || 'Unknown', // Video source platform
            originalFilename: originalFilename,
            duration: info.duration || 0, // Duration in seconds
            thumbnail: info.thumbnail || null, // Video thumbnail URL
            ext: info.ext || 'mp4' // Default to mp4 if no extension
        };
    } catch (error) {
        console.error('Error getting video info:', error.message);
        // Fallback data if info extraction fails
        const fallbackTitle = `Media_${Date.now().toString(36)}`;
        return {
            title: fallbackTitle,
            cleanTitle: fallbackTitle,
            platform: 'Unknown',
            originalFilename: `${fallbackTitle}.mp4`,
            duration: 0,
            thumbnail: null,
            ext: 'mp4'
        };
    }
}

/**
 * Updates download progress message in Telegram
 * @param {number} chatId - Target chat ID
 * @param {number} messageId - Message to update
 * @param {number} progress - Current progress percentage
 * @param {string} [title] - Media title
 * @param {string} [platform] - Source platform
 */
async function updateProgress(chatId, messageId, progress, title = '', platform = '') {
    // Ensure progress never exceeds 100%
    progress = Math.min(progress, 100);
    
    const session = activeDownloads.get(chatId) || {};
    const now = Date.now();

    // Only update if significant change or enough time passed
    if (Math.abs(progress - (session.lastProgress || -1)) < MIN_PROGRESS_CHANGE ||
        (session.lastUpdateTime && now - session.lastUpdateTime < PROGRESS_UPDATE_INTERVAL)) {
        return;
    }

    // Construct progress message with visual bar
    const message = `${EMOJI.PROGRESS} ${fmt.bold('Download Progress')}\n\n` +
                   `${createProgressBar(progress)}\n\n` +
                   `${EMOJI.INFO} ${fmt.italic(title || 'Processing')}\n` +
                   (platform ? `${EMOJI.GLOBE} Source: ${platform}\n` : '');

    try {
        // Edit the existing progress message
        await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML'
        });

        // Update session tracking
        session.lastProgress = progress;
        session.lastUpdateTime = now;
        activeDownloads.set(chatId, session);
    } catch (e) {
        // Ignore "message not modified" errors
        if (!e.message.includes('message is not modified')) {
            console.error('Progress update error:', e.message);
        }
    }
}

/**
 * Checks file size and returns in bytes/MB
 * @param {string} filePath - Path to file
 * @returns {object} Size in bytes and formatted MB
 * @throws {Error} If file cannot be accessed
 */
async function checkFileSize(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return {
            size: stats.size, // Size in bytes
            sizeMB: (stats.size / (1024 * 1024)).toFixed(2) // Size in MB with 2 decimals
        };
    } catch (err) {
        throw new Error('File size check failed');
    }
}

/**
 * Estimates file size before downloading
 * @param {string} url - Media URL
 * @param {string} formatType - Chosen format (video/audio)
 * @returns {object} Contains size info or estimation failure
 */
async function estimateFileSize(url, formatType) {
    try {
        let command;
        // Different commands for audio vs video
        if (formatType.startsWith('audio_')) {
            command = `"${YT_DLP_PATH}" -f bestaudio -x --get-url --no-warnings "${url}"`;
        } else {
            command = `"${YT_DLP_PATH}" -f "best[height<=720][ext=mp4]/best[ext=mp4]" --get-url --no-warnings "${url}"`;
        }
        
        // Get the actual media stream URL
        const streamUrl = execSync(command, { 
            encoding: 'utf-8',
            windowsHide: true
        }).trim();
        
        if (!streamUrl) return { estimated: false };

        // Platform-specific command to get content length header
        const curlCommand = process.platform === 'win32'
            ? `curl -sI "${streamUrl}" | findstr /i "content-length"`
            : `curl -sI "${streamUrl}" | grep -i "content-length"`;
        
        // Execute content length check
        const contentLength = execSync(curlCommand, { 
            encoding: 'utf-8',
            windowsHide: true 
        }).trim();
        
        // Extract size from headers
        const sizeBytes = parseInt(contentLength.split(':')[1].trim());
        
        if (isNaN(sizeBytes)) return { estimated: false };

        return {
            size: sizeBytes,
            sizeMB: (sizeBytes / (1024 * 1024)).toFixed(2),
            estimated: true
        };
    } catch (error) {
        console.error('Error estimating file size:', error.message);
        return {
            estimated: false,
            error: 'Could not estimate file size'
        };
    }
}

/* ====================== */
/* BOT COMMAND HANDLERS   */
/* ====================== */

/**
 * Handle /start and /help commands
 * Sends the welcome message to users
 */
bot.onText(/\/start|\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, welcomeMessage, { 
        parse_mode: 'HTML',
        disable_web_page_preview: true // Prevent link preview in welcome message
    });
});

/**
 * Auto-welcome new users in private chats
 * Sends welcome message when user first interacts
 */
bot.on('message', (msg) => {
    // Only in private chats and not command messages
    if (msg.chat.type === 'private' && !msg.text?.startsWith('/')) {
        // Only send welcome if it's the first message
        if (!msg.text) {
            bot.sendMessage(msg.chat.id, welcomeMessage, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
        }
    }
});

/**
 * Handle /cancel command
 * Stops active downloads for the user
 */
bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    const session = activeDownloads.get(chatId);
    
    if (session && session.downloadProcess) {
        // Kill the active download process
        session.downloadProcess.kill();
        bot.sendMessage(chatId, `${EMOJI.CANCEL} ${fmt.bold('Download canceled!')}`, {
            parse_mode: 'HTML'
        });
        activeDownloads.delete(chatId);
    } else {
        bot.sendMessage(chatId, `${EMOJI.INFO} ${fmt.bold('No active download to cancel')}`, {
            parse_mode: 'HTML'
        });
    }
});

/**
 * Handle media URL messages
 * Processes links sent by users and initiates download
 */
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignore non-text messages and commands
    if (!text || text.startsWith('/')) return;

    // Validate URL format
    try {
        new URL(text);
    } catch {
        return bot.sendMessage(
            chatId,
            `${EMOJI.ERROR} ${fmt.bold('Invalid URL!')}\n\n` +
            `${fmt.italic('Please send a valid media link from supported platforms:')}\n` +
            `${fmt.code('YouTube, Instagram, TikTok, Twitter, etc.')}`,
            { 
                parse_mode: 'HTML',
                disable_web_page_preview: true
            }
        );
    }

    try {
        // Send initial processing message
        const sentMessage = await bot.sendMessage(
            chatId,
            `${EMOJI.CLOCK} ${fmt.bold('Checking link...')}\n\n` +
            `${fmt.italic('Please wait while I analyze the media')}`,
            { parse_mode: 'HTML' }
        );

        // Extract video info and create session
        const { title, cleanTitle, platform, duration, thumbnail } = await getVideoInfo(text);
        const sessionId = crypto.randomBytes(8).toString('hex'); // Unique session ID

        // Store session info for tracking
        activeDownloads.set(sessionId, {
            originalUrl: text,
            title,
            cleanTitle,
            platform,
            duration,
            thumbnail,
            timestamp: Date.now()
        });

        // Prepare format selection buttons
        const options = {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: `${EMOJI.VIDEO} Video Options`,
                        callback_data: `video_menu|${sessionId}`
                    }],
                    [{
                        text: `${EMOJI.AUDIO} Audio Options`,
                        callback_data: `audio_menu|${sessionId}`
                    }]
                ]
            },
            parse_mode: 'HTML'
        };

        // Build media info message
        let messageText = `${EMOJI.LINK} ${fmt.bold('Media Detected:')} ${platform}\n\n` +
                         `${fmt.bold('Title:')} ${title}\n`;
        
        // Add duration if available
        if (duration) {
            messageText += `${fmt.bold('Duration:')} ${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')}\n\n`;
        }

        messageText += `${EMOJI.OPTIONS} ${fmt.bold('Choose download option:')}`;

        // Update message with format options
        await bot.editMessageText(messageText, {
            chat_id: chatId,
            message_id: sentMessage.message_id,
            reply_markup: options.reply_markup,
            parse_mode: 'HTML'
        });

        // Store progress message ID in session
        activeDownloads.get(sessionId).progressMessageId = sentMessage.message_id;

    } catch (err) {
        console.error('Error processing URL:', err);
        bot.sendMessage(
            chatId,
            `${EMOJI.ERROR} ${fmt.bold('Error processing URL')}\n\n` +
            `${fmt.italic('Please check the link and try again.')}\n` +
            `${fmt.code(err.message)}`,
            { 
                parse_mode: 'HTML',
                disable_web_page_preview: true
            }
        );
    }
});

/* ====================== */
/* CALLBACK QUERY HANDLER */
/* ====================== */

/**
 * Handle all inline button callbacks
 * Manages the download option selection and execution
 */
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const [action, sessionId] = query.data.split('|');

    // Check if session is still valid
    if (!activeDownloads.has(sessionId)) {
        return bot.answerCallbackQuery(query.id, {
            text: 'Session expired. Please send the link again.',
            show_alert: true
        });
    }

    // Get session data
    const session = activeDownloads.get(sessionId);
    const { originalUrl: url, title, cleanTitle, platform, duration } = session;

    try {
        // Acknowledge button press
        await bot.answerCallbackQuery(query.id);

        /* ====================== */
        /* MENU NAVIGATION HANDLERS */
        /* ====================== */

        if (action === 'audio_menu') {
            // Show audio quality options
            const audioOptions = {
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: `${EMOJI.AUDIO} MP3 (128kbps - Small)`,
                            callback_data: `audio_128|${sessionId}`
                        }],
                        [{
                            text: `${EMOJI.AUDIO} MP3 (192kbps - Balanced)`,
                            callback_data: `audio_192|${sessionId}`
                        }],
                        [{
                            text: `${EMOJI.AUDIO} MP3 (320kbps - Best Quality)`,
                            callback_data: `audio_320|${sessionId}`
                        }],
                        [{
                            text: `${EMOJI.VIDEO} Back to Main Menu`,
                            callback_data: `main_menu|${sessionId}`
                        }],
                        [{
                            text: `${EMOJI.CANCEL} Cancel`,
                            callback_data: `cancel|${sessionId}`
                        }]
                    ]
                },
                parse_mode: 'HTML'
            };

            await bot.editMessageText(
                `${EMOJI.AUDIO} ${fmt.bold('Audio Quality Options:')}\n\n` +
                `${fmt.bold('Title:')} ${title}\n` +
                `${fmt.bold('Source:')} ${platform}\n\n` +
                `${fmt.italic('Select your preferred audio quality:')}`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: audioOptions.reply_markup,
                    parse_mode: 'HTML'
                }
            );
            return;
        }

        if (action === 'video_menu') {
            // Show video quality options
            const videoOptions = {
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: `${EMOJI.VIDEO} 480p (Smaller Size)`,
                            callback_data: `video_480|${sessionId}`
                        }],
                        [{
                            text: `${EMOJI.VIDEO} 720p (Recommended)`,
                            callback_data: `video_720|${sessionId}`
                        }],
                        [{
                            text: `${EMOJI.VIDEO} Best Available`,
                            callback_data: `video_best|${sessionId}`
                        }],
                        [{
                            text: `${EMOJI.AUDIO} Back to Audio Options`,
                            callback_data: `audio_menu|${sessionId}`
                        }],
                        [{
                            text: `${EMOJI.CANCEL} Cancel`,
                            callback_data: `cancel|${sessionId}`
                        }]
                    ]
                },
                parse_mode: 'HTML'
            };

            await bot.editMessageText(
                `${EMOJI.VIDEO} ${fmt.bold('Video Quality Options:')}\n\n` +
                `${fmt.bold('Title:')} ${title}\n` +
                `${fmt.bold('Source:')} ${platform}\n\n` +
                `${fmt.italic('Select your preferred video quality:')}`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: videoOptions.reply_markup,
                    parse_mode: 'HTML'
                }
            );
            return;
        }

        if (action === 'main_menu') {
            // Return to main menu
            const options = {
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: `${EMOJI.VIDEO} Video Options`,
                            callback_data: `video_menu|${sessionId}`
                        }],
                        [{
                            text: `${EMOJI.AUDIO} Audio Options`,
                            callback_data: `audio_menu|${sessionId}`
                        }]
                    ]
                },
                parse_mode: 'HTML'
            };

            await bot.editMessageText(
                `${EMOJI.OPTIONS} ${fmt.bold('Choose download option:')}\n\n` +
                `${fmt.bold('Title:')} ${title}\n` +
                `${fmt.bold('Source:')} ${platform}`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: options.reply_markup,
                    parse_mode: 'HTML'
                }
            );
            return;
        }

        if (action === 'cancel') {
            // Handle cancellation
            await bot.editMessageText(
                `${EMOJI.INFO} ${fmt.bold('Operation canceled')}\n\n` +
                `${fmt.italic('Send me another link if you want to download something.')}`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML'
                }
            );
            activeDownloads.delete(sessionId);
            return;
        }

        /* ====================== */
        /* DOWNLOAD EXECUTION     */
        /* ====================== */

        let command, finalFilename, isAudio = false, quality = '';

        // Build appropriate yt-dlp command based on selection
        if (action.startsWith('audio_')) {
            // Audio download options
            const bitrate = action.split('_')[1];
            isAudio = true;
            quality = `${bitrate}kbps`;
            finalFilename = `${cleanTitle}.mp3`;
            
            command = `"${YT_DLP_PATH}" -x --audio-format mp3 --audio-quality ${bitrate} ` +
                      `--embed-thumbnail --output "${path.join(DOWNLOAD_FOLDER, finalFilename)}" ` +
                      `--newline "${url}"`;
        } else if (action.startsWith('video_')) {
            // Video download options
            const qualityOption = action.split('_')[1];
            finalFilename = `${cleanTitle}.mp4`;
            
            switch(qualityOption) {
                case '480':
                    command = `"${YT_DLP_PATH}" -f "best[height<=480][ext=mp4]" ` +
                              `--merge-output-format mp4 --output "${path.join(DOWNLOAD_FOLDER, finalFilename)}" ` +
                              `--newline "${url}"`;
                    quality = '480p';
                    break;
                case '720':
                    command = `"${YT_DLP_PATH}" -f "best[height<=720][ext=mp4]" ` +
                              `--merge-output-format mp4 --output "${path.join(DOWNLOAD_FOLDER, finalFilename)}" ` +
                              `--newline "${url}"`;
                    quality = '720p';
                    break;
                case 'best':
                    command = `"${YT_DLP_PATH}" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]" ` +
                              `--merge-output-format mp4 --output "${path.join(DOWNLOAD_FOLDER, finalFilename)}" ` +
                              `--newline "${url}"`;
                    quality = 'Best Quality';
                    break;
            }
        }

        const filePath = path.join(DOWNLOAD_FOLDER, finalFilename);
        session.formatType = action;
        session.quality = quality;
        activeDownloads.set(sessionId, session);

        // Estimate file size before downloading
        const sizeEstimate = await estimateFileSize(url, action);
        
        // Check if file would exceed Telegram's size limit
        if (sizeEstimate.estimated && sizeEstimate.size > MAX_FILE_SIZE) {
            await bot.editMessageText(
                `${EMOJI.WARNING} ${fmt.bold('File Too Large!')}\n\n` +
                `${fmt.bold('Title:')} ${title}\n` +
                `${fmt.bold('Estimated Size:')} ${sizeEstimate.sizeMB}MB (max 50MB allowed)\n\n` +
                `${fmt.italic('Try a lower quality option or audio format')}`,
                { 
                    chat_id: chatId, 
                    message_id: messageId, 
                    parse_mode: 'HTML' 
                }
            );
            return;
        }

        // Update message to show download starting
        await bot.editMessageText(
            `${EMOJI.DOWNLOAD} ${fmt.bold('Starting Download...')}\n\n` +
            `${fmt.bold('Title:')} ${title}\n` +
            `${fmt.bold('Quality:')} ${quality}\n` +
            (sizeEstimate.estimated ? `${fmt.bold('Estimated Size:')} ${sizeEstimate.sizeMB}MB\n` : '') +
            `${fmt.italic('This may take a few moments...')}`,
            { 
                chat_id: chatId, 
                message_id: messageId, 
                parse_mode: 'HTML' 
            }
        );

        // Start the download process
        const ytDlpProcess = exec(command);
        session.downloadProcess = ytDlpProcess;
        activeDownloads.set(sessionId, session);

        // Monitor download progress
        const rl = readline.createInterface({ input: ytDlpProcess.stdout });

        rl.on('line', (line) => {
            // Extract progress percentage from yt-dlp output
            const progressMatch = line.match(/\[download\]\s+(\d+\.\d+)%/);
            if (progressMatch) {
                const progress = Math.round(parseFloat(progressMatch[1]));
                updateProgress(chatId, messageId, progress, title, platform);
            }
        });

        // Handle download completion
        ytDlpProcess.on('close', async (code) => {
            try {
                if (code !== 0) throw new Error(`Download failed with code ${code}`);
                
                if (!fs.existsSync(filePath)) throw new Error('File not found after download');
                
                const { size, sizeMB } = await checkFileSize(filePath);
                if (size === 0) throw new Error('Downloaded file is empty');
                
                // Final size check (in case estimation was wrong)
                if (size > MAX_FILE_SIZE) {
                    await bot.editMessageText(
                        `${EMOJI.WARNING} ${fmt.bold('File Too Large!')}\n\n` +
                        `${fmt.bold('Title:')} ${title}\n` +
                        `${fmt.bold('Size:')} ${sizeMB}MB (max 50MB allowed)\n\n` +
                        `${fmt.italic('Try a lower quality option or audio format')}`,
                        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
                    );
                    return;
                }

                // Force progress to 100% before sending
                await updateProgress(chatId, messageId, 100, title, platform);
                
                // Show appropriate upload indicator
                await bot.sendChatAction(chatId, isAudio ? 'upload_audio' : 'upload_video');
                
                // Prepare completion message
                const caption = `${EMOJI.SUCCESS} ${fmt.bold('Download Complete!')}\n\n` +
                               `${fmt.bold('Title:')} ${title}\n` +
                               `${fmt.bold('Quality:')} ${quality}\n` +
                               `${fmt.bold('Size:')} ${sizeMB}MB`;

                // Send the downloaded file
                if (isAudio) {
                    await bot.sendAudio(
                        chatId,
                        fs.createReadStream(filePath),
                        {
                            title: cleanTitle,
                            performer: platform,
                            caption: caption,
                            parse_mode: 'HTML'
                        }
                    );
                } else {
                    await bot.sendVideo(
                        chatId,
                        fs.createReadStream(filePath),
                        {
                            caption: caption,
                            parse_mode: 'HTML'
                        }
                    );
                }

                // Delete the progress message
                try {
                    await bot.deleteMessage(chatId, messageId);
                } catch (deleteError) {
                    console.error('Error deleting progress message:', deleteError.message);
                }

            } catch (err) {
                console.error('Download failed:', err);
                await bot.editMessageText(
                    `${EMOJI.ERROR} ${fmt.bold('Download Failed')}\n\n` +
                    `${fmt.italic(err.message)}\n\n` +
                    `${fmt.bold('Title:')} ${title}\n` +
                    `${fmt.italic('Please try again or use a different quality option.')}`,
                    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
                );
            } finally {
                // Cleanup downloaded files and session
                await cleanupFiles(filePath);
                activeDownloads.delete(sessionId);
            }
        });

        // Handle download process errors
        ytDlpProcess.on('error', (err) => {
            console.error('Download process error:', err);
            bot.sendMessage(
                chatId,
                `${EMOJI.ERROR} ${fmt.bold('Download Error')}\n\n` +
                `${fmt.code(err.message)}\n\n` +
                `${fmt.italic('Please try again later.')}`,
                { parse_mode: 'HTML' }
            );
            activeDownloads.delete(sessionId);
        });

    } catch (err) {
        console.error('Callback error:', err);
        await bot.sendMessage(
            chatId,
            `${EMOJI.ERROR} ${fmt.bold('Error')}\n\n` +
            `${fmt.italic(err.message)}\n\n` +
            `${fmt.italic('Please try again or contact support if the problem persists.')}`,
            { parse_mode: 'HTML' }
        );
        activeDownloads.delete(sessionId);
    }
});

/* ====================== */
/* ERROR HANDLING         */
/* ====================== */

// Handle Telegram polling errors
bot.on('polling_error', (error) => {
    console.error(`Polling error: ${error.code} - ${error.message}`);
});

// Catch unhandled exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Startup message
console.log(`${EMOJI.SUCCESS} Bot is running and waiting for messages...`);