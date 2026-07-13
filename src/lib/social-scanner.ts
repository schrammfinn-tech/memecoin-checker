import axios from "axios";

export interface SocialResult {
  twitter: TwitterAnalysis | null;
  telegram: TelegramAnalysis | null;
  website: string | null;
  makerTwitter: TwitterAnalysis | null;
  redFlags: SocialRedFlag[];
  socialScore: number;
}

export interface TwitterAnalysis {
  handle: string;
  followers: number;
  following: number;
  tweetCount: number;
  recentEngagement: {
    avgLikes: number;
    avgRetweets: number;
    avgComments: number;
    engagementRate: number;
    sampleSize: number;
  };
  accountAge: string | null;
  verified: boolean;
  isSuspicious: boolean;
  suspicionReasons: string[];
}

export interface TelegramAnalysis {
  handle: string;
  members: number;
  online: number;
  isSuspicious: boolean;
  suspicionReasons: string[];
}

export interface SocialRedFlag {
  type: "FAKE_FOLLOWERS" | "LOW_ENGAGEMENT" | "NO_SOCIALS" | "NEW_ACCOUNT" | "EMPTY_TELEGRAM" | "RUG_WORDS" | "BOT_COMMUNITY" | "MAKER_NO_SOCIAL" | "MAKER_NEW_ACCOUNT";
  severity: "HIGH" | "MEDIUM" | "LOW";
  description: string;
}

const DEXSCREENER = "https://api.dexscreener.com";
const SOLSCAN = "https://public-api.solscan.io";
const NITTER_INSTANCES = [
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
  "https://nitter.net",
];

