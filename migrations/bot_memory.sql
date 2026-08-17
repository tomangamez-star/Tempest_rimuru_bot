-- Rimuru Tempest Casino — Bot Memory Table
-- Run this in your Supabase SQL Editor to create the bot_memory table.
-- This table stores Rimuru AI's persistent memories (user info, group events,
-- coin stats, bot facts, conversation context).

CREATE TABLE IF NOT EXISTS bot_memory (
  id         SERIAL PRIMARY KEY,
  key        TEXT UNIQUE NOT NULL,
  value      JSONB NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast category lookups
CREATE INDEX IF NOT EXISTS idx_bot_memory_category ON bot_memory (category);

-- Index for fast key lookups
CREATE INDEX IF NOT EXISTS idx_bot_memory_key ON bot_memory (key);
