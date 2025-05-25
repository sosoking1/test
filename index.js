// Load environment variables
import 'dotenv/config';

// Dependencies
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import mongoose from 'mongoose';
import OpenAI from 'openai';

// Setup Express app
const app = express();
app.use(bodyParser.json());

// Port
const PORT = process.env.PORT || 3000;

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => console.log('✅ Connected to MongoDB'));

// Define User Schema
const userSchema = new mongoose.Schema({
  userId: String,
  firstSeen: { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

// Initialize OpenAI-compatible client for OpenRouter
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": process.env.SITE_URL || "https://hm-validator.vercel.app",
    "X-Title": "HM dev bot",
  },
});

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Verification failed.');
  }
});

// Handle incoming messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'page') {
      for (const entry of body.entry) {
        for (const msg of entry.messaging) {
          if (msg.message && msg.sender.id) {
            const senderId = msg.sender.id;
            
            // Validate/register user
            let user = await User.findOne({ userId: senderId });
            if (!user) {
              user = new User({ userId: senderId });
              await user.save();
              
              // First-time greeting
              await sendMessage(senderId, "👋 Hello! I'm a bot developed by HmDev. How can I help you?", {
                typing: true,
                quickReplies: getQuickReplies()
              });
              continue;
            }

            // Process message
            if (msg.message.text) {
              const userMessage = msg.message.text.trim().toLowerCase();
              
              if (userMessage.includes('how are you') || userMessage.includes("how are u")) {
                await sendMessage(senderId, "🤖 I'm doing great! How can I assist you today?", {
                  typing: true,
                  buttons: getButtons()
                });
              } else {
                const aiResponse = await getQwenTextResponse(senderId, userMessage);
                await sendMessage(senderId, aiResponse, { typing: true });
              }
            } else if (msg.message.attachments?.[0]?.type === 'image') {
              const imageUrl = msg.message.attachments[0].payload.url;
              const aiResponse = await getQwenImageResponse(senderId, imageUrl);
              await sendMessage(senderId, aiResponse, { typing: true });
            }
          }
        }
      }
      res.status(200).send('EVENT_RECEIVED');
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Get AI text response
async function getQwenTextResponse(userId, message) {
  try {
    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3-235b-a22b:free",
      messages: [
        { 
          role: 'system', 
          content: 'You are a helpful assistant. Keep responses concise and friendly.' 
        },
        { role: 'user', content: message },
      ],
      temperature: 0.7,
    });

    if (!completion.choices?.[0]?.message?.content) {
      throw new Error("Empty response from AI");
    }

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('AI Response Error:', {
      userId,
      error: error.message,
      responseData: error.response?.data,
    });
    return "I'm having trouble connecting to my AI brain. Please try again in a moment!";
  }
}

// Get AI image analysis
async function getQwenImageResponse(userId, imageUrl) {
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

    return completion.choices[0].message.content || "I can see the image but can't describe it right now.";
  } catch (error) {
    console.error('AI Image Analysis Error:', error.message);
    return "I couldn't analyze that image. Please try another one!";
  }
}

// Send typing indicator
async function sendTypingIndicator(recipientId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        sender_action: "typing_on"
      }
    );

    // Random typing delay (1-2 seconds)
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));

    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        sender_action: "typing_off"
      }
    );
  } catch (error) {
    console.error('Typing Indicator Error:', error.response?.data || error.message);
  }
}

// Send message with options
async function sendMessage(recipientId, text, options = {}) {
  const { typing = false, quickReplies = null, buttons = null } = options;

  try {
    if (typing) await sendTypingIndicator(recipientId);

    let messageData = {
      recipient: { id: recipientId },
      message: { text },
    };

    if (quickReplies) {
      messageData.message.quick_replies = quickReplies;
    }

    if (buttons) {
      messageData = {
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: text,
              buttons: buttons
            }
          }
        }
      };
    }

    const response = await axios.post(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`,
      messageData
    );

    console.log('Message sent successfully:', response.data);

  } catch (error) {
    console.error('Message Sending Error:', {
      error: error.message,
      response: error.response?.data,
      recipientId
    });
  }
}

// Quick Replies
function getQuickReplies() {
  return [
    {
      content_type: "text",
      title: "Ask a Question",
      payload: "ask_question"
    },
    {
      content_type: "text",
      title: "Get Help",
      payload: "get_help"
    },
    {
      content_type: "text",
      title: "About Me",
      payload: "about_me"
    }
  ];
}

// Buttons
function getButtons() {
  return [
    {
      type: "web_url",
      url: process.env.SITE_URL || "https://hm-validator.vercel.app",
      title: "Visit My Site"
    },
    {
      type: "postback",
      title: "Talk to Human",
      payload: "HUMAN_AGENT"
    }
  ];
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});