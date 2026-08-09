'use strict';
/**
 * Rimuru Tempest Casino — main bot router.
 * Wires node-telegram-bot-api to every module. Handles commands, inline
 * callbacks, penalties (ban/sus/mute), and the "Rimuru" AI trigger.
 */
const TelegramBot = require('node-telegram-bot-api');

const config = require('./config');
const db = require('./db');
const eco = require('./economy');
const cd = require('./cooldowns');
const admin = require('./admin');
const leaderboard = require('./leaderboard');
const rimuru = require('./rimuru');
const income = require('./income');
const { fmt, humanDuration } = require('./utils');

const slots = require('./games/slots');
const dice = require('./games/dice');
const coinflip = require('./games/coinflip');
const mines = require('./games/mines');
const blackjack = require('./games/blackjack');
const roulette = require('./games/roulette');
const higherlower = require('./games/higherlower');
const lottery = require('./games/lottery');
const robbery = require('./crimes/robbery');
const heist = require('./crimes/heist');

// In-memory heist timers (leaderId -> timeout)
const heistTimers = new Map();

function createBot() {
  const bot = new TelegramBot(config.telegramToken, {
    polling: true,
    onlyFirstMatch: false,
    filepath: false,
  });

  /* ---------- helpers ---------- */

  function metaOf(msg) {
    const from = msg.from || {};
    return { username: from.username || '', first_name: from.first_name || '' };
  }

  function isOwner(userId) {
    return String(userId) === String(config.ownerId);
  }

  /** Reply wrapper that tolerates parse_mode issues. */
  async function reply(chatId, text, opts = {}) {
    try {
      return await bot.sendMessage(chatId, text, opts);
    } catch (e) {
      console.warn('[reply] fallback (stripping markdown):', e.message);
      const plain = String(text).replace(/[*_`\[\]]/g, '');
      try {
        return await bot.sendMessage(chatId, plain, { ...opts, parse_mode: undefined });
      } catch (e2) {
        console.error('[reply] failed:', e2.message);
        return null;
      }
    }
  }

  async function editMsg(chatId, messageId, text, opts = {}) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
    } catch (e) {
      console.warn('[edit] failed:', e.message);
      return null;
    }
  }

  function buildCtx(msg, args = []) {
    const from = msg.from || {};
    return {
      bot,
      msg,
      args,
      chatId: msg.chat.id,
      userId: from.id,
      isOwner: isOwner(from.id),
      eco,
      cd,
      config,
      db,
      reply: (t, o) => reply(msg.chat.id, t, o),
      editMsg: (chatId, messageId, t, o) => editMsg(chatId, messageId, t, o),
      answerCb: (text) => bot.answerCallbackQuery(text && text.query_id ? text.query_id : undefined, text && text.text ? { text: text.text } : {}).catch(() => {}),
    };
  }

  /** Parse "/cmd arg1 arg2" from message text. */
  function parseCommand(text) {
    const t = String(text || '').trim();
    if (!t.startsWith('/')) return null;
    const parts = t.slice(1).split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    return { cmd, args: parts.slice(1) };
  }

  /** Resolve a replied-to user (for /rob, /heist, /donate, /transfer). */
  function repliedUser(msg) {
    const r = msg.reply_to_message;
    if (!r || !r.from) return null;
    return r.from;
  }

  /* ---------- penalty gating ---------- */

  function canInteract(userId, gambling = true) {
    return admin.checkInteract(userId, { gambling });
  }

  /* ---------- command handlers ---------- */

  const handlers = {
    start: async (ctx) => {
      const u = eco.ensure(ctx.userId, metaOf(ctx.msg));
      await ctx.reply(
        `🐉 **RIMURU TEMPEST CASINO**\n\n` +
        `Welcome, ${u.first_name || 'mortal'}. The house always wins — but I'll let you play.\n` +
        `You start with **${fmt(config.startBalance)}** coins.\n\n` +
        `🎮 Games: /slots /dice /cf /mines /bj /roulette /hl /lottery\n` +
        `💰 Economy: /balance /dep /wd /donate /transfer\n` +
        `🦹 Crime: /rob /heist\n` +
        `💵 Income: /beg /work /fish /dig /daily /bonus\n` +
        `🏆 /lb — rich list\n` +
        `❓ /help — everything\n\n` +
        `_Say "Rimuru" to talk to me directly._`,
        { parse_mode: 'Markdown' }
      );
    },

    help: async (ctx) => {
      await ctx.reply(
        `🐉 **RIMURU'S HELP**\n\n` +
        `**🎮 Games** (2 min cooldown)\n` +
        `• /slots [amt] — 3 reels, 2x/4x\n` +
        `• /dice [1-6] [amt] — animated dice, 6x\n` +
        `• /cf [heads|tails] [amt] — 2x\n` +
        `• /mines [amt] — 5×5 minefield, cash out anytime\n` +
        `• /bj [amt] — blackjack, 3:2 on blackjack\n` +
        `• /roulette [color|even|odd|high|low|dozen|column|straight|split] [amt]\n` +
        `• /hl [amt] — higher or lower, streak multiplier\n` +
        `• /lottery [buy|draw|status] [n] — tickets 10k, 5 buyers = draw\n\n` +
        `**💰 Economy**\n` +
        `• /balance — wallet + bank\n` +
        `• /dep [amt|all] — wallet → bank\n` +
        `• /wd [amt|all] — bank → wallet\n` +
        `• /donate [amt] (reply) — from wallet\n` +
        `• /transfer [amt] (reply) — from bank\n\n` +
        `**🦹 Crime**\n` +
        `• /rob (reply) — 10 min cooldown, fail = fine\n` +
        `• /heist (reply) — 20 min, open 60s for /join, max 5 crew\n` +
        `• /join — join an open heist\n\n` +
        `**💵 Income**\n` +
        `• /beg /work /fish /dig — quick coins\n` +
        `• /daily — 24h • /bonus — weekly\n\n` +
        `**🏆 /lb** — top 10 richest\n` +
        `**🤖** Say "Rimuru" in chat to talk to me.`,
        { parse_mode: 'Markdown' }
      );
    },

    balance: async (ctx) => {
      const u = eco.ensure(ctx.userId, metaOf(ctx.msg));
      await ctx.reply(
        `👛 **${u.first_name || 'Your'} BALANCE**\n\n` +
        `Wallet (rob-able): **${fmt(u.wallet)}**\n` +
        `Bank (safe): **${fmt(u.bank)}**\n` +
        `Net worth: **${fmt(u.wallet + u.bank)}**`,
        { parse_mode: 'Markdown' }
      );
    },

    dep: async (ctx) => {
      const r = eco.deposit(ctx.userId, ctx.args[0]);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },
    deposit: async (ctx) => {
      const r = eco.deposit(ctx.userId, ctx.args[0]);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },
    wd: async (ctx) => {
      const r = eco.withdraw(ctx.userId, ctx.args[0]);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },
    withdraw: async (ctx) => {
      const r = eco.withdraw(ctx.userId, ctx.args[0]);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },

    donate: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('🎩 Reply to someone with `/donate [amount]`.');
      const r = eco.donate(ctx.userId, target.id, ctx.args[0]);
      await ctx.reply(r.message, { parse_mode: 'HTML' });
    },
    transfer: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('🎩 Reply to someone with `/transfer [amount]`.');
      const r = eco.transfer(ctx.userId, target.id, ctx.args[0]);
      await ctx.reply(r.message, { parse_mode: 'HTML' });
    },

    // ----- games -----
    slots: async (ctx) => slots.play(ctx),
    dice: async (ctx) => dice.play(ctx),
    cf: async (ctx) => coinflip.play(ctx),
    coinflip: async (ctx) => coinflip.play(ctx),
    mines: async (ctx) => mines.play(ctx),
    bj: async (ctx) => blackjack.play(ctx),
    blackjack: async (ctx) => blackjack.play(ctx),
    roulette: async (ctx) => roulette.play(ctx),
    hl: async (ctx) => higherlower.play(ctx),
    higherlower: async (ctx) => higherlower.play(ctx),

    lottery: async (ctx) => {
      const sub = (ctx.args[0] || 'status').toLowerCase();
      if (sub === 'buy') {
        const r = lottery.buy(ctx.userId, ctx.args[1] || 1, metaOf(ctx.msg));
        if (r.ok && r.buyers >= config.lottery.minBuyers) {
          // Enough buyers — run the draw right away
          const d = lottery.draw();
          await ctx.reply(`${r.message}\n\n${d.message}`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(r.message, { parse_mode: 'Markdown' });
        }
        return;
      }
      if (sub === 'draw') {
        const d = lottery.draw();
        await ctx.reply(d.message, { parse_mode: 'HTML' });
        return;
      }
      await ctx.reply(lottery.status(), { parse_mode: 'Markdown' });
    },

    // ----- crimes -----
    rob: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('🎩 Reply to someone with `/rob`.');
      const g = cd.guard(ctx.userId, 'rob', 'Robbery');
      if (g.blocked) return ctx.reply(g.message);
      const r = robbery.attempt(ctx.userId, target.id, metaOf(ctx.msg));
      if (r.ok) cd.start(ctx.userId, 'rob', config.cooldowns.rob);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },

    heist: async (ctx) => {
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('🎩 Reply to someone with `/heist`.');
      const g = cd.guard(ctx.userId, 'heist', 'Heist');
      if (g.blocked) return ctx.reply(g.message);
      const r = heist.start(ctx.userId, target.id, metaOf(ctx.msg));
      if (r.ok) {
        cd.start(ctx.userId, 'heist', config.cooldowns.heist);
        scheduleHeist(ctx, r.heist);
      }
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },

    join: async (ctx) => {
      const r = heist.join(ctx.userId, metaOf(ctx.msg));
      if (r.ok && r.message) {
        // If the crew filled up, execute immediately
        const h = db.getHeist(ctx.userId);
        const open = db.db.prepare("SELECT * FROM heists WHERE status = 'open'").all();
        const fullCrew = open.some((o) => JSON.parse(o.members).length >= config.heist.maxMembers);
        await ctx.reply(r.message, { parse_mode: 'Markdown' });
        if (fullCrew) {
          const full = open.find((o) => JSON.parse(o.members).length >= config.heist.maxMembers);
          if (full) {
            const res = heist.execute(full.leader_id);
            const timer = heistTimers.get(full.leader_id);
            if (timer) clearTimeout(timer);
            heistTimers.delete(full.leader_id);
            await ctx.reply(res.message, { parse_mode: 'HTML' });
          }
        }
      } else {
        await ctx.reply(r.message, { parse_mode: 'Markdown' });
      }
    },

    // ----- income -----
    beg: async (ctx) => { const r = income.earn(ctx.userId, 'beg', metaOf(ctx.msg)); await ctx.reply(r.message, { parse_mode: 'Markdown' }); },
    work: async (ctx) => { const r = income.earn(ctx.userId, 'work', metaOf(ctx.msg)); await ctx.reply(r.message, { parse_mode: 'Markdown' }); },
    fish: async (ctx) => { const r = income.earn(ctx.userId, 'fish', metaOf(ctx.msg)); await ctx.reply(r.message, { parse_mode: 'Markdown' }); },
    dig: async (ctx) => { const r = income.earn(ctx.userId, 'dig', metaOf(ctx.msg)); await ctx.reply(r.message, { parse_mode: 'Markdown' }); },
    daily: async (ctx) => { const r = income.daily(ctx.userId, metaOf(ctx.msg)); await ctx.reply(r.message, { parse_mode: 'Markdown' }); },
    bonus: async (ctx) => { const r = income.bonus(ctx.userId, metaOf(ctx.msg)); await ctx.reply(r.message, { parse_mode: 'Markdown' }); },

    // ----- leaderboard -----
    lb: async (ctx) => { await ctx.reply(leaderboard.render(), { parse_mode: 'Markdown' }); },
    leaderboard: async (ctx) => { await ctx.reply(leaderboard.render(), { parse_mode: 'Markdown' }); },

    // ----- admin (owner only) -----
    ban: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('👑 Only the King can do that.');
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('🎩 Reply to someone with `/ban [reason]` or `/ban [duration] [reason]`.');
      const { dur, reason } = splitDurReason(ctx.args);
      const r = admin.applyPenalty(target.id, admin.STATUS.BANNED, reason, dur);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },
    sus: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('👑 Only the King can do that.');
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('🎩 Reply to someone with `/sus [reason]`.');
      const { dur, reason } = splitDurReason(ctx.args);
      const r = admin.applyPenalty(target.id, admin.STATUS.SUSPECTED, reason, dur);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },
    mute: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('👑 Only the King can do that.');
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('🎩 Reply to someone with `/mute [reason]`.');
      const { dur, reason } = splitDurReason(ctx.args);
      const r = admin.applyPenalty(target.id, admin.STATUS.MUTED, reason, dur);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },
    unban: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('👑 Only the King can do that.');
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('🎩 Reply to someone with `/unban`.');
      const r = admin.liftPenalty(target.id);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },
    unsus: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('👑 Only the King can do that.');
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('🎩 Reply to someone with `/unsus`.');
      const r = admin.liftPenalty(target.id);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },
    unmute: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply('👑 Only the King can do that.');
      const target = repliedUser(ctx.msg);
      if (!target) return ctx.reply('🎩 Reply to someone with `/unmute`.');
      const r = admin.liftPenalty(target.id);
      await ctx.reply(r.message, { parse_mode: 'Markdown' });
    },
  };

  /** Split "/ban 2h spamming" → { dur: '2h', reason: 'spamming' } */
  function splitDurReason(args) {
    if (!args.length) return { dur: null, reason: '' };
    if (admin.parseDuration(args[0])) {
      return { dur: args[0], reason: args.slice(1).join(' ') };
    }
    return { dur: null, reason: args.join(' ') };
  }

  /** Schedule heist execution after the 60s open window. */
  function scheduleHeist(ctx, heistRow) {
    const timer = heistTimers.get(heistRow.leader_id);
    if (timer) clearTimeout(timer);
    const t = setTimeout(async () => {
      const h = db.getHeist(heistRow.leader_id);
      if (h && h.status === 'open') {
        const res = heist.execute(heistRow.leader_id);
        await reply(
          ctx.msg.chat.id,
          `⏰ **The heist window closed.**\n\n${res.message}`,
          { parse_mode: 'HTML' }
        );
      }
      heistTimers.delete(heistRow.leader_id);
    }, config.heist.openWindowMs);
    heistTimers.set(heistRow.leader_id, t);
  }

  /* ---------- callback routing ---------- */

  async function onCallbackQuery(query) {
    const data = String(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const from = query.from || {};
    const userId = from.id;
    const ctx = buildCtx(query.message || { chat: { id: chatId }, from }, []);

    const answerCb = (text) => bot.answerCallbackQuery(query.id, { text }).catch(() => {});
    const editMsgCb = (text, opts = {}) =>
      editMsg(chatId, messageId, text, { parse_mode: 'Markdown', ...opts });

    // Penalty gate on all callbacks
    const check = canInteract(userId, true);
    if (!check.allowed) {
      if (check.reply) await answerCb(check.reply);
      return;
    }

    try {
      if (data.startsWith('mines:')) {
        const parts = data.split(':');
        const action = parts[2];
        if (action === 'pick') await mines.onPick({ data }, { bot, chatId, userId, reply: (t) => reply(chatId, t), editMsg: editMsgCb, answerCb, eco });
        if (action === 'cash') await mines.onCash({ data }, { bot, chatId, userId, reply: (t) => reply(chatId, t), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data.startsWith('bj:')) {
        await blackjack.onAction({ data }, { bot, chatId, userId, reply: (t) => reply(chatId, t), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      if (data.startsWith('hl:')) {
        await higherlower.onAction({ data }, { bot, chatId, userId, reply: (t) => reply(chatId, t), editMsg: editMsgCb, answerCb, eco });
        return;
      }
      await answerCb('Unknown button.');
    } catch (e) {
      console.error('[callback] error:', e.message);
      await answerCb('Something went wrong.');
    }
  }

  /* ---------- message routing ---------- */

  async function onMessage(msg) {
    // Ignore non-user messages (channel posts, etc.)
    if (!msg.from || msg.from.is_bot) return;
    const text = String(msg.text || msg.caption || '');
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const ctx = buildCtx(msg, []);

    // Expire temporary penalties periodically (cheap)
    db.expirePenalties();

    // Penalty gate for ANY interaction
    const check = canInteract(userId, true);
    if (!check.allowed) {
      if (check.reply && text.startsWith('/')) await reply(chatId, check.reply);
      return;
    }

    // Rimuru AI trigger — any message containing "rimuru" (no command needed)
    if (rimuru.shouldTrigger(text)) {
      const from = msg.from;
      const owner = isOwner(userId);
      const name = from.first_name || from.username || 'mortal';
      try {
        await reply(chatId, '…', {});
        const ans = await rimuru.reply(text, { id: userId, first_name: name, username: from.username, isOwner: owner });
        await bot.sendMessage(chatId, ans);
      } catch (e) {
        console.error('[rimuru] reply error:', e.message);
        await reply(chatId, 'Hmph. The void ate my words. Try again, mortal.');
      }
      return;
    }

    // Command routing
    const parsed = parseCommand(text);
    if (!parsed) return; // not a command, not a Rimuru mention → ignore
    const { cmd, args } = parsed;
    const handler = handlers[cmd];
    if (!handler) return;

    ctx.args = args;
    try {
      await handler(ctx);
    } catch (e) {
      console.error(`[cmd /${cmd}] error:`, e.message, e.stack);
      await reply(chatId, `⚠️ Something went wrong with /${cmd}. Try again.`);
    }
  }

  bot.on('message', onMessage);
  bot.on('callback_query', onCallbackQuery);

  // Periodic: expire penalties (every 30s)
  setInterval(() => {
    const expired = db.expirePenalties();
    for (const u of expired) {
      console.log(`[admin] ${u.status} expired for user ${u.user_id}`);
    }
  }, 30000);

  bot.on('polling_error', (err) => {
    console.error('[polling] error:', err.message);
  });

  return bot;
}

module.exports = { createBot };
