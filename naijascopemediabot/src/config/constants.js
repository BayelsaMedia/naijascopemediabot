export const CATEGORY_KEYWORDS = {
  politics:     ["politi", "president", "governor", "senator", "minister", "APC", "PDP", "Labour Party", "election", "government", "INEC", "assembly", "house of rep"],
  oil:          ["oil", "gas", "petroleum", "NNPC", "crude", "refinery", "pipeline", "barrel", "energy", "NUPRC", "IOC"],
  crime:        ["crime", "arrest", "police", "murder", "robbery", "kidnap", "court", "prison", "convict", "fraud", "cultism", "militant"],
  environment:  ["environ", "flood", "pollution", "climate", "forest", "farm", "deforestation", "erosion", "spill", "HYPREP"],
  sports:       ["football", "sport", "soccer", "Super Eagles", "NBA", "tennis", "athlete", "championship", "AFCON", "NPFL", "Premier League", "Finidi", "transfer"],
  entertainment:["music", "movie", "actor", "singer", "celebrity", "Nollywood", "award", "album", "Afrobeats"],
  election:     ["election", "2027", "candidate", "campaign", "ballot", "vote", "polling", "primary", "governorship"],
  nddc:         ["NDDC", "Niger Delta Development", "commission", "accountability", "interventionist"],
  opportunities:["scholarship", "job", "employment", "opportunity", "fellowship", "grant", "bursary", "vacancy", "internship", "award", "admission", "training"],
};

// Display labels and emojis for each category
export const CATEGORY_META = {
  politics:     { label: "Politics",      emoji: "🏛️" },
  oil:          { label: "Oil & Gas",     emoji: "🛢️" },
  crime:        { label: "Crime & Law",   emoji: "🚨" },
  environment:  { label: "Environment",   emoji: "🌿" },
  sports:       { label: "Sports",        emoji: "⚽" },
  entertainment:{ label: "Entertainment", emoji: "🎬" },
  election:     { label: "Election",      emoji: "🗳️" },
  nddc:         { label: "NDDC",          emoji: "📋" },
  opportunities:{ label: "Opportunities", emoji: "🎓" },
};

export const BAYELSA_LGAS = ["Yenagoa", "Ogbia", "Sagbama", "Ekeremor", "Kolokuma/Opokuma", "Nembe", "Brass", "Southern Ijaw"];

export const RSS_FEED_URL   = "https://www.bayelsamedia.com.ng/feed";
export const SITE_URL       = "www.bayelsamedia.com.ng";
export const SITE_FULL_URL  = "https://www.bayelsamedia.com.ng";

export const CACHE_TTL_MS           = 10 * 60 * 1000; // 10 minutes
export const RATE_LIMIT_MS          = 3_000;
export const MAX_CONVERSATION_USERS = 500;
export const MAX_PROCESSED_IDS      = 1_000;
