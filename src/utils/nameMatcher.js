/**
 * Algorithmic Token Name Matcher
 * Compares registered user/business profile name against resolved NUBAN account name from NIBSS/Paystack.
 * Discards noise words, titles, and legal suffixes to calculate token intersection score.
 */

export const CORPORATE_KEYWORDS = [
  'ltd',
  'limited',
  'enterprises',
  'ventures',
  'stores',
  'plc',
  'services',
  'logistics',
  'global',
  'nig',
  'nigeria',
  'corp',
  'corporation',
  'holdings',
  'group',
  'integrated',
  'solutions',
  'company',
  'co'
];

export const NOISE_TITLES = [
  'mr',
  'mrs',
  'miss',
  'ms',
  'dr',
  'chief',
  'alhaji',
  'alhadji',
  'pastor',
  'barr',
  'engr',
  'prof',
  'and',
  'the',
  'for',
  'sir',
  'madam'
];

/**
 * Tokenizes and sanitizes a name string.
 * @param {string} str 
 * @returns {string[]}
 */
export function cleanTokens(str) {
  if (!str || typeof str !== 'string') return [];
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NOISE_TITLES.includes(w));
}

/**
 * Compares user profile name and/or business name against resolved bank account legal name.
 * 
 * Rules:
 * 1. Individual account: Passes if at least 2 key tokens match OR token match ratio >= 60%.
 * 2. Corporate account: If bank account is corporate (contains corporate keywords),
 *    it checks overlap against the registered business name. Passes if at least 2 business
 *    tokens match or ratio >= 50%.
 * 
 * @param {string} profileName - Registered user's full name (e.g., "Gabriel Otemu")
 * @param {string} bankAccountName - Resolved legal account name (e.g., "OTEMU GABRIEL" or "APEX STRUCTURAL SUPPLIES LTD")
 * @param {string} [businessName=''] - Registered company name (e.g., "Apex Structural Supplies Ltd")
 * @returns {{
 *   isMatch: boolean,
 *   isCorporateAccount: boolean,
 *   matchScore: number,
 *   matchedTokens: string[],
 *   profileTokens: string[],
 *   bankTokens: string[],
 *   corporateMatchScore?: number
 * }}
 */
export function checkNameMatch(profileName, bankAccountName, businessName = '') {
  if (!bankAccountName) {
    return {
      isMatch: false,
      isCorporateAccount: false,
      matchScore: 0,
      matchedTokens: [],
      profileTokens: [],
      bankTokens: []
    };
  }

  const profileTokens = cleanTokens(profileName);
  const bankTokens = cleanTokens(bankAccountName);
  const businessTokens = cleanTokens(businessName);

  // Check if bank account has corporate indicators
  const isCorporateAccount = bankTokens.some((token) => CORPORATE_KEYWORDS.includes(token));

  // Count token intersection with profile name
  const matchedProfileTokens = profileTokens.filter((token) => bankTokens.includes(token));
  const profileMatchRatio = profileTokens.length > 0 
    ? (matchedProfileTokens.length / profileTokens.length) * 100 
    : 0;

  // Individual rule: at least 2 tokens match OR match ratio >= 60%
  const isIndividualMatch = matchedProfileTokens.length >= 2 || (profileTokens.length === 1 && matchedProfileTokens.length === 1) || profileMatchRatio >= 60;

  // Corporate rule: if corporate, test match against businessName tokens or profile tokens
  let isCorporateMatch = false;
  let corporateMatchRatio = 0;
  let matchedBusinessTokens = [];

  if (isCorporateAccount) {
    matchedBusinessTokens = businessTokens.filter((token) => bankTokens.includes(token));
    corporateMatchRatio = businessTokens.length > 0 
      ? (matchedBusinessTokens.length / businessTokens.length) * 100 
      : 0;
    
    // Corporate match passes if business name shares >= 2 tokens, or ratio >= 50%, or individual director match passes
    isCorporateMatch = matchedBusinessTokens.length >= 2 || corporateMatchRatio >= 50 || isIndividualMatch;
  }

  const isMatch = isCorporateAccount ? isCorporateMatch : isIndividualMatch;
  const effectiveScore = isCorporateAccount 
    ? Math.max(profileMatchRatio, corporateMatchRatio) 
    : profileMatchRatio;
  const allMatchedTokens = Array.from(new Set([...matchedProfileTokens, ...matchedBusinessTokens]));

  return {
    isMatch,
    isCorporateAccount,
    matchScore: parseFloat(effectiveScore.toFixed(2)),
    matchedTokens: allMatchedTokens,
    profileTokens,
    bankTokens,
    businessTokens
  };
}
