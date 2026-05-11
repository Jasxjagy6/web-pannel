/**
 * Curated pools of fake first names, last names, and bios used by the
 * "Randomize" feature in the Account Settings page.
 *
 * These are deliberately generic and English-leaning. Add/remove entries
 * freely — the randomize feature samples uniformly with replacement, so the
 * list can grow without code changes.
 */

const FIRST_NAMES = [
  'Alex', 'Avery', 'Ben', 'Cameron', 'Casey', 'Charlie', 'Chris', 'Dakota',
  'Drew', 'Ellis', 'Emerson', 'Finley', 'Frankie', 'Hayden', 'Hunter', 'Jamie',
  'Jordan', 'Kai', 'Kendall', 'Kerry', 'Lane', 'Logan', 'Mason', 'Morgan',
  'Parker', 'Peyton', 'Quinn', 'Reese', 'Riley', 'River', 'Rowan', 'Sage',
  'Sam', 'Sawyer', 'Skyler', 'Spencer', 'Sydney', 'Taylor', 'Tatum', 'Tyler',
  'Ash', 'Blake', 'Brett', 'Cary', 'Corey', 'Dale', 'Devon', 'Eden',
  'Eli', 'Gale', 'Glenn', 'Harper', 'Indie', 'Jess', 'Jules', 'Kelsey',
  'Lee', 'Marley', 'Max', 'Nico', 'Noel', 'Owen', 'Phoenix', 'Robin',
  'Shannon', 'Shay', 'Sloan', 'Toby', 'Tristan', 'Val', 'Wren', 'Zion',
  'Adrian', 'Bailey', 'Casey', 'Dana', 'Eden', 'Frances', 'Gray', 'Holland',
];

const LAST_NAMES = [
  'Anderson', 'Bailey', 'Bennett', 'Brooks', 'Carter', 'Chen', 'Clark', 'Cole',
  'Cooper', 'Cruz', 'Diaz', 'Edwards', 'Evans', 'Fisher', 'Foster', 'Garcia',
  'Gomez', 'Grant', 'Gray', 'Hall', 'Hayes', 'Hill', 'Hughes', 'Jenkins',
  'Jordan', 'Kelly', 'Khan', 'Kim', 'Knight', 'Lee', 'Lopez', 'Mason',
  'Mendez', 'Miller', 'Mitchell', 'Moore', 'Murphy', 'Myers', 'Nelson', 'Owens',
  'Parker', 'Patel', 'Perez', 'Phillips', 'Powell', 'Price', 'Quinn', 'Ramirez',
  'Reed', 'Reyes', 'Rivera', 'Roberts', 'Robinson', 'Rogers', 'Ross', 'Russell',
  'Sanchez', 'Scott', 'Shah', 'Singh', 'Smith', 'Stone', 'Sullivan', 'Tanaka',
  'Taylor', 'Torres', 'Walker', 'Walsh', 'Ward', 'Watson', 'Webb', 'Wells',
  'White', 'Williams', 'Wilson', 'Wood', 'Wright', 'Yang', 'Young', 'Zhang',
];

// Bios — Telegram caps the "about" field at 70 chars, so keep these short.
const BIOS = [
  'Coffee first. Code second.',
  'Just here for the memes.',
  'Building, breaking, repeating.',
  'Wandering somewhere with good wifi.',
  'Trying my best. Failing creatively.',
  'Plant parent. Bug slayer.',
  'Eternal student of the internet.',
  'Probably listening to lo-fi.',
  'I read the docs. Sometimes.',
  'Cats over deadlines.',
  'Outside on weekends. Online forever.',
  'Big believer in second breakfast.',
  'Less talk, more ship.',
  'Hi. I am a person.',
  'Optimistic but tired.',
  'Currently buffering.',
  'Vibes, mostly.',
  'Hot takes only, sorry.',
  'Reply hazy, try again later.',
  'New here. Be gentle.',
  'Living my main character era.',
  'Powered by tea and panic.',
  'I write things and then delete them.',
  'Asking the hard questions like "tabs or spaces".',
  'Always 5 minutes late.',
  'Quietly judging your code.',
  'Will travel for ramen.',
  'Halfway there. Wherever that is.',
  'Loud at concerts, quiet otherwise.',
  'Just trying to keep my plants alive.',
];

module.exports = {
  FIRST_NAMES,
  LAST_NAMES,
  BIOS,
};
