import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstSeen: { type: Date, default: Date.now },
});

export default mongoose.model('User', userSchema);