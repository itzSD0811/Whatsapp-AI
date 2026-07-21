require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const figlet = require('figlet');
const chalk = require('chalk');
const ai = require('./ai');
const settings = require('./default_settings.json');

// --- Setup Error Logging ---
const originalConsoleError = console.error;
console.error = function (...args) {
    // 1. Log to the terminal as usual
    originalConsoleError.apply(console, args);

    try {
        // 2. Ensure logs directory exists
        const logsDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir);
        }

        // 3. Create a daily rotating log file name (error_YYYY-MM-DD.log)
        const dateStr = new Date().toISOString().split('T')[0];
        const logFile = path.join(logsDir, `error_${dateStr}.log`);
        
        // 4. Format the error message
        const timestamp = new Date().toISOString();
        // Remove ANSI escape codes (colors) from the logged string
        const stripAnsi = (str) => str.replace(/\x1B\[\d+m/g, '');
        
        const logMsg = `[${timestamp}] ` + args.map(arg => {
            if (arg instanceof Error) return stripAnsi(arg.stack || arg.toString());
            if (typeof arg === 'object') return stripAnsi(JSON.stringify(arg));
            return stripAnsi(String(arg));
        }).join(' ') + '\n';

        // 5. Append to the daily log file
        fs.appendFileSync(logFile, logMsg);
    } catch (e) {
        // Fallback if writing to log file fails
        originalConsoleError("Failed to write to log file:", e);
    }
};
// ---------------------------

// Store active chat sessions and their timeout handles
const activeChats = {};

// Store chats that have requested a 24h keepalive
const keepAliveChats = new Set();

// Store last messages for chat clearing
const lastMessages = {};

// Verification state
const pendingVerifications = {};

// Load Whitelist
const whitelistPath = path.join(__dirname, 'whitelist.json');
let whitelist = [];
if (fs.existsSync(whitelistPath)) {
    try {
        whitelist = JSON.parse(fs.readFileSync(whitelistPath));
    } catch (e) {
        console.error("Error reading whitelist.json", e);
        whitelist = [];
    }
}

function saveWhitelist() {
    fs.writeFileSync(whitelistPath, JSON.stringify(whitelist, null, 2));
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function displayStartupBanner() {
    return new Promise((resolve) => {
        figlet('Gamma BOT', function(err, data) {
            if (err) {
                console.log('Gamma BOT');
                return resolve();
            }
            console.log(chalk.cyan(data));
            console.log(chalk.yellow(`\nWelcome to Gamma BOT Setup - Developed by ${settings.credits.owner_name}\n`));
            resolve();
        });
    });
}

async function clearChat(sock, jid) {
    if (settings.bot.auto_delete_chat && lastMessages[jid]) {
        try {
            const msg = lastMessages[jid];
            await sock.chatModify(
                { delete: true, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] }, 
                jid
            );
        } catch (e) {
            console.error(chalk.red("Failed to delete chat"), e);
        }
    }
}

