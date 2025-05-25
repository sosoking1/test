// bot.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import OpenAI from 'openai';
import User from './models/User.js'; // Your User model
import util from 'util';

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const sleep = util.promisify(setTimeout);
const activeUsers = new Map();

// Database connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// OpenRouter AI setup
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": process.env.SITE_URL || "https://your-site.com",
    "X-Title": "AI Assistant Bot",
  },
});

// Webhook verification
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && 
      req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.status(403).send('Verification failed');
  }
});

// Message processing
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

  if (message.quick_reply?.payload) {
    return handleQuickReply(senderId, message.quick_reply.payload, user);
  }

  if (message.text) {
    await handleTextMessage(senderId, message.text, user);
  } else if (message.attachments?.[0]?.type === 'image') {
    await handleImageMessage(senderId, message.attachments[0].payload.url, user);
  }
}

async function handleTextMessage(senderId, text, user) {
  const cleanText = text.trim().toLowerCase();
  
  await sendTypingOn(senderId);
  await sleep(1500);

  if (user.messageCount === 1) {
    return sendWelcomeSequence(senderId);
  }

  if (isSimilarToLastMessage(user, cleanText)) {
    return sendAlternativeResponse(senderId, user);
  }

  const aiResponse = await getAIResponse(senderId, cleanText);
  await updateUserHistory(senderId, cleanText, aiResponse);
  await sendMessageWithTyping(senderId, aiResponse);
  await sendFollowUp(senderId);
}

async function handleImageMessage(senderId, imageUrl, user) {
  await sendTypingOn(senderId);
  await sendMessageWithTyping(senderId, "Analyzing your image...", { delay: 2000 });
  
  const aiResponse = await getImageAnalysis(senderId, imageUrl);
  await updateUserHistory(senderId, "[image]", aiResponse);
  await sendMessageWithTyping(senderId, aiResponse);
  await sendFollowUp(senderId);
}

// ===== Helper Functions =====
async function sendWelcomeSequence(senderId) {
  await sendMessageWithTyping(senderId, "👋 Hello! I'm your AI assistant.", { delay: 2000 });
  await sleep(1000);
  await sendMessageWithTyping(
    senderId, 
    "How can I help you today?", 
    { quickReplies: getQuickReplies() }
  );
}

async function sendAlternativeResponse(senderId, user) {
  const newResponse = await getAIResponse(
    senderId, 
    `Re-explain differently: ${user.lastMessage}`
  );
  
  await updateUserHistory(senderId, user.lastMessage, newResponse);
  await sendMessageWithTyping(senderId, newResponse);
  await sendMessageWithTyping(
    senderId,
    "I explained this differently. Does it help?",
    { quickReplies: getConfirmationReplies() }
  );
}

async function updateUserHistory(userId, message, response) {
  await User.updateOne(
    { userId },
    { lastMessage: message, lastResponse: response, updatedAt: new Date() }
  );
}

// ===== Messaging Functions =====
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
  const { delay = 1000, quickReplies } = options;
  
  try {
    await sendTypingOn(recipientId);
    await sleep(delay);

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

// ===== AI Functions =====
async function getAIResponse(userId, message) {
  try {
    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3-235b-a22b:free",
      messages: [
        { 
          role: 'system', 
          content: 'Respond concisely in 1-2 sentences. If asked the same question twice, provide alternative explanations.' 
        },
        { role: 'user', content: message },
      ],
      temperature: 0.7,
      max_tokens: 150
    });

    return completion.choices[0]?.message?.content || "Let me think differently about that...";
  } catch (error) {
    console.error('AI error:', error.message);
    return "I'm having trouble thinking right now. Could you ask again?";
  }
}

async function getImageAnalysis(userId, imageUrl) {
  try {
    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3-235b-a22b:free",
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: "Describe this image in detail" },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    });

    return completion.choices[0]?.message?.content || "I can see the image but can't describe it right now.";
  } catch (error) {
    console.error('Image analysis error:', error.message);
    return "I couldn't analyze that image. Please try another one!";
  }
}

// ===== Utilities =====
function isSimilarToLastMessage(user, currentMessage) {
  if (!user.lastMessage || user.messageCount <= 1) return false;
  return calculateSimilarity(user.lastMessage, currentMessage) > 0.7;
}

function calculateSimilarity(str1, str2) {
  const words1 = new Set(str1.split(/\s+/));
  const words2 = new Set(str2.split(/\s+/));
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  return intersection.size / Math.max(words1.size, words2.size);
}

function getQuickReplies() {
  return [
    { content_type: "text", title: "Ask question", payload: "ask_question" },
    { content_type: "text", title: "Get help", payload: "get_help" }
  ];
}

function getConfirmationReplies() {
  return [
    { content_type: "text", title: "Yes, thanks!", payload: "confirm_yes" },
    { content_type: "text", title: "More details", payload: "request_more" }
  ];
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));