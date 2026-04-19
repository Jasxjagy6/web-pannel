/**
 * Comprehensive Bot Detection System for Telegram Sessions Panel
 * 
 * Implements multiple detection techniques to identify bot accounts:
 * - Username pattern analysis
 * - Name pattern analysis  
 * - Account age verification
 * - Profile photo presence
 * - Bio analysis
 * - Activity patterns
 * - Premium status correlation
 * - Composite scoring system
 */

/**
 * Common bot username patterns
 */
const BOT_USERNAME_PATTERNS = [
  /^bot\d+$/i,                    // bot123, Bot456
  /^.+_bot$/i,                    // my_bot, test_bot
  /^(auto|mass|bulk|spam|promo|add)/i, // auto..., mass..., bulk...
  /^[@#]?(?:the)?(?:real)?(?:official)?(?:true)?[a-z]{3,10}20\d{2}$/i, // theuser2024
  /^[a-z]{2,4}[_.-]?[a-z]{2,4}[_.-]?\d{3,6}$/i, // abc_def_123456
  /^(?:id|user|account|profile)\d{4,}$/i, // id12345, user123456
];

/**
 * Suspicious name patterns
 */
const BOT_NAME_PATTERNS = [
  /\[.*\]/,                       // [Something]
  /\{.*\}/,                       // {Something}
  /‹|›|«|»|│|║|─|┃/,             // Special characters commonly used by bots
  /^(?:ᴴᴵ|ᴴᴱᴸᴸᴼ|ᵀᴱˢᵀ|ᴮᴼᵀ)/,      // Superscript text
  /^(?:@|#|t\.me)/,              // Links in names
  /crypto|bitcoin|btc|eth|wallet|earn|money|forex|trading/i,
  /buy|sell|shop|store|market|deal|offer|promo/i,
  /sex|dating|love|single|chat|meet/i,
  /hack|cheat|generator|free|tool|software/i,
  /^(?:[\u{1F300}-\u{1F9FF}]){4,}$/u, // 4+ emoji only names
];

/**
 * Legitimate username indicators
 */
const LEGIT_USERNAME_PATTERNS = [
  /^[a-z](?:[a-z0-9_]{3,30}[a-z0-9])?$/i, // Standard Telegram format
  /^(?:[a-z]+[._-]?)*[a-z]+$/i, // word separators
];

/**
 * Calculate bot score for a user based on multiple factors.
 * 
 * @param {object} user - User object from Telegram API
 * @param {object} options - Bot filter options
 * @returns {object} { score: 0-1, isBot: boolean, flags: string[] }
 */
function calculateBotScore(user, options = {}) {
  let score = 0;
  const flags = [];
  const weights = {
    usernamePattern: options.usernameWeight ?? 0.25,
    namePattern: options.nameWeight ?? 0.20,
    accountAge: options.accountAgeWeight ?? 0.20,
    profilePhoto: options.photoWeight ?? 0.10,
    bio: options.bioWeight ?? 0.10,
    premium: options.premiumWeight ?? 0.05,
    phone: options.phoneWeight ?? 0.10,
  };

  // Skip if user is marked as bot by Telegram
  if (user.isBot) {
    return { score: 1.0, isBot: true, flags: ['telegram_verified_bot'] };
  }

  // 1. Username pattern analysis
  const usernameScore = analyzeUsername(user.username);
  if (usernameScore > 0.5) {
    score += usernameScore * weights.usernamePattern;
    flags.push('suspicious_username');
  }
  if (!user.username) {
    score += 0.3 * weights.usernamePattern;
    flags.push('no_username');
  }

  // 2. Name pattern analysis
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  const nameScore = analyzeName(name);
  if (nameScore > 0.5) {
    score += nameScore * weights.namePattern;
    flags.push('suspicious_name');
  }
  if (!name || name.length < 2) {
    score += 0.2 * weights.namePattern;
    flags.push('empty_or_short_name');
  }

  // 3. Account age (if available)
  if (user.accountCreatedAt) {
    const ageDays = (Date.now() - new Date(user.accountCreatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < 7) {
      score += 0.9 * weights.accountAge;
      flags.push('very_new_account');
    } else if (ageDays < 30) {
      score += 0.7 * weights.accountAge;
      flags.push('new_account');
    } else if (ageDays < 90) {
      score += 0.4 * weights.accountAge;
      flags.push('relatively_new_account');
    }
  }

  // 4. Profile photo presence
  if (user.hasPhoto === false) {
    score += 0.6 * weights.profilePhoto;
    flags.push('no_profile_photo');
  }

  // 5. Bio analysis
  if (user.bio) {
    const bioScore = analyzeBio(user.bio);
    if (bioScore > 0.5) {
      score += bioScore * weights.bio;
      flags.push('suspicious_bio');
    }
  } else {
    score += 0.1 * weights.bio;
    flags.push('no_bio');
  }

  // 6. Premium status (bots less likely to be premium)
  if (!user.isPremium) {
    score += 0.2 * weights.premium;
    flags.push('non_premium');
  }

  // 7. Phone presence (bots often hide phone)
  if (!user.phone) {
    score += 0.4 * weights.phone;
    flags.push('hidden_phone');
  }

  // 8. Restriction reason (banned/suspended)
  if (user.restrictionReason) {
    score += 0.8;
    flags.push('restricted_account');
  }

  // Normalize score to 0-1 range
  score = Math.min(1.0, Math.max(0.0, score));

  // Determine if bot based on threshold
  const threshold = options.threshold ?? 0.6;
  const isBot = score >= threshold;

  return {
    score: Math.round(score * 100) / 100,
    isBot,
    flags,
  };
}

/**
 * Analyze username for bot-like patterns.
 * 
 * @param {string} username 
 * @returns {number} Bot likelihood score (0-1)
 */
function analyzeUsername(username) {
  if (!username) return 0;

  // Check against known bot patterns
  for (const pattern of BOT_USERNAME_PATTERNS) {
    if (pattern.test(username)) {
      return 0.8 + Math.random() * 0.2; // 0.8-1.0
    }
  }

  // Check for legitimate patterns
  for (const pattern of LEGIT_USERNAME_PATTERNS) {
    if (pattern.test(username)) {
      return 0.1;
    }
  }

  // Check for excessive numbers
  const numberRatio = (username.match(/\d/g) || []).length / username.length;
  if (numberRatio > 0.5) {
    return 0.5 + numberRatio * 0.3;
  }

  // Check for excessive special characters
  const specialRatio = (username.match(/[_.-]/g) || []).length / username.length;
  if (specialRatio > 0.3) {
    return 0.4 + specialRatio * 0.3;
  }

  return 0.2; // Low suspicion
}

/**
 * Analyze name for bot-like patterns.
 * 
 * @param {string} name 
 * @returns {number} Bot likelihood score (0-1)
 */
function analyzeName(name) {
  if (!name) return 0;

  for (const pattern of BOT_NAME_PATTERNS) {
    if (pattern.test(name)) {
      return 0.7 + Math.random() * 0.3;
    }
  }

  // Check for excessive length
  if (name.length > 50) {
    return 0.6;
  }

  // Check for name that's just URLs
  if (/https?:\/\//.test(name)) {
    return 0.8;
  }

  // Check for all caps or all lowercase with numbers
  if (/^[A-Z\s]+$/.test(name) && name.length > 10) {
    return 0.5;
  }

  return 0.1;
}

/**
 * Analyze bio for bot-like content.
 * 
 * @param {string} bio 
 * @returns {number} Bot likelihood score (0-1)
 */
function analyzeBio(bio) {
  if (!bio) return 0;

  const botBioPatterns = [
    /crypto|bitcoin|btc|eth|wallet|invest|earn|money/i,
    /t\.me\/|@.*bot|t\.me\/.*join/i,
    /buy|sell|order|contact|dm|message me/i,
    /18\+|adult|dating|single|hot|sexy/i,
    /free|giveaway|winner|congrats|claim/i,
    /hack|cheat|generator|tool|software|service/i,
    /https?:\/\//, // URLs in bio
  ];

  let matches = 0;
  for (const pattern of botBioPatterns) {
    if (pattern.test(bio)) {
      matches++;
    }
  }

  return Math.min(1.0, matches * 0.25);
}

/**
 * Filter users based on bot score and options.
 * 
 * @param {object[]} users - Array of user objects
 * @param {object} options - Filter options
 * @returns {object[]} Filtered users (non-bots)
 */
function filterBots(users, options = {}) {
  const {
    enabled = true,
    threshold = 0.6,
    requireUsername = false,
    requirePhone = false,
    requirePhoto = false,
    minAccountAge = 0, // days
    maxBotScore = 1.0,
  } = options;

  if (!enabled) return users;

  return users.filter(user => {
    // Skip Telegram-verified bots
    if (user.isBot) return false;

    // Calculate bot score
    const { score, flags } = calculateBotScore(user, { threshold, ...options });
    
    // Store score and flags on user object
    user.botScore = score;
    user.botFlags = flags;

    // Check bot score threshold
    if (score > maxBotScore) return false;

    // Additional filters
    if (requireUsername && !user.username) return false;
    if (requirePhone && !user.phone) return false;
    if (requirePhoto && !user.hasPhoto) return false;
    
    if (minAccountAge > 0 && user.accountCreatedAt) {
      const ageDays = (Date.now() - new Date(user.accountCreatedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < minAccountAge) return false;
    }

    return true;
  });
}

/**
 * Get detailed bot analysis for a user.
 * 
 * @param {object} user 
 * @returns {object} Detailed analysis
 */
function getBotAnalysis(user) {
  const { score, isBot, flags } = calculateBotScore(user);
  
  return {
    isBot,
    botScore: score,
    flags,
    breakdown: {
      username: user.username ? analyzeUsername(user.username) : 1.0,
      name: user.firstName ? analyzeName(user.firstName) : 0.5,
      hasPhoto: user.hasPhoto === false ? 0.6 : 0.1,
      hasPhone: user.phone ? 0.1 : 0.4,
      isPremium: user.isPremium ? 0.1 : 0.2,
      accountAge: user.accountCreatedAt ? 
        Math.max(0, 1 - (Date.now() - new Date(user.accountCreatedAt).getTime()) / (1000 * 60 * 60 * 24 * 365)) : 0.5,
    },
  };
}

module.exports = {
  calculateBotScore,
  filterBots,
  getBotAnalysis,
  analyzeUsername,
  analyzeName,
  analyzeBio,
};
