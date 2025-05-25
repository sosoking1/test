// models/User.js
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstSeen: { type: Date, default: Date.now },
  lastMessage: String,          // Track last user message
  lastResponse: String,         // Track last bot response
  messageCount: { type: Number, default: 0 },  // Track total messages
  updatedAt: { type: Date, default: Date.now } // Auto-updated timestamp
});

// Add index for better performance
userSchema.index({ userId: 1 });
userSchema.index({ updatedAt: 1 });

// Update timestamp before saving
userSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('User', userSchema);