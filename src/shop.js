'use strict';
/**
 * Rimuru Tempest Casino — Shop & Inventory 🛒
 * /shop — list all items (id, name, price, description).
 * /buy <id> <qty> — buy item(s) from the wallet, add to inventory.
 * /inv /inventory — show what you own.
 *
 * Items: crowbar/gun/mask (required for /crime robbery), hook (required
 * for /fish), security/cyber (passive boosts), lockpick/lucky/drill
 * (crime success bonuses).
 */
const config = require('./config');
const db = require('./db');
const { fmt } = require('./utils');

/** Item catalog — id, name, emoji, price, description. */
const ITEMS = (config.shop && config.shop.items) || [];

/** Look up an item by id (string or number index 1..n). */
function getItem(id) {
  if (id === undefined || id === null) return null;
  const raw = String(id).toLowerCase().trim();
  // numeric index (1-based, as shown in /shop)
  if (/^\d+$/.test(raw)) {
    const idx = parseInt(raw, 10) - 1;
    return ITEMS[idx] || null;
  }
  return ITEMS.find((i) => i.id === raw) || null;
}

/** /shop — render the catalog with 1-based ids. */
function shopList() {
  if (!ITEMS.length) return '🛒 The shop is empty. Come back later.';
  const lines = ITEMS.map((it, i) =>
    `${i + 1}. ${it.emoji} <b>${it.name}</b> — <code>${fmt(it.price)}</code>\n` +
    `   <i>${it.desc}</i>`
  );
  return (
    `🛒 <b>RIMURU'S SHOP</b>\n\n` +
    lines.join('\n\n') +
    `\n\n💡 Use <code>/buy &lt;id&gt; [qty]</code> — e.g. <code>/buy 4</code> or <code>/buy hook 2</code>.`
  );
}

/**
 * /buy <id> [qty] — charge wallet, add items to inventory.
 * Returns { ok, message, item?, qty?, cost? }.
 */
function buyItem(userId, id, qtyRaw, meta = {}) {
  const item = getItem(id);
  if (!item) {
    return { ok: false, message: '❓ No item with that id. Check <code>/shop</code> for the list.' };
  }
  const qty = Math.max(1, Math.floor(Number(qtyRaw) || 1));
  if (qty > 100) {
    return { ok: false, message: '💥 100 is the max per purchase. The house has limits.' };
  }
  const cost = item.price * qty;
  db.getOrCreateUser(userId, meta);
  const u = db.getUser(userId);
  if (u.wallet < cost) {
    return {
      ok: false,
      message: `❌ You need <b>${fmt(cost)}</b> for ${qty}× ${item.name} — your wallet has ${fmt(u.wallet)}. Earn more, mortal.`,
    };
  }
  db.addWallet(userId, -cost);
  db.addItem(userId, item.id, qty);
  const newQty = db.getItemQty(userId, item.id);
  db.logActivity('user', `🛒 ${item.name} x${qty} (${fmt(cost)}) -> ${meta.first_name || userId}`, {
    target: userId, item: item.id, qty, cost,
  });
  return {
    ok: true,
    item,
    qty,
    cost,
    message:
      `✅ <b>PURCHASED</b> ${qty}× ${item.emoji} ${item.name} for <b>${fmt(cost)}</b>.\n` +
      `👛 Wallet: <b>${fmt(u.wallet - cost)}</b> · 📦 You now own: <b>${newQty}</b>`,
  };
}

/** /inv /inventory — list everything the user owns. */
function inventoryText(userId) {
  const rows = db.getInventory(userId);
  if (!rows.length) {
    return '📦 Your inventory is empty. Visit <code>/shop</code> to gear up, mortal.';
  }
  const lines = rows
    .map((r) => {
      const it = getItem(r.item_id);
      const name = it ? `${it.emoji} ${it.name}` : r.item_id;
      return `• ${name} ×<b>${r.quantity}</b>`;
    })
    .join('\n');
  return `📦 <b>YOUR INVENTORY</b>\n\n${lines}`;
}

module.exports = { ITEMS, getItem, shopList, buyItem, inventoryText };
