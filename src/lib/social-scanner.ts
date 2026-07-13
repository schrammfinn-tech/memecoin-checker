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
    const { data } = await axios.get(`${DEXSCREENER}/latest/dex/tokens/${tokenAddress}`, { timeout: 8000 });
    const pairs = data.pairs || [];
    if (pairs.length > 0) {
      const baseToken = pairs[0].baseToken || {};
      const tokenName = baseToken.name || baseToken.symbol || "";

      // Extract social handles directly (DexScreener has these from on-chain metadata)
      if (baseToken.twitter) {
        const handle = extractHandle(baseToken.twitter);
        if (handle) {
          result.twitter = { handle, followers: 0, following: 0, tweetCount: 0, recentEngagement: { avgLikes: 0, avgRetweets: 0, avgComments: 0, engagementRate: 0, sampleSize: 0 }, accountAge: null, verified: false, isSuspicious: false, suspicionReasons: [] };
        }
      }
      if (baseToken.telegram) {
        const handle = extractHandle(baseToken.telegram);
        if (handle) {
          result.telegram = { handle, members: 0, online: 0, isSuspicious: false, suspicionReasons: [] };
        }
      }
      if (baseToken.links) {
        for (const link of baseToken.links) {
          if (link.type === "twitter" && link.url && !result.twitter) {
            const handle = extractHandle(link.url);
            if (handle) result.twitter = { handle, followers: 0, following: 0, tweetCount: 0, recentEngagement: { avgLikes: 0, avgRetweets: 0, avgComments: 0, engagementRate: 0, sampleSize: 0 }, accountAge: null, verified: false, isSuspicious: false, suspicionReasons: [] };
          }
          if (link.type === "telegram" && link.url && !result.telegram) {
            const handle = extractHandle(link.url);
            if (handle) result.telegram = { handle, members: 0, online: 0, isSuspicious: false, suspicionReasons: [] };
          }
          if (link.type === "website" && link.url && !result.website) {
            result.website = link.url;
          }
        }
      }
      if (baseToken.website && !result.website) result.website = baseToken.website;

      // Quick Twitter analysis for the found handles
      const analysisPromises: Promise<void>[] = [];
      if (result.twitter) {
        analysisPromises.push(
          analyzeTwitter(result.twitter.handle).then((t) => { if (t) result.twitter = t; })
        );
      }
      if (result.telegram) {
        analysisPromises.push(
          analyzeTelegram(result.telegram.handle).then((t) => { if (t) result.telegram = t; })
        );
      }
      await Promise.allSettled(analysisPromises);

      // Search for maker Twitter by token name (quick attempt)
      if (!result.twitter && tokenName && deployerAddress) {
        try {
          const makerHandle = await findMakerTwitter(tokenName, deployerAddress);
          if (makerHandle) {
            result.makerTwitter = { handle: makerHandle, followers: 0, following: 0, tweetCount: 0, recentEngagement: { avgLikes: 0, avgRetweets: 0, avgComments: 0, engagementRate: 0, sampleSize: 0 }, accountAge: null, verified: false, isSuspicious: false, suspicionReasons: [] };
            const makerAnalysis = await analyzeTwitter(makerHandle);
            if (makerAnalysis) result.makerTwitter = makerAnalysis;
          }
        } catch { /* skip */ }
      }
    }
  } catch {
    // DexScreener not available — token may not have pairs
  }

  // 2. Score calculation
  let score = 0;

  if (!result.twitter && !result.telegram && !result.website && !result.makerTwitter) {
    result.redFlags.push({ type: "NO_SOCIALS", severity: "HIGH", description: "No social media presence found — common for rug pulls and fake tokens" });
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

function extractHandle(urlOrHandle: string): string | null {
  if (!urlOrHandle) return null;
  let handle = urlOrHandle;
  if (handle.includes("twitter.com") || handle.includes("x.com")) {
    const match = handle.match(/(?:twitter\.com|x\.com)\/([^/?\s]+)/);
    if (match) handle = match[1];
  }
  if (handle.includes("t.me/")) handle = handle.split("t.me/").pop() || "";
  handle = handle.replace("@", "").replace("+", "").trim();
  if (handle && handle.length >= 2 && handle.length <= 30 && !handle.includes("/")) return handle;
  return null;
}

async function findMakerTwitter(tokenName: string, deployerAddress: string): Promise<string | null> {
  try {
    const query = encodeURIComponent(`${tokenName} solana`);
    for (const base of ["https://nitter.privacydev.net", "https://nitter.poast.org"]) {
      try {
        const { data } = await axios.get(`${base}/search?f=tweets&q=${query}`, {
          timeout: 3000,
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
        });
        const html = data as string;
        const match = html.match(/@(\w{2,30})/);
        if (match) return match[1];
      } catch { continue; }
    }
  } catch { /* skip */ }
  return null;
}

async function analyzeTwitter(handle: string): Promise<TwitterAnalysis | null> {
  for (const base of NITTER_INSTANCES) {
    try {
      const { data } = await axios.get(`${base}/${handle}`, {
        timeout: 4000,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "text/html" },
      });
      const html = data as string;
      if (!html || html.length < 500) continue;

      const followers = extractNum(html, /(\d[\d,]*)\s*Followers/i);
      const following = extractNum(html, /(\d[\d,]*)\s*Following/i);
      const tweetCount = extractNum(html, /(\d[\d,]*)\s*Tweets/i);
      const verified = html.includes("verified-icon") || html.includes("icon-verified");

      const joinMatch = html.match(/Joined\s+(\w+\s+\d{4})/i);
      const accountAge = joinMatch ? joinMatch[1] : null;

      const suspicionReasons: string[] = [];
      const lowerHtml = html.toLowerCase();
      const rugKeywords = ["no rug", "safe rug", "cant rug", "won't rug", "wont rug", "liquidity locked", "lp locked", "lp burnt", "doxxed", "doxx"];
      let rugCount = 0;
      for (const kw of rugKeywords) { if (lowerHtml.includes(kw)) rugCount++; }
      if (rugCount >= 3) suspicionReasons.push(`Bio/tweets mention rug safety ${rugCount} times — common rug pull pattern`);
      if (lowerHtml.includes("presale") || lowerHtml.includes("pre-sale")) suspicionReasons.push("Mentions presale — common scam tactic");

      if (joinMatch) {
        const daysOld = (Date.now() - new Date(joinMatch[1]).getTime()) / 86400000;
        if (daysOld < 30) suspicionReasons.push(`Account created ${Math.round(daysOld)} days ago — very new`);
      }

      const likeMatches = html.match(/tweet-stat[^>]*>(\d[\d,]*)/gi) || [];
      const likes: number[] = [];
      for (const m of likeMatches) {
        const num = extractNum(m, /(\d[\d,]*)/);
        if (num > 0 && likes.length < 10) likes.push(num);
      }

      const avgLikes = likes.length > 0 ? likes.reduce((a, b) => a + b, 0) / likes.length : 0;
      const engagementRate = followers > 0 ? avgLikes / followers : 0;
      const isSuspicious = (followers > 5000 && engagementRate < 0.005) || (followers > 20000 && engagementRate < 0.002) || suspicionReasons.length > 0;

      return {
        handle, followers, following, tweetCount,
        recentEngagement: { avgLikes, avgRetweets: 0, avgComments: 0, engagementRate, sampleSize: likes.length },
        accountAge, verified, isSuspicious, suspicionReasons,
      };
    } catch { continue; }
  }
  return null;
}

async function analyzeTelegram(handle: string): Promise<TelegramAnalysis | null> {
  try {
    const { data } = await axios.get(`https://t.me/${handle}`, {
      timeout: 4000,
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
