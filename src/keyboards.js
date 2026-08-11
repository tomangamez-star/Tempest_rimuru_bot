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
 * NATIVE COLORED BUTTONS (Bot API 9.4 — KeyboardButton.style):
 *   Telegram's ReplyKeyboardMarkup supports `KeyboardButton.style` with the
 *   values bg_primary (blue), bg_danger (red), bg_success (green). The
 *   Telegram client renders the ACTUAL colored keyboard UI; the bot only
 *   sends the ReplyKeyboardMarkup with the appropriate styles. We do NOT
 *   fake colors with emoji, do NOT build an inline keyboard, and do NOT use
 *   the three-line menu.
 *
 *   - bg_success (green) — safe economy actions (balance/bank/income/fish)
 *   - bg_primary (blue)  — navigation & games (casino/games/shop/profile)
 *   - bg_danger  (red)   — risk actions (crime/mines/back)
 *
 *   The original emoji labels (💰 Balance, 🎰 Slots, ...) are kept ON TOP
 *   of the colored backgrounds.
 *
 * Design:
 *   - Main keyboard (shown after /start): 3 rows × 2 buttons.
 *   - Sub-keyboards (Casino / Games / Economy): replace the main one in
 *     the same space; each has a ↩ Back button returning to main.
 *   - NOT persistent (is_persistent: false) — the user can hide/unhide it
 *     with Telegram's keyboard toggle button.
 *   - Stays open after each tap (one_time_keyboard: false) — it only closes
 *     when the user taps the typing box or the toggle button.
 */

/* Bot API 9.4 KeyboardButton.style values */
const STYLE = {
  PRIMARY: 'bg_primary', // blue
  DANGER: 'bg_danger',   // red
  SUCCESS: 'bg_success', // green
};

/* ---- button labels (must EXACTLY match what users tap) ----
 * Original emoji labels — the native colored background is applied via
 * KeyboardButton.style (bg_success / bg_primary / bg_danger). */
const B = {
  casino: '🎰 Casino',
  games: '🎮 Games',
  balance: '💰 Balance',
  economy: '💼 Economy',
  leaderboard: '🏆 Leaderboard',
  help: '❓ Help',
  slots: '🎰 Slots',
  blackjack: '🃏 Blackjack',
  roulette: '🎡 Roulette',
  race: '🏁 Race',
  dice: '🎲 Dice',
  coinflip: '🪙 Coin Flip',
  mines: '💣 Mines',
  higherlower: '📈 Higher/Lower',
  lottery: '🎟️ Lottery',
  bank: '🏦 Bank',
  income: '💵 Income',
  shop: '🛒 Shop',
  crime: '🕵️ Crime',
  fish: '🎣 Fish',
  profile: '🪪 Profile',
  back: '↩️ Back',
};

/**
 * Map a tapped button text → the command/menu page it triggers.
 * Return value: { cmd } for game/economy commands, { page } for
 * sub-keyboard pages, { back: true } for the main keyboard.
 *
 * FIX (Task 3): routeButton() below is deliberately LOOSE — it strips the
 * leading emoji (and any trailing …/whitespace) before the lookup and also
 * tries a case-insensitive match. Telegram sends the exact label text, but
 * different clients/keyboards can send emoji variations, so the loose match
 * guarantees a tapped button ALWAYS routes to its command.
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
  // New games (typed labels — no emoji) so players can also tap these.
  'Crash': { cmd: 'crash' },
  'Wheel': { cmd: 'wheel' },
  'RPS': { cmd: 'rps' },
  'Tic Tac Toe': { cmd: 'ttt' },
  'Duel': { cmd: 'duel' },
  'Coin Flip Streak': { cmd: 'cfs' },
  'Number Roulette': { cmd: 'num' },
  'Guess Number': { cmd: 'guess' },
};

/**
 * Per-button native style (Bot API 9.4 KeyboardButton.style):
 *   - bg_success (green) — safe economy actions
 *   - bg_primary (blue)  — navigation & games
 *   - bg_danger  (red)   — risk actions & back
 * The Telegram client renders the actual colored UI from these values.
 */
