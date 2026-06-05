/**
 * ULTRA BINGO - Telegram Bot
 *
 * Standalone bot (Node.js + node-telegram-bot-api) that:
 * - /start → opens Mini App
 * - /play → quick game link
 * - /balance → current balance
 * - /deposit → top-up instructions
 * - /withdraw → cashout instructions
 * - /support → contact
 *
 * Run separately: `node bot/telegram-bot.js`
 * Requires TELEGRAM_BOT_TOKEN env var
 */

require('dotenv').config({ path: '../.env' });
const TelegramBot = require('node-telegram-bot-api');
const winston = require('winston');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBAPP_URL = process.env.PUBLIC_URL || 'https://your-domain.com';
const API_URL = process.env.PUBLIC_URL || 'http://localhost:3000';

if (!BOT_TOKEN || BOT_TOKEN === 'your-bot-token-from-botfather') {
  console.error('❌ TELEGRAM_BOT_TOKEN not set in .env');
  console.error('Get one from @BotFather on Telegram');
  process.exit(1);
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.simple()),
  transports: [new winston.transports.Console()]
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

logger.info('🤖 Telegram bot starting...');

// ════════════════════════════════════════════════
//   KEYBOARDS
// ════════════════════════════════════════════════
const mainKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🎮 ጨዋታ ጀምር', web_app: { url: WEBAPP_URL } }],
      [
        { text: '💰 ቀሪ ሂሳብ', callback_data: 'balance' },
        { text: '➕ ቀይር', callback_data: 'deposit' }
      ],
      [
        { text: '💸 ወጪ', callback_data: 'withdraw' },
        { text: '🔗 ጋብዝ', callback_data: 'invite' }
      ],
      [{ text: '🎧 ድጋፍ', callback_data: 'support' }]
    ]
  }
};

// ════════════════════════════════════════════════
//   COMMANDS
// ════════════════════════════════════════════════

// /start
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const refCode = match[1]?.trim();
  const name = msg.from.first_name || 'Player';

  const welcomeText = `👑 እንኳን ወደ **ULTRA BINGO** ደህና መጡ ${name}!

🎯 ዛሬ ከ 100+ ተጫዋቾች ጋር ተፎካከር
💰 ከ 5 እስከ 100 ብር ድረስ አስገባ
🏆 80% ሽልማት ለአሸናፊ

🔽 ከስር ይምረጡ:`;

  await bot.sendMessage(chatId, welcomeText, {
    parse_mode: 'Markdown',
    ...mainKeyboard
  });

  if (refCode) {
    // Save referral
    logger.info(`New referral: ${msg.from.id} via ${refCode}`);
  }
});

// /play
bot.onText(/\/play/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🎮 ጨዋታ ጀምር:', {
    reply_markup: {
      inline_keyboard: [[{ text: '🎯 ULTRA BINGO', web_app: { url: WEBAPP_URL } }]]
    }
  });
});

// /balance
bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  // Note: We need to map Telegram user_id to phone.
  // For now, prompt user to use Mini App or send their phone.
  await bot.sendMessage(chatId,
    '💰 ቀሪ ሂሳብዎን ለማየት Mini App ይክፈቱ:',
    mainKeyboard
  );
});

// /deposit
bot.onText(/\/deposit/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `➕ **ዲፖዚት መመሪያ**

ወደዚህ ቴሌብር ቁጥር ይላኩ:
📱 **0953025980**
👤 ስም: **Seid**

💰 መጠን: 100-10,000 ብር
🔢 ከከፈሉ በኋላ የክፍያ ማጣቀሻ (reference) ያስገቡ Mini App ውስጥ

⚡ ከ 1-5 ደቂቃ ውስጥ ይቀበላሉ`,
    {
      parse_mode: 'Markdown',
      ...mainKeyboard
    }
  );
});

