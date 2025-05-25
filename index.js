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
  baseURL: "https://openrouter.ai/api/v1 ",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://your-site.com ", // Replace with your domain
    "X-Title": "HmDev Facebook Bot", // Optional
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
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      for (const msg of entry.messaging) {
        if (msg.message) {
          const senderId = msg.sender.id;

          let user = await User.findOne({ userId: senderId });

          if (!user) {
            user = new User({ userId: senderId });
            await user.save();

            // First-time greeting
            await sendMessage(senderId, "👋 Hello! I'm a bot developed by HmDev. I'm here to help you!", {
              typing: true,
              quickReplies: getQuickReplies()
            });
          } else {
            let userMessage = msg.message.text?.trim().toLowerCase() || '';

            if (userMessage.includes('how are you') || userMessage.includes("how are u")) {
              await sendMessage(senderId, "🤖 I'm Hm Dev Bot!", {
                typing: true,
                buttons: getButtons()
              });
            } else if (msg.message.attachments && msg.message.attachments[0].type === 'image') {
              const imageUrl = msg.message.attachments[0].payload.url;
              const aiResponse = await getQwenImageResponse(senderId, imageUrl);
              await sendMessage(senderId, aiResponse, { typing: true });
            } else if (userMessage) {
              const aiResponse = await getQwenTextResponse(senderId, userMessage);
              await sendMessage(senderId, aiResponse, { typing: true });
            }
          }
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// Get AI response from Qwen3
async function getQwenTextResponse(userId, message) {
  try {
    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3-235b-a22b:free", // Your desired model
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: message },
      ],
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error(`Error getting text response for ${userId}:`, error.response?.data || error.message);
    return 'I am unable to respond at the moment.';
  }
}

// Get AI image analysis from Qwen3
async function getQwenImageResponse(userId, imageUrl, prompt = "What is shown in this image?") {
  try {
    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3-235b-a22b:free", // Your desired model
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

    return completion.choices[0].message.content;
  } catch (error) {
    console.error(`Error getting image response for ${userId}:`, error.response?.data || error.message);
    return 'I could not analyze the image at this time.';
  }
}

// Simulate typing
async function sendTypingIndicator(recipientId) {
  const payload = {
    recipient: { id: recipientId },
    sender_action: "typing_on"
  };

  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages?access_token= ${process.env.PAGE_ACCESS_TOKEN}`,
      payload
    );

    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 1000) + 1000));

    payload.sender_action = "typing_off";
    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages?access_token= ${process.env.PAGE_ACCESS_TOKEN}`,
      payload
    );
  } catch (error) {
    console.error('Error sending typing indicator:', error.response?.data || error.message);
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
              text,
              buttons
            }
          }
        }
      };
    }

    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages?access_token= ${process.env.PAGE_ACCESS_TOKEN}`,
      messageData
    );
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
  }
}

// Quick Replies Template
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

// Buttons Template
function getButtons() {
  return [
    {
      type: "web_url",
      url: "https://yourwebsite.com ",
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