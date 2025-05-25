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
    "X-Title": "Bilingual Assistant",
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

  // Update language preference if detected
  const isArabic = containsArabic(message.text || '');
  if (isArabic && user.preferredLanguage !== 'ar') {
    await User.updateOne({ userId: senderId }, { preferredLanguage: 'ar' });
  }

  if (message.quick_reply?.payload) {
    return handleQuickReply(senderId, message.quick_reply.payload, user);
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
  
  await sendTypingOn(senderId);
  await sleep(isArabic ? 2000 : 1500);

  if (user.messageCount === 1) {
    return sendWelcomeSequence(senderId, isArabic);
  }

  if (isSimilarToLastMessage(user, cleanText)) {
    return sendAlternativeResponse(senderId, user);
  }

  const aiResponse = await getAIResponse(senderId, cleanText, isArabic);
  await updateUserHistory(senderId, cleanText, aiResponse);
  await sendMessageWithTyping(senderId, aiResponse, { isArabic });
  await sendFollowUp(senderId, isArabic);
}

async function handleImageMessage(senderId, imageUrl, user) {
  const isArabic = user.preferredLanguage === 'ar';
  
  await sendTypingOn(senderId);
  await sendMessageWithTyping(
    senderId, 
    isArabic ? "جاري تحليل الصورة..." : "Analyzing your image...", 
    { delay: 2000, isArabic }
  );
  
  const aiResponse = await getImageAnalysis(senderId, imageUrl, isArabic);
  await updateUserHistory(senderId, "[image]", aiResponse);
  await sendMessageWithTyping(senderId, aiResponse, { isArabic });
  await sendFollowUp(senderId, isArabic);
}

// ======================
// AI FUNCTIONS
// ======================

async function getAIResponse(userId, message, isArabic = false) {
  try {
    const systemPrompt = isArabic
      ? "أنت مساعد ذكي يتحدث العربية بطلاقة. أجب بطريقة واضحة ومفيدة."
      : "You are a helpful English assistant. Respond concisely in 1-2 sentences.";

    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3-235b-a22b:free",
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0.7,
      max_tokens: 200
    });

    return completion.choices[0]?.message?.content || 
           (isArabic ? "لم أتمكن من معالجة طلبك، حاول مرة أخرى" : "Let me think differently about that...");
  } catch (error) {
    console.error('AI error:', error.message);
    return isArabic 
      ? "حاول مرة أخرى لاحقاً" 
      : "I'm having trouble thinking right now. Could you ask again?";
  }
}

async function getImageAnalysis(userId, imageUrl, isArabic = false) {
  try {
    const prompt = isArabic 
      ? "صف هذه الصورة بالتفصيل"
      : "Describe this image in detail";

    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3-235b-a22b:free",
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    });

    return completion.choices[0]?.message?.content || 
           (isArabic ? "لا يمكنني تحليل هذه الصورة الآن" : "I can't analyze this image right now");
  } catch (error) {
    console.error('Image analysis error:', error.message);
    return isArabic 
      ? "حدث خطأ أثناء تحليل الصورة" 
      : "Error analyzing image";
  }
}

// ======================
// UTILITY FUNCTIONS
// ======================

function containsArabic(text) {
  return /[\u0600-\u06FF]/.test(text);
}

async function sendWelcomeSequence(senderId, isArabic = false) {
  if (isArabic) {
    await sendMessageWithTyping(senderId, "مرحباً! أنا مساعدك الذكي.", { delay: 2000, isArabic });
    await sendMessageWithTyping(
      senderId, 
      "كيف يمكنني مساعدتك اليوم؟", 
      { delay: 1500, isArabic, quickReplies: getQuickReplies(true) }
    );
  } else {
    await sendMessageWithTyping(senderId, "👋 Hello! I'm your AI assistant.", { delay: 2000 });
    await sendMessageWithTyping(
      senderId, 
      "How can I help you today?", 
      { delay: 1500, quickReplies: getQuickReplies() }
    );
  }
}

async function sendAlternativeResponse(senderId, user) {
  const isArabic = user.preferredLanguage === 'ar';
  const newResponse = await getAIResponse(
    senderId, 
    isArabic 
      ? `اشرح بطريقة مختلفة: ${user.lastMessage}`
      : `Re-explain differently: ${user.lastMessage}`,
    isArabic
  );
  
  await updateUserHistory(senderId, user.lastMessage, newResponse);
  await sendMessageWithTyping(senderId, newResponse, { isArabic });
  await sendFollowUp(senderId, isArabic);
}

async function sendFollowUp(senderId, isArabic = false) {
  await sleep(1000);
  await sendMessageWithTyping(
    senderId,
    isArabic 
      ? "هل هذا يجيب على سؤالك؟" 
      : "Does this answer your question?",
    {
      quickReplies: getConfirmationReplies(isArabic),
      isArabic
    }
  );
}

async function updateUserHistory(userId, message, response) {
  await User.updateOne(
    { userId },
    { lastMessage: message, lastResponse: response, updatedAt: new Date() }
  );
}

async function sendTypingOn(recipientId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, sender_action: "typing_on" }
    );
  } catch (error) {
    console.error('Typing error:', error.response?.data || error.message);
  }
}

async function sendMessageWithTyping(recipientId, text, options = {}) {
  const { delay = 1000, isArabic = false, quickReplies } = options;
  
  try {
    await sendTypingOn(recipientId);
    await sleep(isArabic ? delay + 500 : delay); // Longer delay for Arabic

    const messageData = {
      recipient: { id: recipientId },
      message: { text, ...(quickReplies && { quick_replies: quickReplies }) }
    };

    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`,
      messageData
    );
  } catch (error) {
    console.error('Message failed:', error.response?.data || error.message);
  }
}

function isSimilarToLastMessage(user, currentMessage) {
  if (!user.lastMessage || user.messageCount <= 1) return false;
  return calculateSimilarity(user.lastMessage, currentMessage) > 0.7;
}

function calculateSimilarity(str1, str2) {
  const words1 = new Set(str1.toLowerCase().split(/\s+/));
  const words2 = new Set(str2.toLowerCase().split(/\s+/));
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  return intersection.size / Math.max(words1.size, words2.size);
}

function getQuickReplies(isArabic = false) {
  return isArabic
    ? [
        { content_type: "text", title: "طرح سؤال", payload: "ask_question_ar" },
        { content_type: "text", title: "مساعدة", payload: "get_help_ar" }
      ]
    : [
        { content_type: "text", title: "Ask question", payload: "ask_question" },
        { content_type: "text", title: "Get help", payload: "get_help" }
      ];
}

function getConfirmationReplies(isArabic = false) {
  return isArabic
    ? [
        { content_type: "text", title: "نعم، شكرًا", payload: "confirm_yes_ar" },
        { content_type: "text", title: "مزيد من التفاصيل", payload: "request_more_ar" }
      ]
    : [
        { content_type: "text", title: "Yes, thanks!", payload: "confirm_yes" },
        { content_type: "text", title: "More details", payload: "request_more" }
      ];
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));