async function connectToWhatsApp() {
    await displayStartupBanner();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    let usePairingCode = false;

    // If there is no existing session, ask the user how they want to connect
    if (!state.creds.registered) {
        console.log(chalk.green("[1] Link With QR code"));
        console.log(chalk.green("[2] Link with Phone number"));
        const choice = await question(chalk.white("> Please enter 1 or 2: "));
        if (choice.trim() === '2') {
            usePairingCode = true;
        }
    }

    const { version } = await require('@whiskeysockets/baileys').fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // We will handle it manually to fix distortion
        logger: pino({ level: 'silent' }), // suppress verbose logs
        browser: ['Ubuntu', 'Chrome', '20.0.04'], // Explicit string array needed for some WA connections
        markOnlineOnConnect: true
    });

    if (usePairingCode && !sock.authState.creds.registered) {
        const phoneNumber = await question(chalk.white("> Please enter your phone number with country code (e.g., 94000000000): "));
        
        console.log(chalk.yellow("Requesting pairing code from WhatsApp... Please wait."));
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber.trim());
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(chalk.black.bgWhite.bold(`\n Your Pairing Code: ${code} \n`));
                console.log(chalk.yellow(`Enter this code in your WhatsApp app -> Linked Devices -> Link with phone number\n`));
            } catch (err) {
                console.error(chalk.red("Failed to get pairing code. Please make sure the number is correct and try again."));
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr && !usePairingCode) {
            // Manually generate a smaller QR code to prevent wrapping in Pterodactyl panels
            const qrcode = require('qrcode-terminal');
            qrcode.generate(qr, { small: true });
        }

        if(connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(chalk.red('Connection closed due to '), lastDisconnect.error, chalk.yellow(', reconnecting '), shouldReconnect);
            if(shouldReconnect) {
                connectToWhatsApp();
            }
        } else if(connection === 'open') {
            console.log(chalk.green.bold('Bot is connected and ready!'));
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if(!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        lastMessages[jid] = msg; // Store last message for chat clearing
        
        // Extract text message or media caption
        const textMessage = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || 
                            msg.message.imageMessage?.caption || 
                            msg.message.videoMessage?.caption || "";
        
        const command = textMessage.trim();

        // Ignore if no text and no image
        if (!command && !msg.message.imageMessage) return; 

        const myNum = sock.user?.id ? sock.user.id.split(':')[0] : '';
        const myJid = myNum + '@s.whatsapp.net';

        // 1. Handle Verification Initiation
        if (command.toLowerCase() === '!verify') {
            if (whitelist.includes(jid)) {
                await sock.sendMessage(jid, { text: "You are already verified!" });
                return;
            }

            if (pendingVerifications[jid]) {
                await sock.sendMessage(jid, { text: "A verification is already in progress. Please enter your OTP." });
                return;
            }

            // Generate OTP
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const formattedOtp = otp.slice(0, 3) + '-' + otp.slice(3);

            pendingVerifications[jid] = {
                otp: formattedOtp,
                attempts: 0,
                timeoutId: setTimeout(async () => {
                    delete pendingVerifications[jid];
                    await sock.sendMessage(jid, { text: "Verification timeout (2 minutes). Please type !verify to try again." });
                }, 120000)
            };

            const userPhone = jid.split('@')[0];
            await sock.sendMessage(myJid, { text: `${userPhone} request to use your bot here is the OTP : ${formattedOtp}` });
            
            const verifyText = `*Welcome to Gamma BOT!* 🤖\n\n` +
                               `An OTP has been sent to the owner. Please enter it here (e.g. 123-456) to verify your account.`;
            const imagePath = path.join(__dirname, 'Assets', 'alive.jpg');
            
            try {
                if (fs.existsSync(imagePath)) {
                    await sock.sendMessage(jid, { image: { url: imagePath }, caption: verifyText });
                } else {
                    await sock.sendMessage(jid, { text: verifyText });
                }
            } catch (e) {
                console.error(chalk.red("Error sending verify message"), e);
                await sock.sendMessage(jid, { text: verifyText });
            }
            return;
        }

        // 2. Handle OTP Input
        if (pendingVerifications[jid]) {
            const state = pendingVerifications[jid];
            if (command === state.otp) {
                clearTimeout(state.timeoutId);
                delete pendingVerifications[jid];
                whitelist.push(jid);
                saveWhitelist();
                await sock.sendMessage(jid, { text: "Verification successful! You are now whitelisted. Type !start to begin." });
            } else {
                state.attempts++;
                if (state.attempts >= 3) {
                    clearTimeout(state.timeoutId);
                    delete pendingVerifications[jid];
                    await sock.sendMessage(jid, { text: "Verification failed too many times. Process terminated. Type !verify to restart." });
                } else {
                    await sock.sendMessage(jid, { text: `Invalid OTP. You have ${3 - state.attempts} attempt(s) remaining.` });
                }
            }
            return; // consume the message
        }

        // Allow !alive before blocking non-whitelisted users
        if(command.toLowerCase() === '!alive') {
            const isVerified = whitelist.includes(jid);
            await sendAliveMessage(sock, jid, isVerified);
            return;
        }

        // 3. Block Non-Whitelisted Users
        if (!whitelist.includes(jid)) {
            // Silently ignore all other messages from unverified users
            return;
        }

        // --- Only Verified Users Reach Here ---

        if(command.toLowerCase() === '!start') {
            startChatSession(sock, jid);
            await sock.sendMessage(jid, { text: settings.messages.started });
            return;
        }

        if(command.toLowerCase() === '!keepalive') {
            keepAliveChats.add(jid);
            startChatSession(sock, jid);
            await sock.sendMessage(jid, { text: "🕒 Session is now kept alive for 24 hours. I will not go to sleep automatically. Type !end to manually terminate the session." });
            return;
        }

        if(command.toLowerCase() === '!end') {
            if (activeChats[jid]) {
                clearTimeout(activeChats[jid]);
                delete activeChats[jid];
                keepAliveChats.delete(jid);
                await sock.sendMessage(jid, { text: settings.messages.ended });
                await clearChat(sock, jid);
            }
            return;
        }

        // If it's an active chat, process with AI
        if (activeChats[jid]) {
            // Reset the timeout timer
            startChatSession(sock, jid);
            
            // Show typing indicator
            await sock.sendPresenceUpdate('composing', jid);

            try {
                let imageInfo = null;
                if (msg.message.imageMessage) {
                    try {
                        const buffer = await downloadMediaMessage(
                            msg,
                            'buffer',
                            { },
                            { 
                                logger: pino({ level: 'silent' }),
                                reuploadRequest: sock.updateMediaMessage
                            }
                        );
                        imageInfo = {
                            base64: buffer.toString('base64'),
                            mimeType: msg.message.imageMessage.mimetype || 'image/jpeg'
                        };
                    } catch (err) {
                        console.error(chalk.red("Failed to download image media"), err);
                    }
                }

                const aiResponse = await ai.getChatCompletion(command, imageInfo);
                
                // Add signature
                const fullMessage = aiResponse + settings.credits.signature;
                
                // Split message if too long
                await sendSplitMessage(sock, jid, fullMessage, settings.bot.max_message_length);
            } catch (error) {
                console.error(chalk.red("AI processing error:"), error);
                await sock.sendMessage(jid, { text: settings.messages.error + settings.credits.signature });
            }
        }
    });
}

