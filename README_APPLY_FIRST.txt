JTF FINAL INTEGRATION — CODE ONLY
Built for tomangamez-star/Tempest_rimuru_bot current main, September 11 2026.

THIS REPLACES THE PREVIOUS UNCOMMITTED PATCH.
Do not commit the earlier JTF_Profile_Ranks_Skins_Integration_Patch ZIP.

FILES TO UPLOAD/REPLACE:
1. NEW:     src/profile-card.js
2. REPLACE: src/profile.js
3. REPLACE: src/archive-card-shop.js
4. EDIT:    src/bot.js using patches/BOT_JS_CHANGES.txt

NO ART IS INCLUDED.
This ZIP contains zero rank PNGs, zero skin PNGs and zero avatars.
It references the files already committed in:
  assets/ranks/
  assets/skins/
  assets/skins/roster.json

WHAT IS FIXED:
- /p and /profile render the full graphical profile card.
- Telegram avatar is shown when available.
- Equipped JTF character skin appears on the card.
- /skins lists the starter roster.
- /skin <id> equips a character and persists via settings.
- Current rank emblem appears on the profile card.
- Static valid-match progress bar shows distance to the next rank.
- Profile title supports a true global exclusive Biggest Gambler title.
- Biggest Gambler badge now belongs ONLY to the user who owns the single
  largest recorded bet in game_history. It is not awarded merely for betting 1M.
- /rank uses repository-root assets/ranks/<rank>.png (fixes old src/assets bug).
- /rank keeps the image AND the text information.
- /rank caption includes valid matches, next rank, remaining matches,
  consecutive losses / 7 and the next-rank reward.
- Mythic shows MAX RANK.
- Archive shop keeps dynamic pricing and /cprice overrides.
- When an archive offer is bought, the ORIGINAL spawned offer is edited to:
    SOLD TO @username
  and its BUY button is removed.
- /hunt is restored to Gen2 spawn.
- /shunt is restored to Old Gen/Special Hunt spawn.
- /card is restored to JTF Signature spawn.
- /cshop remains the paid archive shop.

SECRETS BEFORE RENDER:
Render:
  TELEGRAM_TOKEN
  DATABASE_URL
  DASHBOARD_PASSWORD
  GROQ_API_KEY                      only if AI features need it
  GITHUB_ACTIONS_TOKEN              only if /scrapestart is used
  SUPABASE_SERVICE_ROLE_KEY         required for Supabase custom-card storage
  REMOVEBG_API_KEY                  optional

GitHub Actions shoob-archive.yml:
  DATABASE_URL
  TELEGRAM_TOKEN
  SHOOB_ARCHIVE_CHAT_ID

Optional:
  CARD_SHOP_T1_PRICE ... CARD_SHOP_T6_PRICE

IMPORTANT:
DATABASE_URL is what makes /cprice overrides and /skin selections survive
Render redeploys. Without external Postgres, settings fall back to ephemeral
SQLite and can reset on redeploy.

TESTS INCLUDED:
  node tests/archive-card-shop-integration-test.js
  node tests/profile-exclusive-badges-test.js

Recommended smoke test after upload:
  /skins
  /skin nyra
  /p
  /rank
  /hunt
  /shunt
  /card
  /cshop
  buy one archive offer
  verify the original offer changes to SOLD TO <buyer>
  /badges on biggest bettor
  redeploy
  /p and /cprice list again


PHONE-FRIENDLY AUTOMATIC BOT.JS APPLY:
The ZIP now also contains:
  scripts/apply-jtf-final.js
  .github/workflows/apply-jtf-final.yml

Option A — easiest from phone:
1. Upload/replace ALL CODE FILES from this ZIP in GitHub.
2. Commit them.
3. Open GitHub → Actions → "Apply JTF Final Integration".
4. Run workflow.
5. The workflow patches src/bot.js, checks syntax, runs the two integration
   tests, commits bot.js and pushes it back automatically.

The workflow is workflow_dispatch ONLY. It does not run on every push.

Option B:
If you have a terminal/Termux checkout of the repo:
  node scripts/apply-jtf-final.js
Then commit src/bot.js normally.

The script aborts without writing bot.js if the expected current-main anchors
do not match, so it will not blindly rewrite a newer/different bot.js.