export async function scanSocials(tokenAddress: string, deployerAddress?: string): Promise<SocialResult> {
  const result: SocialResult = {
    twitter: null, telegram: null, website: null, makerTwitter: null, redFlags: [], socialScore: 0,
  };

  // 1. Get token socials from DexScreener
  try {
    const { data } = await axios.get(`${DEXSCREENER}/latest/dex/tokens/${tokenAddress}`, { timeout: 10000 });
    const pairs = data.pairs || [];
    if (pairs.length > 0) {
      const baseToken = pairs[0].baseToken || {};
      const tokenName = baseToken.name || baseToken.symbol || "";
      const promises: Promise<void>[] = [];

      if (baseToken.twitter) {
        promises.push(analyzeTwitter(baseToken.twitter).then((t) => { result.twitter = t; }));
      }
      if (baseToken.telegram) {
        promises.push(analyzeTelegram(baseToken.telegram).then((t) => { result.telegram = t; }));
      }
      if (baseToken.links) {
        for (const link of baseToken.links) {
          if (link.type === "twitter" && link.url && !result.twitter) {
            promises.push(analyzeTwitter(link.url).then((t) => { result.twitter = t; }));
          }
          if (link.type === "telegram" && link.url && !result.telegram) {
            promises.push(analyzeTelegram(link.url).then((t) => { result.telegram = t; }));
          }
          if (link.type === "website" && link.url && !result.website) {
            result.website = link.url;
          }
        }
      }
      if (baseToken.website && !result.website) result.website = baseToken.website;

      await Promise.allSettled(promises);

      // Search for maker Twitter by token name
      if (!result.twitter && tokenName) {
        try {
          const makerHandle = await searchTwitterForToken(tokenName);
          if (makerHandle) {
            result.makerTwitter = await analyzeTwitter(makerHandle);
            if (result.makerTwitter) {
              result.redFlags.push({
                type: "MAKER_NO_SOCIAL",
                severity: "LOW",
                description: `Found potential maker Twitter via token name search: @${makerHandle}`,
              });
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch {
    result.redFlags.push({ type: "NO_SOCIALS", severity: "MEDIUM", description: "Could not fetch token social data" });
  }

  // 2. Search for deployer wallet on social platforms
  if (deployerAddress && deployerAddress !== "unknown" && !result.makerTwitter) {
    try {
      const solscanHandle = await searchSolscanForTwitter(deployerAddress);
      if (solscanHandle) {
        result.makerTwitter = await analyzeTwitter(solscanHandle);
        if (result.makerTwitter) {
          result.redFlags.push({
            type: "MAKER_NO_SOCIAL",
            severity: "LOW",
            description: `Found maker Twitter via Solscan: @${solscanHandle}`,
          });
        }
      }
    } catch { /* skip */ }

    // If still no maker found, search token address on Twitter
    if (!result.makerTwitter) {
      try {
        const addrHandle = await searchTwitterForAddress(deployerAddress);
        if (addrHandle) {
          result.makerTwitter = await analyzeTwitter(addrHandle);
        }
      } catch { /* skip */ }
    }
  }

  // 3. Score calculation
  let score = 0;

  if (!result.twitter && !result.telegram && !result.website && !result.makerTwitter) {
    result.redFlags.push({ type: "NO_SOCIALS", severity: "HIGH", description: "No social media presence found for token or maker" });
    score += 20;
  }

  if (result.twitter) score += scoreTwitter(result.twitter, result.redFlags, "Token");
  if (result.makerTwitter) {
    const makerScore = scoreMakerTwitter(result.makerTwitter, result.redFlags);
    score += makerScore;
  }
  if (result.telegram) score += scoreTelegram(result.telegram, result.redFlags);

  result.socialScore = Math.min(40, score);
  return result;
}

function scoreTwitter(t: TwitterAnalysis, flags: SocialRedFlag[], prefix: string): number {
  let s = 0;
  if (t.followers > 10000 && t.recentEngagement.engagementRate < 0.001) {
    flags.push({ type: "FAKE_FOLLOWERS", severity: "HIGH", description: `${prefix}: ${t.followers.toLocaleString()} followers but only ~${t.recentEngagement.avgLikes.toFixed(0)} likes per post — likely bought followers` });
    s += 20;
  } else if (t.followers > 5000 && t.recentEngagement.engagementRate < 0.005) {
    flags.push({ type: "LOW_ENGAGEMENT", severity: "MEDIUM", description: `${prefix}: Low engagement — ${t.followers.toLocaleString()} followers, ${(t.recentEngagement.engagementRate * 100).toFixed(2)}% rate` });
    s += 10;
  }
  if (t.following > t.followers * 3) {
    flags.push({ type: "BOT_COMMUNITY", severity: "MEDIUM", description: `${prefix}: Following ${t.following.toLocaleString()} — follow-for-follow bot pattern` });
    s += 5;
  }
  for (const reason of t.suspicionReasons) {
    flags.push({ type: "RUG_WORDS", severity: "HIGH", description: reason });
    s += 10;
  }
  return s;
}

function scoreMakerTwitter(t: TwitterAnalysis, flags: SocialRedFlag[]): number {
  let s = 0;
  if (t.followers < 50 && t.tweetCount === 0) {
    flags.push({ type: "MAKER_NEW_ACCOUNT", severity: "HIGH", description: `Maker account @${t.handle} has 0 tweets — likely a burner account` });
    s += 15;
  }
  if (t.followers < 100) {
    flags.push({ type: "MAKER_NEW_ACCOUNT", severity: "MEDIUM", description: `Maker @${t.handle} has very few followers (${t.followers}) — possible burner/fresh account` });
    s += 8;
  }
  if (t.followers > 5000 && t.recentEngagement.engagementRate < 0.001) {
    flags.push({ type: "FAKE_FOLLOWERS", severity: "HIGH", description: `Maker @${t.handle}: ${t.followers.toLocaleString()} followers but near-zero engagement — bought followers` });
    s += 15;
  }
  for (const reason of t.suspicionReasons) {
    flags.push({ type: "RUG_WORDS", severity: "HIGH", description: `Maker: ${reason}` });
    s += 10;
  }
  return s;
}

function scoreTelegram(tg: TelegramAnalysis, flags: SocialRedFlag[]): number {
  let s = 0;
  if (tg.members > 5000 && tg.online < 50) {
    flags.push({ type: "EMPTY_TELEGRAM", severity: "HIGH", description: `${tg.members.toLocaleString()} members but only ${tg.online} online — likely bot-filled` });
    s += 15;
  } else if (tg.members > 2000 && tg.online < tg.members * 0.02) {
    flags.push({ type: "EMPTY_TELEGRAM", severity: "MEDIUM", description: "Low Telegram activity relative to member count" });
    s += 8;
  }
  return s;
}

async function fetchNitter(path: string, timeout = 8000): Promise<string | null> {
  for (const base of NITTER_INSTANCES) {
    try {
      const { data } = await axios.get(`${base}${path}`, {
        timeout,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "text/html" },
      });
      if (data && typeof data === "string" && data.length > 500) return data;
    } catch { continue; }
  }
  return null;
}

// Search for Twitter handles matching the token name
async function searchTwitterForToken(tokenName: string): Promise<string | null> {
  try {
    const query = encodeURIComponent(`${tokenName} solana token`);
    const html = await fetchNitter(`/search?f=tweets&q=${query}`);
    if (!html) return null;
    const handleMatch = html.match(/@(\w{2,30})/);
    return handleMatch ? handleMatch[1] : null;
  } catch {
    return null;
  }
}

// Check Solscan for any social links associated with a wallet
async function searchSolscanForTwitter(walletAddress: string): Promise<string | null> {
  try {
    const { data } = await axios.get(`${SOLSCAN}/account/${walletAddress}`, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    });
    return data?.twitter || data?.metadata?.twitter || null;
  } catch {
    return null;
  }
}

// Search Twitter for wallet address mentions
async function searchTwitterForAddress(address: string): Promise<string | null> {
  try {
    const short = address.slice(0, 8);
    const html = await fetchNitter(`/search?f=tweets&q=${short}+solana`);
    if (!html) return null;
    const handleMatch = html.match(/@(\w{2,30})/);
    return handleMatch ? handleMatch[1] : null;
  } catch {
    return null;
  }
}

async function analyzeTwitter(handleOrUrl: string): Promise<TwitterAnalysis | null> {
  try {
    let handle = handleOrUrl;
    if (handle.includes("twitter.com") || handle.includes("x.com")) {
      const match = handle.match(/(?:twitter\.com|x\.com)\/([^/?\s]+)/);
      if (match) handle = match[1];
      else return null;
    }
    handle = handle.replace("@", "").trim();
    if (!handle || handle.length < 2 || handle.length > 30) return null;

    let followers = 0;
    let following = 0;
    let tweetCount = 0;
    let verified = false;
    let joinDate: string | null = null;
    let likes: number[] = [];

    const html = await fetchNitter(`/${handle}`, 10000);

    if (!html) {
      return {
        handle, followers: 0, following: 0, tweetCount: 0,
        recentEngagement: { avgLikes: 0, avgRetweets: 0, avgComments: 0, engagementRate: 0, sampleSize: 0 },
        accountAge: null, verified: false, isSuspicious: false, suspicionReasons: [],
      };
    }

    followers = extractNum(html, /(\d[\d,]*)\s*Followers/i);
    following = extractNum(html, /(\d[\d,]*)\s*Following/i);
    tweetCount = extractNum(html, /(\d[\d,]*)\s*Tweets/i);
    verified = html.includes("verified-icon") || html.includes("icon-verified");

    const joinMatch = html.match(/Joined\s+(\w+\s+\d{4})/i);
    if (joinMatch) joinDate = joinMatch[1];

    const likeMatches = html.match(/tweet-stat[^>]*>(\d[\d,]*)/gi) || [];
    for (const m of likeMatches) {
      const num = extractNum(m, /(\d[\d,]*)/);
      if (num > 0 && likes.length < 10) likes.push(num);
    }

    const avgLikes = likes.length > 0 ? likes.reduce((a, b) => a + b, 0) / likes.length : 0;
    const engagementRate = followers > 0 ? avgLikes / followers : 0;

    const suspicionReasons: string[] = [];
    const lowerHtml = html.toLowerCase();
    const rugKeywords = ["no rug", "safe rug", "cant rug", "won't rug", "wont rug", "liquidity locked", "lp locked", "lp burnt", "doxxed", "doxx"];
    let rugCount = 0;
    for (const kw of rugKeywords) { if (lowerHtml.includes(kw)) rugCount++; }
    if (rugCount >= 3) suspicionReasons.push(`Bio/tweets mention rug safety ${rugCount} times — common rug pull pattern`);
    if (lowerHtml.includes("presale") || lowerHtml.includes("pre-sale")) suspicionReasons.push("Mentions presale — common scam tactic");

    if (joinDate) {
      const daysOld = (Date.now() - new Date(joinDate).getTime()) / 86400000;
      if (daysOld < 30) suspicionReasons.push(`Account created ${Math.round(daysOld)} days ago — very new`);
    }

    const isSuspicious = (followers > 5000 && engagementRate < 0.005) || (followers > 20000 && engagementRate < 0.002) || suspicionReasons.length > 0;

    return {
      handle, followers, following, tweetCount,
      recentEngagement: { avgLikes, avgRetweets: 0, avgComments: 0, engagementRate, sampleSize: likes.length },
      accountAge: joinDate, verified, isSuspicious, suspicionReasons,
    };
  } catch { return null; }
}

async function analyzeTelegram(handleOrUrl: string): Promise<TelegramAnalysis | null> {
  try {
    let handle = handleOrUrl;
    if (handle.includes("t.me/")) handle = handle.split("t.me/").pop() || "";
    else if (handle.includes("telegram.me/")) handle = handle.split("telegram.me/").pop() || "";
    handle = handle.replace("@", "").replace("+", "").trim();
    if (!handle || handle.length < 2) return null;

    const { data } = await axios.get(`https://t.me/${handle}`, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "text/html" },
    });

    const html = data as string;
    const members = extractNum(html, /(\d[\d\s]*)\s*(?:members|subscribers|member)/i);
    const online = extractNum(html, /(\d[\d\s]*)\s*(?:online)/i);
    const isSuspicious = (members > 5000 && online < members * 0.02) || (members > 20000 && online < 100);
    const suspicionReasons: string[] = [];
    if (members > 10000 && online < 100) suspicionReasons.push(`${members.toLocaleString()} members but only ${online} online`);

    return { handle, members, online, isSuspicious, suspicionReasons };
  } catch { return null; }
}

function extractNum(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  if (!match || !match[1]) return 0;
  return parseInt(match[1].replace(/[,\s]/g, ""), 10) || 0;
}
