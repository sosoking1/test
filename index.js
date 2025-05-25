import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import OpenAI from 'openai';
import util from 'util';

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const sleep = util.promisify(setTimeout);
const activeUsers = new Map();

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// User Model
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstSeen: { type: Date, default: Date.now },
  lastMessage: String,
  lastResponse: String,
  messageCount: { type: Number, default: 0 },
  preferredLanguage: { type: String, enum: ['en', 'ar'], default: 'en' },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// AI Configuration
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": process.env.SITE_URL || "https://your-site.com",
    "X-Title": "Smart Assistant",
    "X-Preferred-Language": "auto"
  },
});

// ======================
// CORE FUNCTIONS
// ======================

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && 
      req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.status(403).send('Verification failed');
  }
});

app.post('/webhook', async (req, res) => {
  if (req.body.object !== 'page') return res.sendStatus(404);

  try {
    await Promise.all(req.body.entry.map(processEntry));
    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Server error');
  }
});

async function processEntry(entry) {
  for (const msg of entry.messaging) {
    if (!msg.message || !msg.sender?.id) continue;
    
    const senderId = msg.sender.id;
    if (activeUsers.has(senderId)) continue;
    
    activeUsers.set(senderId, true);
    try {
      await processMessage(senderId, msg.message);
    } finally {
      activeUsers.delete(senderId);
    }
  }
}

async function processMessage(senderId, message) {
  const user = await User.findOneAndUpdate(
    { userId: senderId },
    { $inc: { messageCount: 1 } },
    { upsert: true, new: true }
  );

  // Handle quick replies first
  if (message.quick_reply?.payload) {
    return handleQuickReply(senderId, message.quick_reply.payload, user);
  }

  // Update language preference
  const isArabic = containsArabic(message.text || '');
  if (isArabic && user.preferredLanguage !== 'ar') {
    await User.updateOne({ userId: senderId }, { preferredLanguage: 'ar' });
  }

  if (message.text) {
    await handleTextMessage(senderId, message.text, user);
  } else if (message.attachments?.[0]?.type === 'image') {
    await handleImageMessage(senderId, message.attachments[0].payload.url, user);
  }
}

// ======================
// MESSAGE HANDLERS
// ======================

async function handleTextMessage(senderId, text, user) {
  const cleanText = text.trim();
  const isArabic = user.preferredLanguage === 'ar' || containsArabic(cleanText);
  
  // Don't process confirmation responses
  if (isConfirmationResponse(cleanText, isArabic)) {
    return;
  }

  await sendTypingOn(senderId);
  await sleep(isArabic ? 2000 : 1500);

  if (user.messageCount === 1) {
    return sendWelcomeSequence(senderId, isArabic);
  }

  const aiResponse = await getAIResponse(senderId, cleanText, isArabic);
  
  // Only send follow-up if we got a valid response
  if (!aiResponse.includes("I'm having trouble") && 
      !aiResponse.includes("حاول مرة أخرى")) {
    await updateUserHistory(senderId, cleanText, aiResponse);
    await sendMessageWithTyping(senderId, aiResponse, { isArabic });
    await sendFollowUp(senderId, isArabic);
  } else {
    // If AI failed, just send the error message without follow-up
    await sendMessageWithTyping(senderId, aiResponse, { isArabic });
  }
}

async function handleQuickReply(senderId, payload, user) {
  const isArabic = user.preferredLanguage === 'ar';
  
  switch(payload) {
    case 'confirm_yes':
    case 'confirm_yes_ar':
      await sendMessageWithTyping(
        senderId,
        isArabic ? "حسناً، ممتاز!" : "Great! Let me know if you need anything else.",
        { isArabic }
      );
      break;
      
    case 'request_more':
    case 'request_more_ar':
      if (user.lastResponse) {
        await sendMessageWithTyping(
          senderId,
          isArabic ? "سأشرح أكثر:" : "Let me elaborate:",
          { isArabic }
        );
        await sendMessageWithTyping(senderId, user.lastResponse, { isArabic });
      }
      break;
  }
}

// ======================
// IMPROVED AI FUNCTIONS
// ======================

async function getAIResponse(userId, message, isArabic = false) {
  try {
    const systemPrompt = isArabic
      ? "أنت مساعد ذكي يتحدث العربية. أجب بطريقة مفيدة واحترافية."
      : "You are a helpful assistant. Respond concisely and professionally.";

    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3-235b-a22b:free",
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0.7,
      max_tokens: 200
    });

    const response = completion.choices[0]?.message?.content;
    
    // Validate response quality
    if (!response || response.length < 5) {
      throw new Error("Empty or invalid response from AI");
    }
    
    return response;
    
  } catch (error) {
    console.error('AI error:', error.message);
    return isArabic 
      ? "عذراً، حدث خطأ ما. يرجى المحاولة مرة أخرى." 
      : "Sorry, I encountered an error. Please try again.";
  }
}

// ======================
// UTILITY FUNCTIONS
// ======================

function containsArabic(text) {
  return /[\u0600-\u06FF]/.test(text);
}

function isConfirmationResponse(text, isArabic) {
  const confirmations = isArabic
    ? ["نعم", "نعم، شكرًا", "yes", "yes, thanks"]
    : ["yes", "yes, thanks", "نعم", "نعم، شكرًا"];
  return confirmations.includes(text.toLowerCase());
}

async function sendWelcomeSequence(senderId, isArabic = false) {
  const welcomeMsg = isArabic
    ? "مرحباً! أنا مساعدك الذكي. كيف يمكنني مساعدتك اليوم؟"
    : "Hello! I'm your AI assistant. How can I help you today?";
  
  await sendMessageWithTyping(senderId, welcomeMsg, { 
    delay: 2000, 
    isArabic,
    quickReplies: getQuickReplies(isArabic)
  });
}

async function sendFollowUp(senderId, isArabic = false) {
  await sleep(1000);
  await sendMessageWithTyping(
    senderId,
    isArabic ? "هل هذا ما كنت تبحث عنه؟" : "Did this answer your question?",
    {
      quickReplies: getConfirmationReplies(isArabic),
      isArabic
    }
  );
}

// ... (keep all other utility functions from previous code) ...

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));