const BUTTON_STYLES = {
  [B.casino]: STYLE.PRIMARY,
  [B.games]: STYLE.PRIMARY,
  [B.balance]: STYLE.SUCCESS,
  [B.economy]: STYLE.SUCCESS,
  [B.leaderboard]: STYLE.SUCCESS,
  [B.help]: STYLE.PRIMARY,
  [B.slots]: STYLE.PRIMARY,
  [B.blackjack]: STYLE.PRIMARY,
  [B.roulette]: STYLE.PRIMARY,
  [B.race]: STYLE.PRIMARY,
  [B.dice]: STYLE.PRIMARY,
  [B.coinflip]: STYLE.PRIMARY,
  [B.mines]: STYLE.DANGER,
  [B.higherlower]: STYLE.PRIMARY,
  [B.lottery]: STYLE.PRIMARY,
  [B.bank]: STYLE.SUCCESS,
  [B.income]: STYLE.SUCCESS,
  [B.shop]: STYLE.PRIMARY,
  [B.crime]: STYLE.DANGER,
  [B.fish]: STYLE.SUCCESS,
  [B.profile]: STYLE.PRIMARY,
  [B.back]: STYLE.DANGER,
};

/**
 * Build a native reply-keyboard markup object with colored KeyboardButtons.
 * @param {string[][]} rows rows of button LABELS (strings)
 * Each button gets { text, style } — style is one of the Bot API 9.4
 * KeyboardButton.style values (bg_primary | bg_danger | bg_success).
 */
function kb(rows) {
  return {
    keyboard: rows.map((row) =>
      row.map((label) => ({
        text: label,
        style: BUTTON_STYLES[label] || STYLE.PRIMARY,
      }))
    ),
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

/** 💼 Economy sub-keyboard. */
const economyKeyboard = () =>
  kb([
    [B.balance, B.bank],
    [B.income, B.shop],
    [B.crime, B.fish],
    [B.profile, B.back],
  ]);

/** 🎰 Casino sub-keyboard (all casino games). */
const casinoKeyboard = () =>
  kb([
    [B.slots, B.blackjack],
    [B.roulette, B.race],
    [B.dice, B.higherlower],
    [B.back],
  ]);

/** 🎮 Games sub-keyboard (all games incl. new ones). */
const gamesKeyboard = () =>
  kb([
    [B.dice, B.coinflip],
    [B.mines, B.lottery],
    [B.higherlower, B.back],
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

/**
 * Reverse lookup: given tapped text, return { cmd } | { page } | { back }.
 * LOOSE matching (FIX Task 3): strips the leading emoji/whitespace and
 * trailing punctuation from the incoming text, then matches exact or
 * case-insensitive (also comparing emoji-stripped keys). This makes button
 * taps route even when a client sends an emoji variant of the label.
 */
const EMOJI_STRIP = /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\s]+/u;
function stripLabel(s) {
  return String(s || '').replace(EMOJI_STRIP, '').replace(/[.…\s]+$/u, '').trim();
}
function routeButton(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // 1) exact
  if (BUTTON_COMMANDS[raw]) return BUTTON_COMMANDS[raw];
  // 2) strip leading emoji + whitespace (and trailing '…'/'...')
  const stripped = stripLabel(raw);
  if (BUTTON_COMMANDS[stripped]) return BUTTON_COMMANDS[stripped];
  // 3) case-insensitive fallback over emoji-stripped keys
  const lower = stripped.toLowerCase();
  for (const k of Object.keys(BUTTON_COMMANDS)) {
    if (stripLabel(k).toLowerCase() === lower) return BUTTON_COMMANDS[k];
  }
  return null;
}

module.exports = {
  B,
  STYLE,
  BUTTON_COMMANDS,
  BUTTON_STYLES,
  kb,
  mainKeyboard,
  casinoKeyboard,
  gamesKeyboard,
  economyKeyboard,
  KEYBOARDS,
  keyboardFor,
  routeButton,
};
