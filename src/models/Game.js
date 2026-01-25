const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema(
  {
    whitePlayer: {
      type: String,
      required: true,
    },
    blackPlayer: {
      type: String,
      required: true,
    },
    pgn: {
      type: String,
    },
    status: {
      type: String,
      enum: ['ongoing', 'completed', 'abandoned'],
      default: 'ongoing',
    },
    result: {
      type: String,
      enum: ['white', 'black', 'draw', null],
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Game', gameSchema);
