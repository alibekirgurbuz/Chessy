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
      enum: ['white', 'black', 'draw', 'aborted', null],
      default: null,
    },
    resultReason: {
      type: String,
      default: null,
    },
    disconnectedPlayerId: {
      type: String, // userId of the disconnected player
      default: null,
    },
    disconnectDeadlineAt: {
      type: Number, // timestamp
      default: null,
    },
    // Private room fields
    roomId: {
      type: String,
      index: true,
    },
    isPrivate: {
      type: Boolean,
      default: false,
    },
    roomStatus: {
      type: String,
      enum: ['waiting', 'playing', 'completed', 'expired', null],
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
    queuedPremoves: {
      white: {
        from: { type: String, default: null },
        to: { type: String, default: null },
        promotion: { type: String, default: null },
      },
      black: {
        from: { type: String, default: null },
        to: { type: String, default: null },
        promotion: { type: String, default: null },
      },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Game', gameSchema);
