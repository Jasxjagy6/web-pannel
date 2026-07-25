'use strict';

const assert = require('assert');
const {
  classifySpamBotReply,
  parseSpamLimitUntil,
} = require('../../src/services/spamBotAppealService');

const timedLimitReply = `Dear Jashan,
I'm afraid some Telegram users found your messages annoying and forwarded them to our team of moderators for inspection. The moderators have confirmed the report and your account is now limited until 5 Jun 2026, 15:22 UTC.

While the account is limited, you will not be able to do certain things on Telegram, like writing to strangers who haven't contacted you first or adding them to groups and channels.

Your account will be automatically released on 5 Jun 2026, 15:22 UTC.`;

const indefiniteLimitReply = `Hello Jashan!
I'm very sorry that you had to contact me. Unfortunately, some actions can trigger a harsh response from our anti-spam systems. If you think your account was limited by mistake, you can submit a complaint to our moderators.

While the account is limited, you will not be able to send messages to people who do not have your number in their phone contacts or add them to groups and channels. Of course, when people contact you first, you can always reply to them.`;

const frozenReply = 'Your account was blocked for violations of the Telegram Terms of Service based on user reports confirmed by our moderators.';

assert.strictEqual(
  classifySpamBotReply('Good news, no limits are currently applied to your account.'),
  'clean'
);

assert.strictEqual(
  classifySpamBotReply(frozenReply),
  'frozen'
);

assert.strictEqual(
  classifySpamBotReply(timedLimitReply),
  'limited'
);

assert.strictEqual(
  classifySpamBotReply(indefiniteLimitReply),
  'limited'
);

assert.strictEqual(
  classifySpamBotReply('Your account is frozen for violations of the Telegram Terms of Service.'),
  'frozen'
);

assert.strictEqual(
  classifySpamBotReply('Please open Telegram Settings for more information.'),
  'unknown'
);

assert.strictEqual(
  parseSpamLimitUntil(timedLimitReply)?.toISOString(),
  '2026-06-05T15:22:00.000Z'
);
assert.strictEqual(parseSpamLimitUntil(indefiniteLimitReply), null);
assert.strictEqual(parseSpamLimitUntil(frozenReply), null);

console.log('spamBotClassification.smoke.test: OK');
