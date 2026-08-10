'use strict';
/**
 * Rimuru Tempest Casino — native ReplyKeyboardMarkup (custom reply keyboard).
 *
 * This is Telegram's NATIVE reply keyboard — the grid of buttons that
 * appears ABOVE the phone keyboard when the user taps the keyboard/grid
 * toggle in the message input area. NOT inline buttons, NOT the ☰ command
 * menu, NOT a side menu.
 *
 * Tapping a button sends its text as a NORMAL message, which bot.js maps
 * back to the matching command (see BUTTON_COMMANDS).
 *
 * Design:
 *   - Main keyboard (shown after /start): 3 rows × 2 buttons.
 *   - Sub-keyboards (Casino / Games / Economy): replace the main one in
 *     the same space; each has a 🔙 Back button returning to main.
 *   - NOT persistent (is_persistent: false) — the user can hide/unhide it
 *     with Telegram's keyboard toggle button.
 *   - Stays open after each tap (one_time_keyboard: false) — it only closes
 *     when the user taps the typing box or the toggle button.
 */
const config = require('./config');

/* ---- button labels (must EXACTLY match what users tap) ----
 * Colored emoji prefixes fake color-coding (Telegram reply keyboards have
 * no native colors): 🟡 games/caution, 🔴 risk, 🟢 safe, 🟣 special,
 * ⚫ neutral, 🔵 navigation. */
const B = {
  casino: '\ud83d\udfe3 Casino',
  games: '\ud83d\udfe3 Games',
  balance: '\ud83d\udfe2 Balance',
  economy: '\ud83d\udfe2 Economy',
  leaderboard: '\ud83c\udfc6 Leaderboard',
  help: '\ud83d\udd35 Help',
  slots: '\ud83d\udfe1 Slots',
  blackjack: '\ud83d\udfe1 Blackjack',
  roulette: '\ud83d\udfe1 Roulette',
  race: '\ud83d\udfe1 Race',
  dice: '\ud83d\udfe1 Dice',
  coinflip: '\ud83d\udfe1 Coin Flip',
  mines: '\ud83d\udd34 Mines',
  higherlower: '\ud83d\udfe1 Higher/Lower',
  lottery: '\ud83d\udfe1 Lottery',
  bank: '\ud83d\udfe2 Bank',
  income: '\ud83d\udfe2 Income',
  shop: '\ud83d\udfe3 Shop',
  crime: '\ud83d\udd34 Crime',
  fish: '\ud83d\udfe2 Fish',
  profile: '\ud83d\udfe3 Profile',
  back: '\u26ab Back',
};

/**
 * Map a tapped button text → the command/menu page it triggers.
 * Return value: { cmd } for game/economy commands, { page } for
 * sub-keyboard pages, { back: true } for the main keyboard.
 */
const BUTTON_COMMANDS = {
  [B.casino]: { page: 'casino' },
  [B.games]: { page: 'games' },
  [B.economy]: { page: 'economy' },
  [B.balance]: { cmd: 'balance' },
  [B.leaderboard]: { cmd: 'leaderboard' },
  [B.help]: { cmd: 'help' },
  [B.slots]: { cmd: 'slots' },
  [B.blackjack]: { cmd: 'blackjack' },
  [B.roulette]: { cmd: 'roulette' },
  [B.race]: { cmd: 'race' },
  [B.dice]: { cmd: 'dice' },
  [B.coinflip]: { cmd: 'coinflip' },
  [B.mines]: { cmd: 'mines' },
  [B.higherlower]: { cmd: 'higherlower' },
  [B.lottery]: { cmd: 'lottery' },
  [B.bank]: { cmd: 'bank' },
  [B.income]: { cmd: 'income' },
  [B.shop]: { cmd: 'shop' },
  [B.crime]: { cmd: 'crime' },
  [B.fish]: { cmd: 'fish' },
  [B.profile]: { cmd: 'profile' },
  [B.back]: { back: true },
};

/**
 * Build a native reply-keyboard markup object.
 * @param {string[][]} rows rows of button LABELS (strings)
 */
function kb(rows) {
  return {
    keyboard: rows.map((row) => row.map((label) => ({ text: label }))),
    resize_keyboard: true,
    is_persistent: false,
    one_time_keyboard: false,
    input_field_placeholder: 'Choose an option…',
  };
}

/** Main keyboard — 3 rows × 2 buttons. */
const mainKeyboard = () =>
  kb([
    [B.casino, B.games],
    [B.balance, B.economy],
    [B.leaderboard, B.help],
  ]);

/** 🎮 Games sub-keyboard. */
const gamesKeyboard = () =>
  kb([
    [B.dice, B.coinflip],
    [B.mines, B.higherlower],
    [B.lottery, B.back],
  ]);

/** 🎰 Casino sub-keyboard. */
const casinoKeyboard = () =>
  kb([
    [B.slots, B.blackjack],
    [B.roulette, B.race],
    [B.back],
  ]);

/** 💼 Economy sub-keyboard. */
const economyKeyboard = () =>
  kb([
    [B.balance, B.bank],
    [B.income, B.shop],
    [B.crime, B.leaderboard],
    [B.profile, B.back],
  ]);

/** All keyboard builders by page name. */
const KEYBOARDS = {
  main: mainKeyboard,
  casino: casinoKeyboard,
  games: gamesKeyboard,
  economy: economyKeyboard,
};

/**
 * reply_markup object for a page ('main' | 'casino' | 'games' | 'economy').
 * Used as the reply_markup on the bot's response message so the keyboard
 * persists in the input area above the phone keyboard.
 */
function keyboardFor(page) {
  const builder = KEYBOARDS[page] || mainKeyboard;
  return builder();
}

/** Reverse lookup: given tapped text, return { cmd } | { page } | { back }. */
function routeButton(text) {
  return BUTTON_COMMANDS[String(text || '').trim()] || null;
}

module.exports = {
  B,
  BUTTON_COMMANDS,
  kb,
  mainKeyboard,
  casinoKeyboard,
  gamesKeyboard,
  economyKeyboard,
  KEYBOARDS,
  keyboardFor,
  routeButton,
};