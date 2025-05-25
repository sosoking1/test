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
    return handleConfirmation(senderId, cleanText, isArabic);
  }

  await sendTypingOn(senderId);
  await sleep(isArabic ? 2000 : 1500);

  if (user.messageCount === 1) {
    return sendWelcomeSequence(senderId, isArabic);
  }

  const aiResponse = await getAIResponse(senderId, cleanText, isArabic);
  
  // Only send follow-up if we got a valid response
  if (isValidResponse(aiResponse)) {
    await updateUserHistory(senderId, cleanText, aiResponse);
    await sendMessageWithTyping(senderId, aiResponse, { isArabic });
    await sendFollowUp(senderId, isArabic);
  } else {
    // If AI failed, just send the error message without follow-up
    await sendMessageWithTyping(senderId, aiResponse, { isArabic });
  }
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
  
  if (isValidResponse(aiResponse)) {
    await updateUserHistory(senderId, "[image]", aiResponse);
    await sendMessageWithTyping(senderId, aiResponse, { isArabic });
    await sendFollowUp(senderId, isArabic);
  } else {
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
          isArabic ? "المزيد من التفاصيل:" : "More details:",
          { isArabic }
        );
        await sendMessageWithTyping(senderId, user.lastResponse, { isArabic });
      }
      break;
  }
}

async function handleConfirmation(senderId, text, isArabic) {
  await sendMessageWithTyping(
    senderId,
    isArabic ? "شكراً لك!" : "Thank you!",
    { isArabic }
  );
}

// ======================
// AI FUNCTIONS
// ======================

async function getAIResponse(userId, message, isArabic = false) {
  try {
    const systemPrompt = isArabic
      ? "أنت مساعد ذكي يتحدث العربية. أجب بطريقة واضحة ومفيدة في جملتين كحد أقصى."
      : "You are a helpful assistant. Respond clearly and concisely in 1-2 sentences maximum.";

    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3-235b-a22b:free",
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0.7,
      max_tokens: 150
    });

    const response = completion.choices[0]?.message?.content;
    
    if (!response || response.length < 3) {
      throw new Error("Empty response from AI");
    }
    
    return response;
    
  } catch (error) {
    console.error('AI error:', error.message);
    return isArabic 
      ? "عذراً، لا يمكنني الإجابة الآن. يرجى المحاولة لاحقاً." 
      : "Sorry, I can't respond right now. Please try again later.";
  }
}

async function getImageAnalysis(userId, imageUrl, isArabic = false) {
  try {
    const prompt = isArabic 
      ? "صف هذه الصورة بدقة في جملتين"
      : "Describe this image accurately in 2 sentences";

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

    const response = completion.choices[0]?.message?.content;
    return response || (isArabic ? "لا يمكنني رؤية الصورة بوضوح" : "I can't see the image clearly");
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

function isConfirmationResponse(text, isArabic) {
  const confirmations = isArabic
    ? ["نعم", "نعم، شكرًا", "yes", "yes, thanks", "yes thanks"]
    : ["yes", "yes, thanks", "yes thanks", "نعم", "نعم، شكرًا"];
  return confirmations.includes(text.toLowerCase());
}

function isValidResponse(response) {
  const invalidPatterns = [
    "I'm having trouble",
    "I can't respond",
    "لا يمكنني الإجابة",
    "حدث خطأ"
  ];
  return !invalidPatterns.some(pattern => response.includes(pattern));
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
    isArabic ? "هل وجدت ما تبحث عنه؟" : "Did you find what you needed?",
    {
      quickReplies: getConfirmationReplies(isArabic),
      isArabic
    }
  );
}

async function updateUserHistory(userId, message, response) {
  await User.updateOne(
    { userId },
    { 
      lastMessage: message, 
      lastResponse: response, 
      updatedAt: new Date() 
    }
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
    await sleep(isArabic ? delay + 500 : delay);

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
        { content_type: "text", title: "Yes, thanks", payload: "confirm_yes" },
        { content_type: "text", title: "More details", payload: "request_more" }
      ];
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));