// /withdraw
bot.onText(/\/withdraw/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `💸 **ዊዝድሮ መመሪያ**

📱 ሂሳብዎ ላይ ብር ለማውጣት:
1. Mini App ይክፈቱ
2. ወደ "ሂሳብ / Wallet" ይሂዱ
3. "Withdraw" ይጫኑ
4. መጠን እና ስልክ ቁጥር ያስገቡ
5. ፒን: **1234**

⏰ ከ 5-30 ደቂቃ ውስጥ ይደርሳል`,
    {
      parse_mode: 'Markdown',
      ...mainKeyboard
    }
  );
});

// /support
bot.onText(/\/support/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `🎧 **ድጋፍ / Support**

ለእርዳታ:
📞 ስልክ: +251 953 025 980
💬 Telegram: @UltraBingoSupport
📧 Email: support@ultrabingo.et

⏰ 24/7 እናስተናግዳለን`,
    {
      parse_mode: 'Markdown',
      ...mainKeyboard
    }
  );
});

// /help
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `📖 **እንዴት መጫወት እንደሚቻል**

1️⃣ "🎮 ጨዋታ ጀምር" ይጫኑ
2️⃣ ምዝገባ / Login
3️⃣ "Deposit" → ብር ያስገቡ
4️⃣ ክፍል ይምረጡ (5/10/50/100 ብር)
5️⃣ ካርቴላ ይምረጡ (1-400)
6️⃣ 2+ players ሲኖሩ ጨዋታ ይጀምራል
7️⃣ ቁጥሮች በራስ-ሰር ይምታሉ
8️⃣ 2 መስመር ማጠናቀቅ = **BINGO! 🏆**

🎯 ሽልማት: 80% ነው`,
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

// /invite or /referral
bot.onText(/\/(invite|referral)/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const refCode = 'UB-' + userId.toString(36).toUpperCase();
  const refLink = `https://t.me/UltraBingoBot?start=${refCode}`;

  await bot.sendMessage(chatId,
    `🔗 **ጓደኛ ጋብዙ!**

ለእያንዳንዱ ጓደኛ የሚቀላቀል: **+5 ብር**

የእርስዎ ሊንክ:
\`${refLink}\`

📋 ኮድ: \`${refCode}\``,
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

// ════════════════════════════════════════════════
//   CALLBACK QUERIES
// ════════════════════════════════════════════════
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  switch (data) {
    case 'balance':
      await bot.sendMessage(chatId, '💰 ቀሪ ሂሳብ ለማየት Mini App ይክፈቱ', mainKeyboard);
      break;
    case 'deposit':
      await bot.sendMessage(chatId,
        '➕ ዲፖዚት ለማድረግ:\n\n📱 0953025980 (Seid)\n💰 100-10,000 ብር\n\nከከፈሉ reference ቁጥር ያስገቡ Mini App ውስጥ',
        mainKeyboard
      );
      break;
    case 'withdraw':
      await bot.sendMessage(chatId, '💸 Withdraw ለማድረግ Mini App ይክፈቱ\n\nፒን: 1234', mainKeyboard);
      break;
    case 'invite':
      const refCode = 'UB-' + query.from.id.toString(36).toUpperCase();
      await bot.sendMessage(chatId,
        `🔗 የእርስዎ ሊንክ:\nhttps://t.me/UltraBingoBot?start=${refCode}\n\nለእያንዳንዱ ጓደኛ +5 ብር`,
        mainKeyboard
      );
      break;
    case 'support':
      await bot.sendMessage(chatId, '🎧 Support: @UltraBingoSupport\n\n📞 +251 953 025 980', mainKeyboard);
      break;
  }
});

// ════════════════════════════════════════════════
//   ERROR HANDLING
// ════════════════════════════════════════════════
bot.on('polling_error', (err) => logger.error('Polling error:', err.message));
bot.on('webhook_error', (err) => logger.error('Webhook error:', err.message));

process.on('SIGINT', () => {
  logger.info('Bot shutting down...');
  bot.stopPolling();
  process.exit(0);
});

logger.info('✅ Bot is running. Send /start to test.');
