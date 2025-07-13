# YouTube/Telegram Downloader Bot

A Telegram bot that downloads videos and audio from YouTube and other platforms.

## Features

- Download videos from YouTube, Instagram, TikTok
- Multiple quality options (480p, 720p, 1080p)
- Audio extraction (MP3 128kbps, 192kbps, 320kbps)
- Real-time download progress
- File size checking (under 50MB limit)

## Prerequisites

- Node.js 16+
- npm/yarn
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed

## Installation

1. Clone the repository: cd telegram-bot
2. Install dependencies: npm install
3. Create .env file: BOT_TOKEN=your_telegram_bot_token
4. Start the bot: node index.js