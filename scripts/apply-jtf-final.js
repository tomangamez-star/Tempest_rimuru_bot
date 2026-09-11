'use strict';

/**
 * One-shot applier for JTF Final Integration.
 * Built against Tempest_rimuru_bot main on 2026-09-11.
 * Safe behavior: every required anchor must match exactly once or the script
 * aborts BEFORE writing bot.js.
 */
const fs = require('fs');
const path = require('path');

const botPath = path.join(__dirname, '..', 'src', 'bot.js');
let src = fs.readFileSync(botPath, 'utf8');
let next = src;

function replaceOnce(label, before, after) {
  const first = next.indexOf(before);
  if (first < 0) throw new Error(`[${label}] anchor not found; bot.js was not modified`);
  const second = next.indexOf(before, first + before.length);
  if (second >= 0) throw new Error(`[${label}] anchor matched more than once; bot.js was not modified`);
  next = next.slice(0, first) + after + next.slice(first + before.length);
}

replaceOnce(
  'profile-card require',
  '  profile = require("./profile"),\n  broadcastMod = require("./broadcast"),',
  '  profile = require("./profile"),\n  profileCard = require("./profile-card"),\n  broadcastMod = require("./broadcast"),'
);

replaceOnce(
  'menu profile commands',
  '    { command: "profile", description: "🪪 Profile / Badges" },\n    { command: "help", description: "❓ Help" },',
  '    { command: "profile", description: "🪪 Profile / Badges" },\n' +
  '    { command: "skins", description: "🧍 Profile character skins" },\n' +
  '    { command: "skin", description: "🎭 Equip a profile skin" },\n' +
  '    { command: "help", description: "❓ Help" },'
);

replaceOnce(
  'profile handlers',
`    p: async (ctx) => {
      await ctx.reply(profile.profileText(ctx, ctx.userId), {
        title: "🪪 PROFILE",
        color: THEME.gold,
        html: !0,
      });
    },
    profile: async (ctx) => {
      await ctx.reply(profile.profileText(ctx, ctx.userId), {
        title: "🪪 PROFILE",
        color: THEME.gold,
        html: !0,
      });
    },`,
`    p: async (ctx) => {
      try {
        const card = await profileCard.render(ctx, bot);
        await bot.sendPhoto(ctx.chatId, card.buffer, {
          caption:
            \`🪪 <b>\${card.user.first_name || card.user.username || "PROFILE"}</b>\\n\` +
            \`\${card.profile.emoji} <b>\${card.profile.title}</b>\\n\` +
            \`🎭 \${card.picked.character.name} · \${card.picked.character.title}\\n\` +
            \`🏆 \${card.progress.rank.toUpperCase()}\` +
            (card.progress.nextRank ? \` · \${card.progress.remaining} to \${card.progress.nextRank.toUpperCase()}\` : " · MAX RANK"),
          parse_mode: "HTML",
          reply_to_message_id: ctx.msg && ctx.msg.message_id,
        });
      } catch (e) {
        console.error("[profile-card] render:", e.message);
        await ctx.reply(profile.profileText(ctx, ctx.userId), {
          title: "🪪 PROFILE",
          color: THEME.gold,
          html: !0,
        });
      }
    },
    profile: async (ctx) => handlers.p(ctx),
    skins: async (ctx) => {
      await ctx.reply(
        \`🎭 <b>JTF PROFILE SKINS</b>\\n\\n\${profileCard.listSkins()}\\n\\nEquip with <code>/skin kael</code>\`,
        { title: "🎭 PROFILE SKINS", color: THEME.cyan, html: !0 },
      );
    },
    skin: async (ctx) => {
      const wanted = (ctx.args || []).join(" ").trim();
      if (!wanted) return handlers.skins(ctx);
      const result = profileCard.setSkin(ctx.userId, wanted);
      if (!result.ok)
        return ctx.reply(result.message, {
          title: "🎭 PROFILE SKINS",
          color: THEME.red,
        });
      await ctx.reply(
        \`✅ Equipped <b>\${result.character.name}</b> · \${result.character.title}. Use <code>/p</code> to view it.\`,
        { title: "🎭 SKIN EQUIPPED", color: THEME.gold, html: !0 },
      );
    },`
);

