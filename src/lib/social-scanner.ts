import axios from "axios";

export interface SocialResult {
  twitter: TwitterAnalysis | null;
  telegram: TelegramAnalysis | null;
  website: string | null;
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
  type: "FAKE_FOLLOWERS" | "LOW_ENGAGEMENT" | "NO_SOCIALS" | "NEW_ACCOUNT" | "EMPTY_TELEGRAM" | "RUG_WORDS" | "BOT_COMMUNITY";
  severity: "HIGH" | "MEDIUM" | "LOW";
  description: string;
}

const DEXSCREENER = "https://api.dexscreener.com";

export async function scanSocials(tokenAddress: string): Promise<SocialResult> {
  const result: SocialResult = {
    twitter: null, telegram: null, website: null, redFlags: [], socialScore: 0,
  };

  try {
    const { data } = await axios.get(`${DEXSCREENER}/latest/dex/tokens/${tokenAddress}`, { timeout: 10000 });
    const pairs = data.pairs || [];
    if (pairs.length === 0) {
      result.redFlags.push({ type: "NO_SOCIALS", severity: "HIGH", description: "No DEX pairs found - token may not be traded" });
      result.socialScore = 100;
      return result;
    }

    const baseToken = pairs[0].baseToken || {};
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
  } catch {
    result.redFlags.push({ type: "NO_SOCIALS", severity: "MEDIUM", description: "Could not fetch social data" });
    result.socialScore = 50;
    return result;
  }

  let score = 0;

  if (!result.twitter && !result.telegram && !result.website) {
    result.redFlags.push({ type: "NO_SOCIALS", severity: "HIGH", description: "No social media presence found" });
    score += 20;
  }

  if (result.twitter) {
    const t = result.twitter;
    if (t.followers > 10000 && t.recentEngagement.engagementRate < 0.001) {
      result.redFlags.push({
        type: "FAKE_FOLLOWERS",
        severity: "HIGH",
        description: `${t.followers.toLocaleString()} followers but only ~${t.recentEngagement.avgLikes.toFixed(0)} likes per post — likely bought followers or bots`,
      });
      score += 20;
    } else if (t.followers > 5000 && t.recentEngagement.engagementRate < 0.005) {
      result.redFlags.push({
        type: "LOW_ENGAGEMENT",
        severity: "MEDIUM",
        description: `Low engagement: ${t.followers.toLocaleString()} followers, ${(t.recentEngagement.engagementRate * 100).toFixed(2)}% rate`,
      });
      score += 10;
    }

    if (t.following > t.followers * 3) {
      result.redFlags.push({
        type: "BOT_COMMUNITY",
        severity: "MEDIUM",
        description: `Following ${t.following.toLocaleString()} accounts — follow-for-follow bot pattern`,
      });
      score += 5;
    }

    for (const reason of t.suspicionReasons) {
      result.redFlags.push({ type: "RUG_WORDS", severity: "HIGH", description: reason });
      score += 10;
    }
  }

  if (result.telegram) {
    const tg = result.telegram;
    if (tg.members > 5000 && tg.online < 50) {
      result.redFlags.push({
        type: "EMPTY_TELEGRAM",
        severity: "HIGH",
        description: `${tg.members.toLocaleString()} members but only ${tg.online} online — likely bot-filled`,
      });
      score += 15;
    } else if (tg.members > 2000 && tg.online < tg.members * 0.02) {
      result.redFlags.push({
        type: "EMPTY_TELEGRAM",
        severity: "MEDIUM",
        description: "Low Telegram activity relative to member count",
      });
      score += 8;
    }
  }

  result.socialScore = Math.min(40, score);
  return result;
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
    if (!handle || handle.length < 2) return null;

    const { data } = await axios.get(`https://nitter.net/${handle}`, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "text/html" },
    });

    const html = data as string;

    const followers = extractNum(html, /(\d[\d,]*)\s*Followers/i);
    const following = extractNum(html, /(\d[\d,]*)\s*Following/i);
    const tweetCount = extractNum(html, /(\d[\d,]*)\s*Tweets/i);
    const verified = html.includes("verified-icon") || html.includes('icon-verified');

    const suspicionReasons: string[] = [];

    // Check bio/tweets for rug-related keywords
    const lowerHtml = html.toLowerCase();
    const rugKeywords = ["no rug", "safe rug", "cant rug", "won't rug", "wont rug", "liquidity locked", "lp locked", "lp burnt"];
    let rugKeywordCount = 0;
    for (const kw of rugKeywords) {
      if (lowerHtml.includes(kw)) rugKeywordCount++;
    }
    if (rugKeywordCount >= 3) {
      suspicionReasons.push(`Bio/tweets mention "no rug" ${rugKeywordCount} times — common in rug pull projects`);
    }

    // Check account age via join date
    const joinMatch = html.match(/Joined\s+(\w+\s+\d{4})/i);
    if (joinMatch) {
      const joinDate = new Date(joinMatch[1]);
      const daysOld = (Date.now() - joinDate.getTime()) / 86400000;
      if (daysOld < 30) {
        suspicionReasons.push(`Account created ${Math.round(daysOld)} days ago — very new account`);
      }
    }

    // Extract likes
    const likeMatches = html.match(/tweet-stat[^>]*>(\d[\d,]*)/gi) || [];
    const likes: number[] = [];
    for (const m of likeMatches) {
      const num = extractNum(m, /(\d[\d,]*)/);
      if (num > 0 && likes.length < 10) likes.push(num);
    }

    const avgLikes = likes.length > 0 ? likes.reduce((a, b) => a + b, 0) / likes.length : 0;
    const engagementRate = followers > 0 ? avgLikes / followers : 0;
    const isSuspicious = (followers > 5000 && engagementRate < 0.005) || (followers > 20000 && engagementRate < 0.002) || suspicionReasons.length > 0;

    return { handle, followers, following, tweetCount, recentEngagement: { avgLikes, avgRetweets: 0, avgComments: 0, engagementRate, sampleSize: likes.length }, accountAge: joinMatch ? joinMatch[1] : null, verified, isSuspicious, suspicionReasons };
  } catch {
    return null;
  }
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
    if (members > 10000 && online < 100) suspicionReasons.push(`${members.toLocaleString()} members but only ${online} online — possible bot padding`);

    return { handle, members, online, isSuspicious, suspicionReasons };
  } catch {
    return null;
  }
}

function extractNum(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  if (!match || !match[1]) return 0;
  return parseInt(match[1].replace(/[,\s]/g, ""), 10) || 0;
}