function startChatSession(sock, jid) {
    if (activeChats[jid]) {
        clearTimeout(activeChats[jid]);
    }
    
    // 24 hours if keepalive is active, else default 5 mins
    const timeoutDuration = keepAliveChats.has(jid) ? 86400000 : settings.bot.inactivity_timeout_ms;

    // Set inactivity timeout
    activeChats[jid] = setTimeout(async () => {
        delete activeChats[jid];
        keepAliveChats.delete(jid);
        try {
            await sock.sendMessage(jid, { text: settings.messages.timeout });
            await clearChat(sock, jid);
        } catch (e) {
            console.error(chalk.red("Failed to send timeout message to"), jid);
        }
    }, timeoutDuration); 
}

async function sendAliveMessage(sock, jid, isVerified = false) {
    let aliveText = `*Gamma BOT is Alive!* 🤖\n\n` +
                      `*Owner:* ${settings.credits.owner_name}\n` +
                      `*Phone:* ${settings.credits.owner_phone}\n\n`;

    if (isVerified) {
        aliveText += `Use *!start* to begin chatting with the AI.\n` +
                     `The session expires after 5 minutes of inactivity.\n`;
    } else {
        aliveText += `You are not verified yet.\n` +
                     `Use *!verify* to request access to the AI.\n`;
    }

    aliveText += settings.credits.signature;

    const imagePath = path.join(__dirname, 'Assets', 'alive.jpg');
    
    try {
        if (fs.existsSync(imagePath)) {
            await sock.sendMessage(jid, { 
                image: { url: imagePath }, 
                caption: aliveText 
            });
        } else {
            await sock.sendMessage(jid, { text: aliveText });
        }
    } catch (e) {
        console.error(chalk.red("Error sending alive message"), e);
    }
}

async function sendSplitMessage(sock, jid, text, maxLength) {
    if (text.length <= maxLength) {
        await sock.sendMessage(jid, { text: text });
        return;
    }

    // Split text into chunks
    let currentIndex = 0;
    while (currentIndex < text.length) {
        let chunk = text.slice(currentIndex, currentIndex + maxLength);
        
        // If this isn't the last chunk, try to split at a newline or space
        if (currentIndex + maxLength < text.length) {
            let lastNewline = chunk.lastIndexOf('\n');
            let lastSpace = chunk.lastIndexOf(' ');
            
            let splitIndex = maxLength;
            if (lastNewline > maxLength * 0.8) { // Prefer splitting at newline if it's near the end
                splitIndex = lastNewline;
            } else if (lastSpace > maxLength * 0.8) {
                splitIndex = lastSpace;
            }
            
            chunk = chunk.slice(0, splitIndex);
            currentIndex += splitIndex;
        } else {
            currentIndex += maxLength;
        }

        await sock.sendMessage(jid, { text: chunk.trim() });
    }
}

connectToWhatsApp();