replaceOnce(
  'rank handler',
`    rank: async (ctx) => {
      const u = eco.ensure(ctx.userId, metaOf(ctx.msg)),
        cur = rank.normalizeRank(u.rank || "bronze"),
        idx = rank.rankIndex(cur),
        next = rank.RANKS[idx + 1],
        need = next ? rank.THRESHOLDS[idx + 1] : null,
        have = Number(u.rank_valid_matches || 0),
        remain = next ? Math.max(0, need - have) : 0,
        emoji = ["🥉", "🥈", "🥇", "💠", "💎", "🔮", "👑", "🌌"][idx] || "🥉",
        caption = \`\${emoji} <b>\${cur.toUpperCase()}</b>

Valid matches: <b>\${have}</b>\${
          next
            ? \` / <b>\${need}</b>
\${remain} more valid \${remain === 1 ? "match" : "matches"} to enter <b>\${next.toUpperCase()}</b>\`
            : \`
👑 You are at the TOP rank.\`
        }\`,
        img = path.join(__dirname, "assets", "ranks", \`\${cur}.png\`);
      try {
        if (fs.existsSync(img)) {
          await bot.sendPhoto(ctx.chatId, img, { caption, parse_mode: "HTML" });
          return;
        }
      } catch (e) {
        console.warn("[rank] image send failed:", e.message);
      }
      await ctx.reply(caption, {
        title: "🏆 RANK",
        color: THEME.gold,
        html: !0,
      });
    },`,
`    rank: async (ctx) => {
      const u = eco.ensure(ctx.userId, metaOf(ctx.msg)),
        cur = rank.normalizeRank(u.rank || "bronze"),
        idx = rank.rankIndex(cur),
        next = rank.RANKS[idx + 1],
        need = next ? rank.THRESHOLDS[idx + 1] : null,
        have = Number(u.rank_valid_matches || 0),
        losses = Number(u.rank_consecutive_losses || 0),
        remain = next ? Math.max(0, need - have) : 0,
        emoji = ["🥉", "🥈", "🥇", "💠", "💎", "🔮", "👑", "🌌"][idx] || "🥉",
        nextReward = next ? rank.rewardFor(next) : null,
        caption = [
          \`\${emoji} <b>\${cur.toUpperCase()}</b>\`,
          "",
          next ? \`Valid matches: <b>\${have}</b> / <b>\${need}</b>\` : \`Valid matches: <b>\${have}</b>\`,
          next
            ? \`\${remain} more valid \${remain === 1 ? "match" : "matches"} to enter <b>\${next.toUpperCase()}</b>\`
            : \`👑 <b>MAX RANK</b>\`,
          \`📉 Consecutive losses: <b>\${losses}/7</b>\`,
          nextReward
            ? \`🎁 Next reward: <b>\${fmt(nextReward.coins)}</b> coins\${nextReward.timed ? " (timed)" : ""}\`
            : \`🌌 Mythic progression complete.\`,
        ].join("\\n"),
        img = path.join(__dirname, "..", "assets", "ranks", \`\${cur}.png\`);
      try {
        if (fs.existsSync(img)) {
          await bot.sendPhoto(ctx.chatId, fs.createReadStream(img), {
            caption,
            parse_mode: "HTML",
            reply_to_message_id: ctx.msg && ctx.msg.message_id,
          });
          return;
        }
      } catch (e) {
        console.warn("[rank] image send failed:", e.message);
      }
      await ctx.reply(caption, {
        title: "🏆 RANK",
        color: THEME.gold,
        html: !0,
      });
    },`
);

replaceOnce(
  'hunt renderer handlers',
`    hunt: async (ctx) => {
      return archiveCardShop.showMenu(bot, ctx.chatId);
    },
    shunt: async (ctx) => {
      return archiveCardShop.showMenu(bot, ctx.chatId);
    },
    card: async (ctx) => {
      return archiveCardShop.showMenu(bot, ctx.chatId);
    },`,
`    hunt: async (ctx) => {
      if (!ctx.isOwner)
        return ctx.reply("Only the owner can force a Hunt spawn.", {
          title: "🔒 OWNER ONLY",
          color: THEME.red,
        });
      const r = await hunt.spawn({ chatId: ctx.chatId });
      if (!r.ok)
        await ctx.reply(r.message, { title: "🃏 HUNT", color: THEME.gold });
    },
    shunt: async (ctx) => {
      if (!ctx.isOwner)
        return ctx.reply("Only the owner can force a Special Hunt spawn.", {
          title: "🔒 OWNER ONLY",
          color: THEME.red,
        });
      const r = await hunt.spawnSpecial({ chatId: ctx.chatId });
      if (!r.ok)
        await ctx.reply(r.message, { title: "✦ SPECIAL HUNT", color: THEME.gold });
    },
    card: async (ctx) => {
      if (!ctx.isOwner)
        return ctx.reply("Only the owner can force a Signature spawn.", {
          title: "🔒 OWNER ONLY",
          color: THEME.red,
        });
      const r = await hunt.spawnSignature({ chatId: ctx.chatId });
      if (!r.ok)
        await ctx.reply(r.message, { title: "♦️ JTF SIGNATURE", color: THEME.gold });
    },`
);

if (next === src) throw new Error('No changes were produced');
fs.writeFileSync(botPath, next);
console.log('✅ src/bot.js patched successfully');
console.log('✅ /p profile renderer wired');
console.log('✅ /rank rank emblem path/details fixed');
console.log('✅ /hunt /shunt /card renderers restored');
console.log('✅ /cshop remains the archive shop');
