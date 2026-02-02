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
      enum: ['ongoing', 'completed', 'abandoned', 'cancelled_no_first_move'],
      default: 'ongoing',
    },
    result: {
      type: String,
      enum: ['white', 'black', 'draw', null],
      default: null,
    },
    timeControl: {
      time: {
        type: Number, // minutes
        required: true,
      },
      increment: {
        type: Number, // seconds
        required: true,
      },
      label: {
        type: String, // e.g. "3+2"
        required: true,
      },
    },
    clock: {
      whiteTime: {
        type: Number, // milliseconds remaining
      },
      blackTime: {
        type: Number, // milliseconds remaining
      },
      activeColor: {
        type: String, // 'w' or 'b'
        enum: ['w', 'b', null],
        default: null,
      },
      lastMoveAt: {
        type: Number, // timestamp
      },
      firstMoveDeadline: {
        type: Number, // timestamp
      },
      moveCount: {
        type: Number,
        default: 0,
      },
      baseTime: {
        type: Number, // milliseconds
      },
      increment: {
        type: Number, // milliseconds
      },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Game', gameSchema);
