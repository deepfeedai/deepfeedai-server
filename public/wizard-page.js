/* ============================================================
   DeepFeedAI Admin — Deployment Wizard
   ============================================================ */

function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Niche Templates ─────────────────────────────────────────
const NICHE_TEMPLATES = [
  {
    "id": "ai-tech",
    "name": "AI & Technology",
    "icon": "🤖",
    "description": "Artificial intelligence, machine learning, and tech industry news",
    "theme": "Dark Cyan",
    "tagline": "Your daily signal in the AI noise",
    "persona": "You are a concise AI news analyst. Highlight key technical breakthroughs, business implications, and industry trends. Use clear language accessible to both technical and non-technical readers.",
    "categories": [
      {
        "name": "LLMs",
        "color": "#4F8EF7",
        "writer": "Victor",
        "bio": "Senior AI correspondent covering large language models, foundation model releases, and the companies shaping conversational AI.",
        "keywords": [
          "gpt",
          "claude",
          "gemini",
          "llama",
          "mistral",
          "llm",
          "language model",
          "openai",
          "anthropic",
          "foundation model",
          "transformer",
          "context window",
          "prompt"
        ],
        "systemPrompt": "You are Victor, an AI correspondent specializing in large language models. Write with technical depth but remain accessible. Focus on what's new, why it matters, and how it compares to existing models. Avoid hype — let the benchmarks and capabilities speak."
      },
      {
        "name": "Image AI & Video",
        "color": "#a78bfa",
        "writer": "Wanda",
        "bio": "Visual AI reporter tracking breakthroughs in image generation, video synthesis, and creative AI tools.",
        "keywords": [
          "midjourney",
          "dall-e",
          "stable diffusion",
          "imagen",
          "sora",
          "runway",
          "flux",
          "diffusion",
          "text to image",
          "text to video",
          "generative art",
          "ai art"
        ],
        "systemPrompt": "You are Wanda, a visual AI reporter. Cover image and video generation with an eye for creative implications. Explain diffusion models, architecture changes, and quality improvements in plain language. Highlight what creators and artists need to know."
      },
      {
        "name": "Research",
        "color": "#34d399",
        "writer": "Reed",
        "bio": "Research analyst distilling the latest AI papers, benchmarks, and academic breakthroughs into actionable insights.",
        "keywords": [
          "arxiv",
          "neurips",
          "icml",
          "paper",
          "benchmark",
          "preprint",
          "researchers",
          "alignment",
          "scaling law",
          "training",
          "fine-tuning",
          "rlhf",
          "dataset"
        ],
        "systemPrompt": "You are Reed, a research analyst. Translate dense academic papers into clear, structured summaries. Lead with the key finding, explain the method briefly, and note limitations. Always cite the source institution and paper title."
      },
      {
        "name": "Tools",
        "color": "#fbbf24",
        "writer": "Tony",
        "bio": "Developer tools correspondent covering AI coding assistants, frameworks, APIs, and the builder ecosystem.",
        "keywords": [
          "copilot",
          "cursor",
          "langchain",
          "api",
          "sdk",
          "framework",
          "developer",
          "coding",
          "agent",
          "mcp",
          "function calling",
          "tool use",
          "automation"
        ],
        "systemPrompt": "You are Tony, a developer tools correspondent. Write for builders — focus on practical utility, integration effort, and developer experience. Include specifics: API changes, pricing, supported languages. Skip marketing fluff."
      },
      {
        "name": "Business",
        "color": "#f472b6",
        "writer": "Oliver",
        "bio": "Business and markets reporter covering AI funding rounds, acquisitions, partnerships, and corporate strategy.",
        "keywords": [
          "funding",
          "series a",
          "series b",
          "acquisition",
          "valuation",
          "revenue",
          "startup",
          "investment",
          "partnership",
          "ipo",
          "layoff",
          "market cap"
        ],
        "systemPrompt": "You are Oliver, a business reporter covering the AI industry. Lead with the numbers — funding amount, valuation, deal terms. Provide context on what the company does and why the deal matters for the broader market. Keep it factual and concise."
      },
      {
        "name": "Policy",
        "color": "#60a5fa",
        "writer": "Diana",
        "bio": "Policy and regulation correspondent tracking AI legislation, ethics debates, and governance frameworks worldwide.",
        "keywords": [
          "regulation",
          "legislation",
          "eu ai act",
          "executive order",
          "congress",
          "gdpr",
          "copyright",
          "ethics",
          "bias",
          "governance",
          "compliance",
          "lawsuit"
        ],
        "systemPrompt": "You are Diana, a policy correspondent. Cover AI regulation with nuance — explain what the law requires, who it affects, and the timeline. Present multiple perspectives without editorializing. Note enforcement mechanisms and penalties."
      },
      {
        "name": "CyberSecurity",
        "color": "#ef4444",
        "writer": "Barbara",
        "bio": "Cybersecurity analyst covering AI-powered threats, vulnerabilities, defensive tools, and security research.",
        "keywords": [
          "ransomware",
          "malware",
          "vulnerability",
          "zero-day",
          "exploit",
          "breach",
          "phishing",
          "hacker",
          "threat",
          "cve",
          "infosec",
          "prompt injection"
        ],
        "systemPrompt": "You are Barbara, a cybersecurity analyst. Write with urgency when warranted but avoid sensationalism. Explain attack vectors clearly, note affected systems, and include mitigation steps. Technical accuracy is paramount."
      },
      {
        "name": "Industry",
        "color": "#94a3b8",
        "writer": "Clark",
        "bio": "Industry reporter covering AI adoption across sectors — healthcare, finance, manufacturing, automotive, and beyond.",
        "keywords": [
          "ai adoption",
          "enterprise",
          "healthcare",
          "finance",
          "manufacturing",
          "robotics",
          "autonomous",
          "digital transformation",
          "deployment",
          "use case"
        ],
        "systemPrompt": "You are Clark, an industry reporter. Cover how AI is being deployed in the real world. Focus on measurable outcomes — cost savings, efficiency gains, deployment scale. Ground every story in specific use cases, not abstract possibilities."
      }
    ],
    "sources": [
      {
        "name": "The Verge AI",
        "url": "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"
      },
      {
        "name": "TechCrunch AI",
        "url": "https://techcrunch.com/category/artificial-intelligence/feed/"
      },
      {
        "name": "VentureBeat AI",
        "url": "https://venturebeat.com/category/ai/feed/"
      },
      {
        "name": "Ars Technica",
        "url": "https://feeds.arstechnica.com/arstechnica/technology-lab"
      },
      {
        "name": "MIT Technology Review",
        "url": "https://www.technologyreview.com/feed/"
      },
      {
        "name": "AI News",
        "url": "https://www.artificialintelligence-news.com/feed/"
      },
      {
        "name": "Google AI Blog",
        "url": "https://blog.google/technology/ai/rss/"
      },
      {
        "name": "Anthropic News",
        "url": "https://www.anthropic.com/news/rss.xml"
      }
    ]
  },
  {
    "id": "climate",
    "name": "Climate & Energy",
    "icon": "🌍",
    "description": "Climate tech, clean energy, sustainability, and environmental policy",
    "theme": "Midnight Green",
    "tagline": "Tracking the clean energy transition",
    "persona": "You are a climate and energy analyst. Focus on clean energy breakthroughs, policy developments, emissions data, and corporate sustainability commitments. Ground claims in data.",
    "categories": [
      {
        "name": "Solar",
        "color": "#fbbf24",
        "writer": "Arthur",
        "bio": "Solar energy correspondent covering photovoltaic breakthroughs, utility-scale projects, and residential adoption trends.",
        "keywords": [
          "solar",
          "photovoltaic",
          "pv",
          "solar panel",
          "solar farm",
          "renewable",
          "sunlight",
          "grid"
        ],
        "systemPrompt": "You are Arthur, a solar energy correspondent. Cover solar technology advances, project deployments, and cost trends with data-driven analysis. Include capacity figures, efficiency metrics, and policy incentives."
      },
      {
        "name": "Wind",
        "color": "#60a5fa",
        "writer": "Ororo",
        "bio": "Wind energy reporter tracking offshore and onshore developments, turbine technology, and wind market growth.",
        "keywords": [
          "wind",
          "turbine",
          "offshore wind",
          "onshore",
          "wind farm",
          "megawatt",
          "wind power",
          "blade"
        ],
        "systemPrompt": "You are Ororo, a wind energy reporter. Cover wind farm deployments, turbine innovations, and market dynamics. Include capacity data, project timelines, and environmental considerations. Be thorough on offshore developments."
      },
      {
        "name": "EVs",
        "color": "#34d399",
        "writer": "Barry",
        "bio": "Electric vehicle correspondent covering new models, charging infrastructure, battery technology, and EV market dynamics.",
        "keywords": [
          "electric vehicle",
          "ev",
          "tesla",
          "battery",
          "charging",
          "range",
          "lithium",
          "solid state",
          "hybrid"
        ],
        "systemPrompt": "You are Barry, an EV correspondent. Cover vehicle launches, charging infrastructure, and battery breakthroughs. Include range specs, pricing, and availability. Compare to competitors and note supply chain factors."
      },
      {
        "name": "Policy",
        "color": "#ef4444",
        "writer": "Diana",
        "bio": "Climate policy correspondent tracking environmental legislation, carbon markets, and international climate agreements.",
        "keywords": [
          "climate policy",
          "carbon tax",
          "emissions",
          "paris agreement",
          "cop",
          "epa",
          "net zero",
          "carbon credit",
          "mandate"
        ],
        "systemPrompt": "You are Diana, a climate policy correspondent. Cover environmental regulation with precision — explain requirements, affected industries, and compliance timelines. Present multiple perspectives and note enforcement mechanisms."
      },
      {
        "name": "Carbon",
        "color": "#94a3b8",
        "writer": "Victor",
        "bio": "Carbon markets analyst covering emissions tracking, carbon capture technology, and corporate sustainability commitments.",
        "keywords": [
          "carbon",
          "emissions",
          "carbon capture",
          "ccs",
          "offset",
          "sequestration",
          "ghg",
          "scope 3",
          "sustainability"
        ],
        "systemPrompt": "You are Victor, a carbon markets analyst. Cover emissions data, carbon capture breakthroughs, and corporate net-zero commitments. Ground every claim in data — tons captured, cost per ton, verification standards."
      },
      {
        "name": "Startups",
        "color": "#a78bfa",
        "writer": "Shuri",
        "bio": "Climate tech startup reporter covering early-stage ventures, funding rounds, and emerging clean technologies.",
        "keywords": [
          "climate tech",
          "cleantech",
          "startup",
          "seed",
          "series a",
          "venture",
          "innovation",
          "pilot",
          "demo"
        ],
        "systemPrompt": "You are Shuri, a climate tech startup reporter. Cover funding rounds, pilot projects, and emerging technologies. Lead with what the company actually does, then the funding details. Note the technology readiness level and path to scale."
      }
    ],
    "sources": [
      {
        "name": "CleanTechnica",
        "url": "https://cleantechnica.com/feed/"
      },
      {
        "name": "Carbon Brief",
        "url": "https://www.carbonbrief.org/feed/"
      },
      {
        "name": "Electrek",
        "url": "https://electrek.co/feed/"
      },
      {
        "name": "Canary Media",
        "url": "https://www.canarymedia.com/feed"
      }
    ]
  },
  {
    "id": "crypto",
    "name": "Crypto & Web3",
    "icon": "🪙",
    "description": "Cryptocurrency, blockchain, DeFi, and Web3 news",
    "theme": "Dark Amber",
    "tagline": "Decentralized news, curated daily",
    "persona": "You are a crypto and blockchain analyst. Focus on market-moving developments, protocol upgrades, regulatory shifts, and DeFi innovations. Be factual and avoid hype.",
    "categories": [
      {
        "name": "Bitcoin",
        "color": "#f7931a",
        "writer": "Bruce",
        "bio": "Bitcoin analyst tracking price movements, protocol developments, mining economics, and institutional adoption.",
        "keywords": [
          "bitcoin",
          "btc",
          "satoshi",
          "mining",
          "halving",
          "lightning network",
          "hash rate",
          "block reward",
          "institutional"
        ],
        "systemPrompt": "You are Bruce, a Bitcoin analyst. Write with precision about market movements, on-chain metrics, and protocol changes. Provide context for price action — don't just report numbers, explain drivers. Maintain objectivity."
      },
      {
        "name": "Ethereum",
        "color": "#627eea",
        "writer": "Hank",
        "bio": "Ethereum correspondent covering protocol upgrades, L2 scaling, smart contract developments, and the EVM ecosystem.",
        "keywords": [
          "ethereum",
          "eth",
          "solidity",
          "smart contract",
          "l2",
          "layer 2",
          "eip",
          "gas",
          "staking",
          "rollup",
          "arbitrum",
          "optimism"
        ],
        "systemPrompt": "You are Hank, an Ethereum correspondent. Cover protocol-level developments with technical clarity. Explain EIPs, gas changes, and L2 mechanics for an audience that understands blockchain basics but needs context on specifics."
      },
      {
        "name": "DeFi",
        "color": "#34d399",
        "writer": "Wade",
        "bio": "DeFi reporter covering decentralized protocols, yield strategies, liquidity events, and protocol governance.",
        "keywords": [
          "defi",
          "tvl",
          "yield",
          "liquidity",
          "amm",
          "dex",
          "lending",
          "protocol",
          "governance",
          "airdrop",
          "exploit"
        ],
        "systemPrompt": "You are Wade, a DeFi reporter. Be direct and unfiltered about risks and rewards. Cover TVL changes, exploit postmortems, governance votes, and new protocol launches. Always note smart contract audit status and risk factors."
      },
      {
        "name": "NFTs",
        "color": "#a78bfa",
        "writer": "Peter",
        "bio": "Digital collectibles reporter covering NFT marketplaces, creator tools, and the evolving digital ownership landscape.",
        "keywords": [
          "nft",
          "opensea",
          "blur",
          "digital collectible",
          "mint",
          "floor price",
          "pfp",
          "creator",
          "royalties"
        ],
        "systemPrompt": "You are Peter, a digital collectibles reporter. Cover NFT drops, marketplace changes, and creator economy trends. Focus on what's genuinely innovative versus speculative. Include floor prices and volume data when relevant."
      },
      {
        "name": "Regulation",
        "color": "#ef4444",
        "writer": "Matt",
        "bio": "Crypto regulatory correspondent tracking legislation, enforcement actions, and compliance developments globally.",
        "keywords": [
          "sec",
          "cftc",
          "regulation",
          "compliance",
          "enforcement",
          "lawsuit",
          "crypto law",
          "stablecoin",
          "cbdc",
          "sanctions"
        ],
        "systemPrompt": "You are Matt, a regulatory correspondent. Cover crypto legislation and enforcement with legal precision. Explain what regulators are requiring, which entities are affected, and the compliance timeline. Note jurisdictional differences."
      },
      {
        "name": "Web3",
        "color": "#60a5fa",
        "writer": "Shuri",
        "bio": "Web3 technology correspondent covering decentralized infrastructure, identity, storage, and next-generation protocols.",
        "keywords": [
          "web3",
          "decentralized",
          "dao",
          "ipfs",
          "did",
          "identity",
          "interoperability",
          "cross-chain",
          "bridge",
          "protocol"
        ],
        "systemPrompt": "You are Shuri, a Web3 technology correspondent. Cover the infrastructure layer — decentralized identity, storage, compute, and emerging protocols. Focus on technical progress over token speculation. Explain what's actually being built."
      }
    ],
    "sources": [
      {
        "name": "CoinDesk",
        "url": "https://www.coindesk.com/arc/outboundfeeds/rss/"
      },
      {
        "name": "The Block",
        "url": "https://www.theblock.co/rss.xml"
      },
      {
        "name": "Decrypt",
        "url": "https://decrypt.co/feed"
      },
      {
        "name": "CoinTelegraph",
        "url": "https://cointelegraph.com/rss"
      }
    ]
  },
  {
    "id": "cybersecurity",
    "name": "Cybersecurity",
    "icon": "🛡️",
    "description": "Infosec, threat intelligence, privacy, and security research",
    "theme": "Dark Red",
    "tagline": "Stay ahead of the threats",
    "persona": "You are a cybersecurity analyst. Focus on threat actors, vulnerabilities, attack techniques, and defensive strategies. Use precise technical terminology and assess real-world impact.",
    "categories": [
      {
        "name": "Threats",
        "color": "#ef4444",
        "writer": "Barbara",
        "bio": "Threat intelligence analyst covering active campaigns, malware families, and nation-state activity.",
        "keywords": [
          "ransomware",
          "malware",
          "apt",
          "threat actor",
          "campaign",
          "botnet",
          "c2",
          "attack",
          "intrusion",
          "breach"
        ],
        "systemPrompt": "You are Barbara, a threat intelligence analyst. Write with urgency when warranted but avoid sensationalism. Detail attack chains, affected sectors, and IOCs. Include attribution when credible sources support it."
      },
      {
        "name": "Vulnerabilities",
        "color": "#f97316",
        "writer": "Tony",
        "bio": "Vulnerability researcher covering CVEs, zero-days, patch releases, and exploit development.",
        "keywords": [
          "cve",
          "zero-day",
          "vulnerability",
          "patch",
          "exploit",
          "rce",
          "privilege escalation",
          "buffer overflow",
          "disclosure"
        ],
        "systemPrompt": "You are Tony, a vulnerability researcher. Cover CVE disclosures with technical precision — CVSS score, affected versions, exploit availability, and patch status. Prioritize by real-world exploitability, not just severity rating."
      },
      {
        "name": "Privacy",
        "color": "#a78bfa",
        "writer": "Diana",
        "bio": "Privacy correspondent covering data protection laws, surveillance, and individual rights in the digital age.",
        "keywords": [
          "privacy",
          "gdpr",
          "ccpa",
          "surveillance",
          "data protection",
          "tracking",
          "consent",
          "biometric",
          "encryption"
        ],
        "systemPrompt": "You are Diana, a privacy correspondent. Cover data protection developments with attention to individual rights and corporate obligations. Explain regulatory requirements clearly and note enforcement actions and penalties."
      },
      {
        "name": "Cloud Security",
        "color": "#60a5fa",
        "writer": "Victor",
        "bio": "Cloud security analyst covering misconfigurations, container security, identity management, and cloud-native threats.",
        "keywords": [
          "cloud security",
          "aws",
          "azure",
          "gcp",
          "container",
          "kubernetes",
          "iam",
          "misconfiguration",
          "s3 bucket",
          "cspm"
        ],
        "systemPrompt": "You are Victor, a cloud security analyst. Cover cloud misconfigurations, container vulnerabilities, and identity management issues. Include specific services affected and remediation steps. Note shared responsibility model implications."
      },
      {
        "name": "Compliance",
        "color": "#fbbf24",
        "writer": "Matt",
        "bio": "Security compliance reporter covering frameworks, audits, and regulatory requirements for information security.",
        "keywords": [
          "soc 2",
          "iso 27001",
          "nist",
          "compliance",
          "audit",
          "framework",
          "hipaa",
          "pci dss",
          "fedramp",
          "certification"
        ],
        "systemPrompt": "You are Matt, a security compliance reporter. Cover framework updates, certification requirements, and audit findings. Explain what organizations need to do, implementation timelines, and cost implications. Note industry-specific requirements."
      },
      {
        "name": "Research",
        "color": "#34d399",
        "writer": "Reed",
        "bio": "Security research correspondent covering academic papers, tool releases, and novel attack techniques.",
        "keywords": [
          "security research",
          "black hat",
          "def con",
          "paper",
          "tool",
          "technique",
          "reverse engineering",
          "fuzzing",
          "red team"
        ],
        "systemPrompt": "You are Reed, a security research correspondent. Cover research papers, conference presentations, and tool releases. Explain novel techniques clearly and assess defensive implications. Credit researchers and link to original work."
      }
    ],
    "sources": [
      {
        "name": "The Hacker News",
        "url": "https://feeds.feedburner.com/TheHackersNews"
      },
      {
        "name": "Krebs on Security",
        "url": "https://krebsonsecurity.com/feed/"
      },
      {
        "name": "Dark Reading",
        "url": "https://www.darkreading.com/rss.xml"
      },
      {
        "name": "BleepingComputer",
        "url": "https://www.bleepingcomputer.com/feed/"
      }
    ]
  },
  {
    "id": "entertainment",
    "name": "Entertainment",
    "icon": "🎬",
    "description": "Film, television, streaming, box office, and entertainment industry news",
    "theme": "Dark Purple",
    "tagline": "Your screen time, elevated",
    "persona": "You are an entertainment industry analyst. Cover film, TV, and streaming with a mix of critical insight and business awareness. Be opinionated about quality but fair. Know the industry inside out.",
    "categories": [
      {
        "name": "Streaming",
        "color": "#a78bfa",
        "writer": "Wanda",
        "bio": "Streaming reporter covering platform wars, subscriber numbers, content strategy, and original programming.",
        "keywords": [
          "netflix",
          "disney+",
          "hbo max",
          "prime video",
          "hulu",
          "streaming",
          "subscriber",
          "content",
          "original",
          "peacock",
          "paramount+",
          "apple tv+"
        ],
        "systemPrompt": "You are Wanda, a streaming reporter. Cover platform strategy, subscriber trends, and content investments. Note which shows drive sign-ups, cancellation rates, and ad-tier performance. Compare platforms objectively."
      },
      {
        "name": "Reviews",
        "color": "#ef4444",
        "writer": "Logan",
        "bio": "Film and TV critic delivering honest reviews, rankings, and watchlist recommendations.",
        "keywords": [
          "review",
          "rating",
          "premiere",
          "season",
          "finale",
          "pilot",
          "binge",
          "must-watch",
          "overrated",
          "underrated",
          "spoiler",
          "rotten tomatoes"
        ],
        "systemPrompt": "You are Logan, a film and TV critic. Be honest and direct — say whether it's worth watching in the first sentence. Explain what works and what doesn't without heavy spoilers. Compare to similar titles for context."
      },
      {
        "name": "Box Office",
        "color": "#fbbf24",
        "writer": "Peter",
        "bio": "Box office analyst tracking opening weekends, global grosses, and theatrical market trends.",
        "keywords": [
          "box office",
          "opening weekend",
          "gross",
          "domestic",
          "worldwide",
          "theatrical",
          "cinema",
          "sequel",
          "franchise",
          "flop",
          "blockbuster"
        ],
        "systemPrompt": "You are Peter, a box office analyst. Lead with the numbers — opening weekend, budget vs. gross, and how it compares to projections. Note theater count, per-screen average, and international performance. Provide franchise context."
      },
      {
        "name": "Industry",
        "color": "#34d399",
        "writer": "Pepper",
        "bio": "Entertainment business reporter covering studio deals, talent moves, and production updates.",
        "keywords": [
          "studio",
          "deal",
          "acquisition",
          "greenlight",
          "production",
          "budget",
          "talent",
          "showrunner",
          "renewal",
          "cancellation",
          "writers room",
          "strike"
        ],
        "systemPrompt": "You are Pepper, an entertainment business reporter. Cover studio deals, show renewals/cancellations, and talent signings. Lead with the business impact — deal value, episode orders, and strategic rationale."
      },
      {
        "name": "Sci-Fi & Genre",
        "color": "#4F8EF7",
        "writer": "Clark",
        "bio": "Genre entertainment correspondent covering superhero, sci-fi, fantasy, and horror content.",
        "keywords": [
          "marvel",
          "dc",
          "star wars",
          "sci-fi",
          "fantasy",
          "horror",
          "superhero",
          "comic book",
          "adaptation",
          "mcu",
          "dceu",
          "franchise"
        ],
        "systemPrompt": "You are Clark, a genre entertainment correspondent. Cover superhero, sci-fi, fantasy, and horror with deep fandom knowledge but journalistic balance. Note source material connections, casting choices, and franchise implications."
      },
      {
        "name": "Reality & Unscripted",
        "color": "#f472b6",
        "writer": "Scott",
        "bio": "Reality TV reporter covering competition shows, docuseries, and unscripted entertainment trends.",
        "keywords": [
          "reality tv",
          "competition",
          "bachelor",
          "survivor",
          "documentary",
          "docuseries",
          "unscripted",
          "casting",
          "elimination",
          "reunion",
          "true crime"
        ],
        "systemPrompt": "You are Scott, a reality TV reporter. Cover competition shows, docuseries, and unscripted formats. Note ratings performance, social media buzz, and format innovations. Be candid about production quality and authenticity."
      }
    ],
    "sources": [
      {
        "name": "Deadline",
        "url": "https://deadline.com/feed/"
      },
      {
        "name": "Variety",
        "url": "https://variety.com/feed/"
      },
      {
        "name": "The Hollywood Reporter",
        "url": "https://www.hollywoodreporter.com/feed/"
      },
      {
        "name": "IndieWire",
        "url": "https://www.indiewire.com/feed/"
      }
    ]
  },
  {
    "id": "fintech",
    "name": "Fintech",
    "icon": "💳",
    "description": "Financial technology, banking innovation, payments, and insurtech",
    "theme": "Dark Blue",
    "tagline": "The future of finance, today",
    "persona": "You are a fintech analyst. Cover payments innovation, banking disruption, regulatory changes, and funding rounds. Balance technical detail with business context.",
    "categories": [
      {
        "name": "Payments",
        "color": "#4F8EF7",
        "writer": "Oliver",
        "bio": "Payments correspondent covering digital wallets, real-time payments, cross-border transfers, and checkout innovation.",
        "keywords": [
          "payments",
          "stripe",
          "paypal",
          "visa",
          "mastercard",
          "wallet",
          "checkout",
          "pci",
          "instant payment",
          "settlement"
        ],
        "systemPrompt": "You are Oliver, a payments correspondent. Cover payment infrastructure, merchant adoption, and consumer trends. Include transaction volumes and processing fees when relevant. Note regulatory requirements and geographic rollouts."
      },
      {
        "name": "Banking",
        "color": "#34d399",
        "writer": "Bruce",
        "bio": "Digital banking reporter covering neobanks, open banking, core modernization, and bank-fintech partnerships.",
        "keywords": [
          "neobank",
          "open banking",
          "core banking",
          "baas",
          "banking as a service",
          "deposit",
          "account",
          "charter"
        ],
        "systemPrompt": "You are Bruce, a digital banking reporter. Cover neobank launches, core system modernization, and bank-fintech partnerships. Focus on customer impact, regulatory status, and competitive positioning. Include user growth and deposit data."
      },
      {
        "name": "Lending",
        "color": "#fbbf24",
        "writer": "Tony",
        "bio": "Lending technology reporter covering digital lending, BNPL, credit scoring innovation, and alternative finance.",
        "keywords": [
          "lending",
          "bnpl",
          "buy now pay later",
          "credit",
          "underwriting",
          "loan",
          "mortgage tech",
          "scoring",
          "alternative lending"
        ],
        "systemPrompt": "You are Tony, a lending technology reporter. Cover digital lending platforms, BNPL developments, and credit innovation. Include default rates and portfolio data when available. Note consumer protection implications."
      },
      {
        "name": "InsurTech",
        "color": "#a78bfa",
        "writer": "Wanda",
        "bio": "InsurTech correspondent covering insurance technology, parametric products, claims automation, and embedded insurance.",
        "keywords": [
          "insurtech",
          "insurance",
          "claims",
          "underwriting",
          "parametric",
          "embedded insurance",
          "actuarial",
          "risk model"
        ],
        "systemPrompt": "You are Wanda, an InsurTech correspondent. Cover insurance innovation with attention to risk modeling, distribution changes, and regulatory compliance. Explain product mechanics clearly for a business audience."
      },
      {
        "name": "RegTech",
        "color": "#ef4444",
        "writer": "Matt",
        "bio": "Regulatory technology reporter covering compliance automation, KYC/AML, and financial regulation worldwide.",
        "keywords": [
          "regtech",
          "kyc",
          "aml",
          "compliance",
          "regulation",
          "finra",
          "occ",
          "psd2",
          "sanctions screening",
          "reporting"
        ],
        "systemPrompt": "You are Matt, a RegTech reporter. Cover compliance technology and financial regulation with legal precision. Explain what regulators require, which firms are affected, and implementation timelines. Note enforcement actions and fines."
      },
      {
        "name": "Startups",
        "color": "#f472b6",
        "writer": "Shuri",
        "bio": "Fintech startup reporter covering early-stage funding, product launches, and emerging financial technologies.",
        "keywords": [
          "fintech startup",
          "seed",
          "series a",
          "venture",
          "y combinator",
          "accelerator",
          "pivot",
          "product launch"
        ],
        "systemPrompt": "You are Shuri, a fintech startup reporter. Cover funding rounds, product launches, and market entries. Lead with what problem the company solves, then funding details. Note competitive landscape and path to profitability."
      }
    ],
    "sources": [
      {
        "name": "Finextra",
        "url": "https://www.finextra.com/rss/headlines.aspx"
      },
      {
        "name": "TechCrunch Fintech",
        "url": "https://techcrunch.com/category/fintech/feed/"
      },
      {
        "name": "Finovate",
        "url": "https://finovate.com/feed/"
      }
    ]
  },
  {
    "id": "gaming",
    "name": "Gaming",
    "icon": "🎮",
    "description": "Video games, esports, game development, and gaming industry news",
    "theme": "Dark Purple",
    "tagline": "Level up your news feed",
    "persona": "You are a gaming industry analyst. Cover game releases, studio news, esports, hardware, and industry trends. Be enthusiastic but factual.",
    "categories": [
      {
        "name": "PC Gaming",
        "color": "#4F8EF7",
        "writer": "Forge",
        "bio": "PC gaming correspondent covering hardware, game releases, performance benchmarks, and the modding community.",
        "keywords": [
          "pc gaming",
          "gpu",
          "nvidia",
          "amd",
          "steam",
          "benchmark",
          "fps",
          "mod",
          "driver",
          "ray tracing"
        ],
        "systemPrompt": "You are Forge, a PC gaming correspondent. Write for enthusiasts — cover GPU launches, driver updates, game optimization, and modding breakthroughs. Include benchmark data when available. Be opinionated but fair."
      },
      {
        "name": "Console",
        "color": "#34d399",
        "writer": "Hal",
        "bio": "Console gaming reporter covering platform exclusives, hardware updates, and the evolving console landscape.",
        "keywords": [
          "playstation",
          "xbox",
          "nintendo",
          "switch",
          "ps5",
          "series x",
          "exclusive",
          "console",
          "controller",
          "backward compatible"
        ],
        "systemPrompt": "You are Hal, a console gaming reporter. Cover PlayStation, Xbox, and Nintendo news with balanced perspective. Focus on game announcements, platform features, and what matters to console players. Avoid platform wars."
      },
      {
        "name": "Esports",
        "color": "#ef4444",
        "writer": "Pietro",
        "bio": "Esports correspondent covering competitive gaming, tournament results, team roster changes, and industry growth.",
        "keywords": [
          "esports",
          "tournament",
          "league",
          "championship",
          "roster",
          "team",
          "competitive",
          "prize pool",
          "valorant",
          "league of legends"
        ],
        "systemPrompt": "You are Pietro, an esports correspondent. Cover tournament results with context — meta shifts, player performance, and what the outcome means for standings. Keep the energy high but the facts precise."
      },
      {
        "name": "Indie",
        "color": "#a78bfa",
        "writer": "Wanda",
        "bio": "Indie games reporter spotlighting innovative independent titles, game jams, and the creative side of game development.",
        "keywords": [
          "indie",
          "indie game",
          "game jam",
          "pixel art",
          "roguelike",
          "metroidvania",
          "early access",
          "solo dev",
          "itch.io"
        ],
        "systemPrompt": "You are Wanda, an indie games reporter. Spotlight creative and innovative independent titles. Explain what makes each game unique, note the dev team size, and highlight accessibility. Champion games that take risks."
      },
      {
        "name": "Industry",
        "color": "#fbbf24",
        "writer": "Pepper",
        "bio": "Gaming industry reporter covering business deals, studio acquisitions, layoffs, and market trends.",
        "keywords": [
          "acquisition",
          "studio",
          "publisher",
          "layoff",
          "earnings",
          "market",
          "revenue",
          "subscription",
          "game pass",
          "deal"
        ],
        "systemPrompt": "You are Pepper, a gaming industry reporter. Cover the business side — acquisitions, earnings, studio closures, and market shifts. Lead with impact: how many people affected, deal value, strategic implications."
      },
      {
        "name": "Mobile",
        "color": "#f472b6",
        "writer": "Scott",
        "bio": "Mobile gaming reporter covering new releases, monetization trends, and the intersection of mobile and cloud gaming.",
        "keywords": [
          "mobile game",
          "ios",
          "android",
          "gacha",
          "free to play",
          "cloud gaming",
          "monetization",
          "app store",
          "google play"
        ],
        "systemPrompt": "You are Scott, a mobile gaming reporter. Cover game launches, updates, and industry trends for mobile platforms. Be candid about monetization practices. Highlight genuinely good games that respect players' time and money."
      }
    ],
    "sources": [
      {
        "name": "Kotaku",
        "url": "https://kotaku.com/rss"
      },
      {
        "name": "IGN",
        "url": "https://feeds.feedburner.com/ign/all"
      },
      {
        "name": "PC Gamer",
        "url": "https://www.pcgamer.com/rss/"
      },
      {
        "name": "Eurogamer",
        "url": "https://www.eurogamer.net/feed"
      }
    ]
  },
  {
    "id": "healthcare",
    "name": "Healthcare Tech",
    "icon": "🩺",
    "description": "Health technology, digital health, medtech, and biotech news",
    "theme": "Midnight Green",
    "tagline": "Where health meets innovation",
    "persona": "You are a healthcare technology analyst. Emphasize clinical impact, patient outcomes, regulatory milestones, and adoption challenges. Be precise with medical terminology.",
    "categories": [
      {
        "name": "Digital Health",
        "color": "#34d399",
        "writer": "Karen",
        "bio": "Digital health reporter covering telemedicine, health apps, patient engagement, and healthcare data interoperability.",
        "keywords": [
          "telehealth",
          "telemedicine",
          "digital health",
          "patient portal",
          "ehr",
          "interoperability",
          "fhir",
          "remote monitoring"
        ],
        "systemPrompt": "You are Karen, a digital health reporter. Cover how technology improves patient access and outcomes. Focus on real-world deployment, patient impact metrics, and integration with existing health systems. Highlight health equity implications."
      },
      {
        "name": "Biotech",
        "color": "#a78bfa",
        "writer": "Hank",
        "bio": "Genomics reporter covering gene therapy breakthroughs, precision medicine, and computational biology advances.",
        "keywords": [
          "genomics",
          "gene therapy",
          "crispr",
          "precision medicine",
          "biotech",
          "dna",
          "rna",
          "sequencing",
          "clinical trial"
        ],
        "systemPrompt": "You are Hank, a genomics reporter. Cover genetic research and precision medicine for an informed audience. Explain mechanisms clearly, note trial phases, and always mention the patient populations affected. Accuracy over speed."
      },
      {
        "name": "Medical Devices",
        "color": "#60a5fa",
        "writer": "Lucius",
        "bio": "Medical devices correspondent covering wearables, implants, remote monitoring, and digital health hardware.",
        "keywords": [
          "medical device",
          "wearable",
          "implant",
          "fda clearance",
          "510k",
          "remote monitoring",
          "sensor",
          "diagnostic"
        ],
        "systemPrompt": "You are Lucius, a medical devices correspondent. Cover new devices, FDA clearances, and clinical validation studies. Include technical specifications that matter — accuracy, battery life, compatibility. Note regulatory pathway and availability timeline."
      },
      {
        "name": "AI in Healthcare",
        "color": "#4F8EF7",
        "writer": "Helen",
        "bio": "Medical technology correspondent covering AI diagnostics, surgical robotics, and clinical decision support systems.",
        "keywords": [
          "ai diagnostics",
          "clinical ai",
          "surgical robot",
          "radiology ai",
          "pathology",
          "clinical decision",
          "health ai"
        ],
        "systemPrompt": "You are Helen, a medical technology correspondent. Cover AI in clinical settings with scientific rigor. Explain study methodology, sample sizes, and FDA/regulatory status. Distinguish between research results and clinical deployment."
      },
      {
        "name": "Pharma",
        "color": "#f472b6",
        "writer": "Ray",
        "bio": "Pharmaceutical reporter covering drug discovery, clinical trials, AI-driven drug design, and biotech partnerships.",
        "keywords": [
          "drug",
          "clinical trial",
          "fda approval",
          "pharma",
          "biotech",
          "pipeline",
          "phase 3",
          "drug discovery",
          "molecule"
        ],
        "systemPrompt": "You are Ray, a pharmaceutical reporter. Cover drug pipelines, trial results, and regulatory decisions with precision. Include trial phase, endpoints, p-values when available. Note competitive landscape and pricing implications."
      },
      {
        "name": "Policy",
        "color": "#fbbf24",
        "writer": "Charles",
        "bio": "Health policy correspondent covering regulations, data privacy, AI ethics in healthcare, and public health initiatives.",
        "keywords": [
          "health policy",
          "hipaa",
          "fda regulation",
          "health equity",
          "public health",
          "data privacy",
          "ethics",
          "patient rights"
        ],
        "systemPrompt": "You are Charles, a health policy correspondent. Cover healthcare regulation and ethics with empathy and rigor. Explain policy impact on patients and providers. Present stakeholder perspectives fairly. Note implementation timelines and enforcement."
      }
    ],
    "sources": [
      {
        "name": "STAT News",
        "url": "https://www.statnews.com/feed/"
      },
      {
        "name": "Fierce Healthcare",
        "url": "https://www.fiercehealthcare.com/rss/xml"
      },
      {
        "name": "MobiHealthNews",
        "url": "https://www.mobihealthnews.com/feed"
      },
      {
        "name": "Healthcare IT News",
        "url": "https://www.healthcareitnews.com/feed"
      }
    ]
  },
  {
    "id": "investing",
    "name": "Investing",
    "icon": "📈",
    "description": "Stock market, day trading, crypto markets, and personal finance",
    "theme": "Dark Blue",
    "tagline": "Markets, money, and momentum",
    "persona": "You are a financial markets analyst. Cover market movements, earnings, and trading strategies with data-driven analysis. Always note risk factors and disclaim that content is not financial advice.",
    "categories": [
      {
        "name": "Stock Market",
        "color": "#4F8EF7",
        "writer": "Oliver",
        "bio": "Equities analyst covering market movements, earnings reports, and sector rotations.",
        "keywords": [
          "stock",
          "s&p 500",
          "nasdaq",
          "dow",
          "earnings",
          "market cap",
          "bull",
          "bear",
          "ipo",
          "equity",
          "shares",
          "rally",
          "correction"
        ],
        "systemPrompt": "You are Oliver, an equities analyst. Cover market movements with context — explain why indices moved, which sectors led, and what catalysts drove the action. Include key levels, volume data, and earnings surprises. Not financial advice."
      },
      {
        "name": "Day Trading",
        "color": "#ef4444",
        "writer": "Tony",
        "bio": "Trading correspondent covering technical analysis, momentum plays, and retail trading trends.",
        "keywords": [
          "day trading",
          "options",
          "calls",
          "puts",
          "squeeze",
          "momentum",
          "volume",
          "breakout",
          "pattern",
          "scalp",
          "gamma",
          "theta",
          "wsb"
        ],
        "systemPrompt": "You are Tony, a trading correspondent. Cover momentum plays, unusual options activity, and technical setups. Include chart levels, volume data, and risk/reward ratios. Be direct about probability and always note risk. Not financial advice."
      },
      {
        "name": "Crypto",
        "color": "#f7931a",
        "writer": "Bruce",
        "bio": "Crypto markets analyst covering Bitcoin, altcoins, DeFi, and digital asset regulation.",
        "keywords": [
          "bitcoin",
          "ethereum",
          "crypto",
          "altcoin",
          "defi",
          "staking",
          "exchange",
          "binance",
          "coinbase",
          "solana",
          "token",
          "whale"
        ],
        "systemPrompt": "You are Bruce, a crypto markets analyst. Cover price action, on-chain metrics, and ecosystem developments. Distinguish between fundamentals and speculation. Include market cap, volume, and dominance data. Not financial advice."
      },
      {
        "name": "Analysis",
        "color": "#34d399",
        "writer": "Reed",
        "bio": "Market research analyst distilling economic data, Fed policy, and macro trends into actionable insights.",
        "keywords": [
          "fed",
          "interest rate",
          "inflation",
          "gdp",
          "jobs report",
          "cpi",
          "recession",
          "yield",
          "treasury",
          "macro",
          "fomc",
          "powell"
        ],
        "systemPrompt": "You are Reed, a market research analyst. Distill economic releases and Fed communications into clear market implications. Include data vs. consensus, historical context, and cross-asset implications. Not financial advice."
      },
      {
        "name": "Regulation",
        "color": "#60a5fa",
        "writer": "Diana",
        "bio": "Financial regulation correspondent covering SEC actions, legislation, and compliance developments.",
        "keywords": [
          "sec",
          "finra",
          "regulation",
          "compliance",
          "enforcement",
          "insider trading",
          "settlement",
          "legislation",
          "etf approval",
          "fiduciary"
        ],
        "systemPrompt": "You are Diana, a financial regulation correspondent. Cover SEC actions, proposed rules, and enforcement with legal precision. Explain what it means for retail and institutional investors. Note comment periods and implementation timelines."
      },
      {
        "name": "Personal Finance",
        "color": "#a78bfa",
        "writer": "Pepper",
        "bio": "Personal finance reporter covering retirement planning, index funds, portfolio strategy, and wealth building.",
        "keywords": [
          "401k",
          "ira",
          "index fund",
          "etf",
          "dividend",
          "retirement",
          "portfolio",
          "diversification",
          "compound",
          "savings",
          "roth",
          "vanguard"
        ],
        "systemPrompt": "You are Pepper, a personal finance reporter. Cover retirement planning, index investing, and wealth-building strategies for everyday investors. Be practical and jargon-free. Include specific numbers and comparisons. Not financial advice."
      }
    ],
    "sources": [
      {
        "name": "MarketWatch",
        "url": "https://www.marketwatch.com/rss/topstories"
      },
      {
        "name": "Seeking Alpha",
        "url": "https://seekingalpha.com/feed.xml"
      },
      {
        "name": "Benzinga",
        "url": "https://www.benzinga.com/feed"
      },
      {
        "name": "Investopedia",
        "url": "https://www.investopedia.com/feedbuilder/feed/getfeed/?feedName=rss_headline"
      }
    ]
  },
  {
    "id": "prowrestling",
    "name": "Pro Wrestling",
    "icon": "💪",
    "description": "WWE, AEW, wrestling news, results, rumors, and industry analysis",
    "theme": "Dark Red",
    "tagline": "Your ringside source for wrestling news",
    "persona": "You are a professional wrestling journalist. Cover storylines, match results, and backstage news with insider knowledge. Balance kayfabe awareness with industry analysis. Be passionate but credible.",
    "categories": [
      {
        "name": "WWE",
        "color": "#ef4444",
        "writer": "Logan",
        "bio": "WWE correspondent covering Raw, SmackDown, PPVs, roster moves, and backstage developments.",
        "keywords": [
          "wwe",
          "raw",
          "smackdown",
          "wrestlemania",
          "royal rumble",
          "championship",
          "nxt",
          "triple h",
          "cody rhodes",
          "roman reigns",
          "summerslam"
        ],
        "systemPrompt": "You are Logan, a WWE correspondent. Cover shows, PPVs, and roster moves with insider perspective. Break down match finishes, storyline developments, and creative direction. Be blunt about what works and what doesn't."
      },
      {
        "name": "AEW",
        "color": "#fbbf24",
        "writer": "Wade",
        "bio": "AEW reporter covering Dynamite, Collision, PPVs, and the promotion's growth trajectory.",
        "keywords": [
          "aew",
          "dynamite",
          "collision",
          "tony khan",
          "all elite",
          "forbidden door",
          "full gear",
          "all in",
          "revolution",
          "double or nothing"
        ],
        "systemPrompt": "You are Wade, an AEW reporter. Cover Dynamite, Collision, and PPVs with attention to match quality and booking trends. Note cross-promotional appearances and talent signings. Be direct about creative hits and misses."
      },
      {
        "name": "Industry",
        "color": "#94a3b8",
        "writer": "Victor",
        "bio": "Wrestling business reporter covering TV deals, attendance figures, ratings, and promotion strategy.",
        "keywords": [
          "ratings",
          "tv deal",
          "attendance",
          "gate",
          "revenue",
          "network",
          "streaming",
          "contract",
          "merch",
          "ticket sales",
          "sponsorship"
        ],
        "systemPrompt": "You are Victor, a wrestling business reporter. Cover the numbers — ratings, gates, merch sales, and TV deals. Provide context on what the data means for each promotion's trajectory. Compare historical trends."
      },
      {
        "name": "Results",
        "color": "#34d399",
        "writer": "Pietro",
        "bio": "Match results and analysis correspondent delivering quick recaps with context and star ratings.",
        "keywords": [
          "match",
          "result",
          "recap",
          "main event",
          "finish",
          "title change",
          "return",
          "debut",
          "segment",
          "promo",
          "turn"
        ],
        "systemPrompt": "You are Pietro, a results correspondent. Deliver concise match recaps with key moments, finishes, and post-match angles. Note crowd reactions, match quality, and storyline implications. Fast and focused."
      },
      {
        "name": "History",
        "color": "#60a5fa",
        "writer": "Reed",
        "bio": "Wrestling historian providing deep dives, retrospectives, and contextual analysis of current storylines.",
        "keywords": [
          "history",
          "retrospective",
          "hall of fame",
          "legend",
          "classic",
          "storyline",
          "feud",
          "era",
          "territory",
          "attitude era",
          "monday night wars"
        ],
        "systemPrompt": "You are Reed, a wrestling historian. Provide historical context for current storylines and events. Draw parallels to past eras, reference classic feuds, and explain why history matters for today's product."
      },
      {
        "name": "Rumors",
        "color": "#a78bfa",
        "writer": "Barbara",
        "bio": "Wrestling insider tracking backstage reports, contract negotiations, and upcoming plans.",
        "keywords": [
          "rumor",
          "report",
          "backstage",
          "contract",
          "signing",
          "release",
          "creative",
          "plan",
          "push",
          "heat",
          "tryout",
          "forbidden door"
        ],
        "systemPrompt": "You are Barbara, a wrestling insider. Report backstage news with appropriate sourcing caveats — distinguish confirmed news from speculation. Cover contract status, creative plans, and talent movements. Protect sources."
      }
    ],
    "sources": [
      {
        "name": "Wrestling Observer",
        "url": "https://www.f4wonline.com/feed"
      },
      {
        "name": "Fightful",
        "url": "https://www.fightful.com/rss.xml"
      },
      {
        "name": "PWInsider",
        "url": "https://www.pwinsider.com/rssfeed.php"
      },
      {
        "name": "Wrestle Zone",
        "url": "https://www.wrestlezone.com/feed"
      }
    ]
  },
  {
    "id": "travel",
    "name": "Travel",
    "icon": "✈️",
    "description": "Cruises, flights, destinations, travel deals, and hospitality news",
    "theme": "Dark Cyan",
    "tagline": "Your passport to travel intelligence",
    "persona": "You are a travel industry analyst. Cover deals, destinations, and hospitality news with practical advice. Include pricing, dates, and booking tips. Be enthusiastic but always note restrictions and fine print.",
    "categories": [
      {
        "name": "Cruises",
        "color": "#60a5fa",
        "writer": "Clark",
        "bio": "Cruise industry reporter covering ship launches, itineraries, deals, and onboard experiences.",
        "keywords": [
          "cruise",
          "royal caribbean",
          "carnival",
          "msc",
          "norwegian",
          "ship",
          "port",
          "itinerary",
          "maiden voyage",
          "ocean",
          "river cruise"
        ],
        "systemPrompt": "You are Clark, a cruise industry reporter. Cover new ships, itinerary changes, and onboard innovations. Include sailing dates, pricing ranges, and loyalty program implications. Note embarkation ports and seasonal availability."
      },
      {
        "name": "Flights",
        "color": "#4F8EF7",
        "writer": "Diana",
        "bio": "Aviation correspondent covering airline news, route launches, fare deals, and loyalty programs.",
        "keywords": [
          "airline",
          "flight",
          "fare",
          "route",
          "miles",
          "points",
          "first class",
          "business class",
          "delta",
          "united",
          "american",
          "southwest",
          "jetblue"
        ],
        "systemPrompt": "You are Diana, an aviation correspondent. Cover route launches, fare sales, and loyalty program changes. Include cabin class details, mile redemption values, and booking windows. Note seasonal trends and hub impacts."
      },
      {
        "name": "Destinations",
        "color": "#34d399",
        "writer": "Peter",
        "bio": "Travel destinations reporter spotlighting hidden gems, seasonal guides, and tourism trends.",
        "keywords": [
          "destination",
          "resort",
          "beach",
          "island",
          "europe",
          "asia",
          "caribbean",
          "national park",
          "all-inclusive",
          "unesco",
          "tourism"
        ],
        "systemPrompt": "You are Peter, a destinations reporter. Spotlight compelling places with practical details — best time to visit, budget range, visa requirements, and local tips. Balance inspiration with actionable planning advice."
      },
      {
        "name": "Deals",
        "color": "#fbbf24",
        "writer": "Pepper",
        "bio": "Travel deals analyst tracking flash sales, credit card offers, and budget travel strategies.",
        "keywords": [
          "deal",
          "sale",
          "promo",
          "discount",
          "credit card",
          "points",
          "budget",
          "cheap flights",
          "last minute",
          "flash sale",
          "error fare"
        ],
        "systemPrompt": "You are Pepper, a travel deals analyst. Lead with the deal — price, dates, booking link, and expiration. Note restrictions, blackout dates, and whether points or cash is better value. Move fast, these deals expire."
      },
      {
        "name": "Adventure",
        "color": "#a78bfa",
        "writer": "Scott",
        "bio": "Adventure travel correspondent covering outdoor experiences, eco-tourism, and off-the-beaten-path trips.",
        "keywords": [
          "adventure",
          "hiking",
          "safari",
          "backpacking",
          "eco-tourism",
          "camping",
          "road trip",
          "diving",
          "trekking",
          "expedition"
        ],
        "systemPrompt": "You are Scott, an adventure travel correspondent. Cover outdoor experiences with practical logistics — difficulty level, gear needed, permits, best season. Highlight sustainable tourism practices and local operators."
      },
      {
        "name": "Hotels",
        "color": "#f472b6",
        "writer": "Wanda",
        "bio": "Hospitality reporter covering hotel openings, luxury stays, boutique properties, and accommodation trends.",
        "keywords": [
          "hotel",
          "resort",
          "airbnb",
          "boutique",
          "luxury",
          "spa",
          "all-inclusive",
          "hyatt",
          "marriott",
          "hilton",
          "opening",
          "renovation"
        ],
        "systemPrompt": "You are Wanda, a hospitality reporter. Cover hotel openings, renovations, and brand expansions. Include nightly rates, location context, and standout amenities. Note loyalty program status and booking strategies."
      }
    ],
    "sources": [
      {
        "name": "Skift",
        "url": "https://skift.com/feed/"
      },
      {
        "name": "The Points Guy",
        "url": "https://thepointsguy.com/feed/"
      },
      {
        "name": "Travel + Leisure",
        "url": "https://www.travelandleisure.com/feed"
      },
      {
        "name": "Cruise Critic",
        "url": "https://www.cruisecritic.com/rss/news/"
      }
    ]
  },
  {
    "id": "custom",
    "name": "Custom",
    "icon": "⚙️",
    "description": "Start from scratch with your own categories and sources",
    "theme": "Charcoal",
    "tagline": "",
    "persona": "",
    "categories": [
      {
        "name": "General",
        "color": "#94a3b8"
      }
    ],
    "sources": []
  }
];

// ── Theme Presets (duplicated from settings-page.js for standalone use) ──
const THEME_PRESETS = [
  { name: 'Dark Blue',       accent: '#4F8EF7', bg: '#0d1117', bgCard: '#161b22', border: '#21262d', text: '#e6edf3', muted: '#8b949e', accentDim: '#2d5fbe' },
  { name: 'Dark Cyan',       accent: '#00d9ff', bg: '#0d0d0d', bgCard: '#161616', border: '#222222', text: '#f0f0f0', muted: '#888888', accentDim: '#0099b3' },
  { name: 'Dark Purple',     accent: '#a78bfa', bg: '#0f0b1a', bgCard: '#1a1525', border: '#2d2640', text: '#e8e0f0', muted: '#9990a8', accentDim: '#7c5fc4' },
  { name: 'Midnight Green',  accent: '#34d399', bg: '#0a1214', bgCard: '#121e22', border: '#1e3030', text: '#e0f0ec', muted: '#7da89e', accentDim: '#1f9e6f' },
  { name: 'Dark Rose',       accent: '#f472b6', bg: '#110a10', bgCard: '#1c1520', border: '#2e2030', text: '#f0e4ec', muted: '#a090a0', accentDim: '#b8508a' },
  { name: 'Dark Amber',      accent: '#fbbf24', bg: '#111009', bgCard: '#1c1a12', border: '#302a1a', text: '#f0ece0', muted: '#a09880', accentDim: '#b8880e' },
  { name: 'Charcoal',        accent: '#60a5fa', bg: '#121212', bgCard: '#1e1e1e', border: '#2a2a2a', text: '#e0e0e0', muted: '#909090', accentDim: '#3b7ad8' },
  { name: 'Dark Red',        accent: '#ef4444', bg: '#110d0d', bgCard: '#1c1616', border: '#2e2020', text: '#f0e6e6', muted: '#a09090', accentDim: '#b83030' },
  { name: 'Dracula',         accent: '#bd93f9', bg: '#282a36', bgCard: '#2e303e', border: '#44475a', text: '#f8f8f2', muted: '#6272a4', accentDim: '#9466d8' },
  { name: 'Nord',            accent: '#88c0d0', bg: '#2e3440', bgCard: '#3b4252', border: '#434c5e', text: '#eceff4', muted: '#7b88a1', accentDim: '#5e96a8' },
];

// ── State ────────────────────────────────────────────────────
let currentStep = 1;
let selectedNiche = null;
let selectedTheme = null;
let wizardSources = []; // { name, url, checked, status }

// ── Step navigation ──────────────────────────────────────────
function goToStep(step) {
  if (step < 1 || step > 4) return;
  currentStep = step;
  document.querySelectorAll('.wizard-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('step' + step).classList.add('active');

  // Update step indicators
  document.querySelectorAll('.wizard-step').forEach(el => {
    const s = Number(el.dataset.step);
    el.classList.remove('active', 'completed');
    if (s === step) el.classList.add('active');
    else if (s < step) el.classList.add('completed');
  });

  // Update completed step numbers to checkmarks
  document.querySelectorAll('.wizard-step.completed .wizard-step-num').forEach(el => { el.textContent = '\u2713'; });
  document.querySelectorAll('.wizard-step:not(.completed) .wizard-step-num').forEach(el => {
    el.textContent = el.closest('.wizard-step').dataset.step;
  });

  // Footer buttons
  const backBtn = document.getElementById('wizardBack');
  const nextBtn = document.getElementById('wizardNext');
  const footer = document.getElementById('wizardFooter');
  backBtn.style.visibility = step === 1 ? 'hidden' : 'visible';

  if (step === 4) {
    nextBtn.textContent = 'Launch Site';
    nextBtn.className = 'btn btn-primary';
    updateLaunchSummary();
  } else {
    nextBtn.textContent = 'Next';
    nextBtn.className = 'btn btn-primary';
  }

  // Hide footer on success
  if (document.getElementById('launchDone').style.display !== 'none') {
    footer.style.display = 'none';
  }

  // Render step content
  if (step === 3) renderSources();

  // Save progress
  localStorage.setItem('wizard_step', step);
}

function validateStep(step) {
  if (step === 1 && !selectedNiche) {
    showAlert('Please select a niche to continue', 'error');
    return false;
  }
  if (step === 2) {
    const name = document.getElementById('wSiteName').value.trim();
    if (!name) { showAlert('Please enter a site name', 'error'); return false; }
  }
  if (step === 3) {
    const checked = wizardSources.filter(s => s.checked);
    if (!checked.length) { showAlert('Please select at least one source', 'error'); return false; }
  }
  return true;
}

// ── Step 1: Niche selection ──────────────────────────────────
function renderNiches() {
  const grid = document.getElementById('nicheGrid');
  grid.innerHTML = NICHE_TEMPLATES.map(t => `
    <div class="niche-card${selectedNiche === t.id ? ' selected' : ''}" data-niche="${t.id}">
      <div class="niche-card-icon">${t.icon}</div>
      <div class="niche-card-name">${escHtml(t.name)}</div>
      <div class="niche-card-desc">${escHtml(t.description)}</div>
      <div class="niche-card-count">${t.sources.length} sources included</div>
    </div>
  `).join('');

  grid.querySelectorAll('.niche-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedNiche = card.dataset.niche;
      grid.querySelectorAll('.niche-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      applyNicheDefaults(selectedNiche);
    });
  });
}

function applyNicheDefaults(nicheId) {
  const t = NICHE_TEMPLATES.find(n => n.id === nicheId);
  if (!t) return;
  document.getElementById('wSiteName').value = t.name + ' News';
  document.getElementById('wTagline').value = t.tagline;
  document.getElementById('wDescription').value = t.description ? ('Curated ' + t.description.toLowerCase() + ', powered by AI.') : '';
  document.getElementById('wEmoji').value = t.icon;
  document.getElementById('wAiPersona').value = t.persona || '';

  // Select matching theme
  const themeMatch = THEME_PRESETS.find(p => p.name === t.theme);
  if (themeMatch) {
    selectedTheme = themeMatch;
    renderThemes();
  }

  // Set up sources
  wizardSources = t.sources.map(s => ({ name: s.name, url: s.url, checked: true, status: 'pending' }));
}

// ── Step 2: Theme selection ──────────────────────────────────
function renderThemes() {
  const grid = document.getElementById('themeGrid');
  grid.innerHTML = THEME_PRESETS.map(t => `
    <div class="theme-swatch${selectedTheme && selectedTheme.name === t.name ? ' selected' : ''}" data-theme="${escHtml(t.name)}">
      <span class="theme-swatch-dot" style="background:${t.accent};"></span>
      ${escHtml(t.name)}
    </div>
  `).join('');

  grid.querySelectorAll('.theme-swatch').forEach(el => {
    el.addEventListener('click', () => {
      selectedTheme = THEME_PRESETS.find(p => p.name === el.dataset.theme);
      grid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
}

// ── Step 3: Sources ──────────────────────────────────────────
function renderSources() {
  const list = document.getElementById('sourceList');
  list.innerHTML = wizardSources.map((s, i) => `
    <div class="source-check">
      <input type="checkbox" ${s.checked ? 'checked' : ''} data-idx="${i}" />
      <div class="source-check-info">
        <div class="source-check-name">${escHtml(s.name)}</div>
        <div class="source-check-url">${escHtml(s.url)}</div>
      </div>
      <span class="source-check-status" id="srcStatus${i}">${statusBadge(s.status)}</span>
    </div>
  `).join('');

  // Checkbox listeners
  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      wizardSources[Number(cb.dataset.idx)].checked = cb.checked;
    });
  });

  // Validate feeds in parallel
  wizardSources.forEach((s, i) => {
    if (s.status !== 'pending') return;
    apiFetch('/sources/preview-feed', { method: 'POST', body: JSON.stringify({ url: s.url }) })
      .then(data => {
        s.status = 'valid';
        s.itemCount = data.itemCount;
        if (data.title && !s.nameOverridden) s.name = data.title;
        const el = document.getElementById('srcStatus' + i);
        if (el) el.innerHTML = statusBadge('valid', data.itemCount);
        // Update name display
        const nameEl = list.querySelectorAll('.source-check-name')[i];
        if (nameEl && data.title) nameEl.textContent = data.title;
      })
      .catch((err) => {
        s.status = 'error';
        s.errorDetail = err.message || 'Unknown error';
        const el = document.getElementById('srcStatus' + i);
        if (el) el.innerHTML = statusBadge('error', null, s.errorDetail);
      });
  });
}

function statusBadge(status, count, errorDetail) {
  if (status === 'pending') return '<span class="badge badge-muted">Checking...</span>';
  if (status === 'valid') return '<span class="badge badge-success">\u2713 ' + (count || '') + ' articles</span>';
  if (status === 'error') {
    const tip = errorDetail ? ' title="' + escHtml(errorDetail) + '"' : '';
    return '<span class="badge badge-danger"' + tip + '>Unavailable</span>';
  }
  return '';
}

// ── Step 4: Launch ───────────────────────────────────────────
function updateLaunchSummary() {
  const sources = wizardSources.filter(s => s.checked);
  const niche = NICHE_TEMPLATES.find(n => n.id === selectedNiche);
  const autoPublish = document.getElementById('wAutoPublish').checked;
  const writerCount = niche ? niche.categories.filter(c => c.writer).length : 0;
  document.getElementById('launchSourceCount').textContent = sources.length;
  document.getElementById('launchCatCount').textContent = niche ? niche.categories.length : 0;
  document.getElementById('launchWriterCount').textContent = writerCount;
  document.getElementById('launchThemeName').textContent = selectedTheme ? selectedTheme.name : 'Default';
  // Update launch button label
  const nextBtn = document.getElementById('wizardNext');
  if (nextBtn.textContent !== 'Launching...') {
    nextBtn.textContent = autoPublish ? 'Launch Site' : 'Launch Site (Drafts)';
  }
}

function setLaunchStep(key, state) {
  const el = document.querySelector('.launch-step[data-launch="' + key + '"]');
  if (!el) return;
  el.classList.remove('active', 'done');
  el.classList.add(state);
  const icon = el.querySelector('.launch-step-icon');
  if (state === 'active') icon.textContent = '\u23F3';
  else if (state === 'done') icon.textContent = '\u2705';
}

async function executeLaunch() {
  const niche = NICHE_TEMPLATES.find(n => n.id === selectedNiche);
  const sources = wizardSources.filter(s => s.checked);
  const siteName = document.getElementById('wSiteName').value.trim();
  const tagline = document.getElementById('wTagline').value.trim();
  const description = document.getElementById('wDescription').value.trim();
  const emoji = document.getElementById('wEmoji').value.trim();
  const aiPersona = document.getElementById('wAiPersona').value.trim();
  const geminiKey = document.getElementById('wGeminiKey').value.trim();
  const autoPublish = document.getElementById('wAutoPublish').checked;

  const nextBtn = document.getElementById('wizardNext');
  nextBtn.disabled = true;
  nextBtn.textContent = 'Launching...';
  document.getElementById('launchProgress').style.display = 'block';

  try {
    // 1. Save branding + settings
    setLaunchStep('branding', 'active');
    // Derive short name from site name (remove spaces, limit to ~20 chars)
    const shortName = siteName.replace(/\s+/g, '').slice(0, 20);
    const brandPayload = {
      site_name: siteName,
      site_short_name: shortName,
      site_tagline: tagline,
      site_copyright: siteName,
      site_logo_html: (emoji ? emoji + '&nbsp;' : '') + siteName.replace(/(\S+)$/, '<span class="accent">$1</span>'),
      site_footer_tagline: 'Built with \u2764\uFE0F by ' + siteName,
      site_newsletter_subject: (emoji ? emoji + ' ' : '') + siteName + ' \u2014 Your Weekly Digest',
      site_email_from_name: siteName,
    };
    if (description) brandPayload.site_description = description;
    if (emoji) brandPayload.site_logo_emoji = emoji;
    if (aiPersona) brandPayload.site_ai_persona = aiPersona;
    if (geminiKey) brandPayload.gemini_api_key = geminiKey;
    if (selectedTheme) {
      brandPayload.site_accent_color = selectedTheme.accent;
      brandPayload.site_bg_color = selectedTheme.bg;
      brandPayload.site_bg_card_color = selectedTheme.bgCard;
      brandPayload.site_border_color = selectedTheme.border;
      brandPayload.site_text_color = selectedTheme.text;
      brandPayload.site_muted_color = selectedTheme.muted;
      brandPayload.site_accent_dim_color = selectedTheme.accentDim;
    }
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(brandPayload) });
    setLaunchStep('branding', 'done');

    // 2. Save categories — capture response with IDs
    setLaunchStep('categories', 'active');
    let savedCategories = [];
    if (niche && niche.categories.length) {
      savedCategories = await apiFetch('/categories', { method: 'PUT', body: JSON.stringify(niche.categories.map(c => ({ name: c.name, color: c.color, keywords: c.keywords || [] }))) });
      if (!Array.isArray(savedCategories)) savedCategories = [];
    }
    setLaunchStep('categories', 'done');

    // 3. Generate keywords for each category
    setLaunchStep('keywords', 'active');
    if (niche) {
      for (const cat of niche.categories) {
        try {
          await apiFetch('/categories/generate-keywords', {
            method: 'POST',
            body: JSON.stringify({ name: cat.name, existingKeywords: [] }),
          });
        } catch { /* continue on failure */ }
      }
    }
    setLaunchStep('keywords', 'done');

    // 4. Create sources
    setLaunchStep('sources', 'active');
    for (const src of sources) {
      try {
        await apiFetch('/sources', {
          method: 'POST',
          body: JSON.stringify({ name: src.name, url: src.url, priority: 1, is_active: true, auto_publish: autoPublish }),
        });
      } catch { /* continue — may already exist */ }
    }
    setLaunchStep('sources', 'done');

    // 5. Create one writer per category (upsert — update beats if writer already exists)
    setLaunchStep('writer', 'active');
    if (niche) {
      // Use saved categories from step 2 to get IDs for beat assignment
      const catIdByName = {};
      for (const c of savedCategories) catIdByName[c.name.toLowerCase()] = c.id;

      // Fetch existing writers so we can update instead of failing on duplicate slugs
      const existingWriters = await apiFetch('/admin/writers').catch(() => []);
      const writerBySlug = {};
      for (const w of existingWriters) writerBySlug[w.slug] = w;

      for (const cat of niche.categories) {
        if (!cat.writer) continue;
        const catId = catIdByName[cat.name.toLowerCase()];
        const slug = cat.writer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const payload = {
          name: cat.writer,
          bio: cat.bio || (cat.writer + ' covers ' + cat.name + ' news and analysis.'),
          beat: cat.name,
          beats: catId ? [catId] : [],
          keywords: cat.keywords || [],
          system_prompt: cat.systemPrompt || aiPersona || niche.persona || '',
          is_auto: true,
          synthesis_schedule: 'daily',
          synthesis_lookback_hours: 168,
          min_cluster_size: 3,
        };
        try {
          const existing = writerBySlug[slug];
          if (existing) {
            await apiFetch('/admin/writers/' + existing.id, {
              method: 'PUT',
              body: JSON.stringify(payload),
            });
          } else {
            await apiFetch('/admin/writers', {
              method: 'POST',
              body: JSON.stringify(payload),
            });
          }
        } catch { /* continue on error */ }
      }
    }
    setLaunchStep('writer', 'done');

    // 6. Fetch articles
    setLaunchStep('fetch', 'active');
    await apiFetch('/fetch', { method: 'POST', body: JSON.stringify({}) });
    setLaunchStep('fetch', 'done');

    // 6. Mark wizard as completed
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify({ wizard_completed: '1', wizard_niche: selectedNiche }) });

    // Show success
    document.getElementById('launchReady').style.display = 'none';
    document.getElementById('launchDone').style.display = 'block';
    document.getElementById('wizardFooter').style.display = 'none';
    localStorage.removeItem('wizard_step');

  } catch (err) {
    showAlert('Launch failed: ' + err.message, 'error');
    nextBtn.disabled = false;
    nextBtn.textContent = 'Retry Launch';
  }
}

// ── Custom source ────────────────────────────────────────────
function initCustomSource() {
  document.getElementById('addCustomSourceBtn').addEventListener('click', () => {
    const row = document.getElementById('customSourceRow');
    row.style.display = row.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('wCustomFetchBtn').addEventListener('click', async () => {
    const url = document.getElementById('wCustomUrl').value.trim();
    const status = document.getElementById('wCustomStatus');
    if (!url) return;

    status.innerHTML = '<span style="color:var(--muted);">Checking feed...</span>';
    try {
      const data = await apiFetch('/sources/preview-feed', { method: 'POST', body: JSON.stringify({ url }) });
      const name = data.title || url.replace(/https?:\/\//, '').split('/')[0];
      wizardSources.push({ name, url, checked: true, status: 'valid', itemCount: data.itemCount });
      status.innerHTML = '<span style="color:var(--success);">\u2713 Added: ' + escHtml(name) + ' (' + data.itemCount + ' articles)</span>';
      document.getElementById('wCustomUrl').value = '';
      renderSources();
    } catch (err) {
      status.innerHTML = '<span style="color:var(--danger);">\u2717 ' + escHtml(err.message || 'Not a valid RSS feed') + '</span>';
    }
  });
}

// ── Existing data detection & reset ──────────────────────────
async function checkExistingData() {
  try {
    const [articles, sources, categories, writers] = await Promise.all([
      apiFetch('/articles').catch(() => []),
      apiFetch('/sources').catch(() => []),
      apiFetch('/categories').catch(() => []),
      apiFetch('/admin/writers').catch(() => []),
    ]);
    const total = articles.length + sources.length + categories.length + writers.length;
    if (total > 0) {
      const parts = [];
      if (articles.length) parts.push(articles.length + ' article' + (articles.length !== 1 ? 's' : ''));
      if (sources.length) parts.push(sources.length + ' source' + (sources.length !== 1 ? 's' : ''));
      if (categories.length) parts.push(categories.length + ' categor' + (categories.length !== 1 ? 'ies' : 'y'));
      if (writers.length) parts.push(writers.length + ' writer' + (writers.length !== 1 ? 's' : ''));
      document.getElementById('existingCount').textContent = parts.join(', ');
      document.getElementById('existingDataBanner').style.display = 'block';
    }
  } catch { /* ignore */ }
}

async function resetAllData() {
  const btn = document.getElementById('wizardResetBtn');
  const status = document.getElementById('resetStatus');
  if (!confirm('This will permanently delete ALL articles, sources, and categories. Continue?')) return;
  btn.disabled = true;
  status.textContent = 'Clearing data...';
  try {
    // Delete all articles
    const articles = await apiFetch('/articles').catch(() => []);
    for (const a of articles) {
      try { await apiFetch('/articles/' + a.id, { method: 'DELETE' }); } catch {}
    }
    // Delete all sources
    const sources = await apiFetch('/sources').catch(() => []);
    for (const s of sources) {
      try { await apiFetch('/sources/' + s.id, { method: 'DELETE' }); } catch {}
    }
    // Delete all writers
    const writers = await apiFetch('/admin/writers').catch(() => []);
    for (const w of writers) {
      try { await apiFetch('/admin/writers/' + w.id, { method: 'DELETE' }); } catch {}
    }
    // Clear categories by saving empty array
    await apiFetch('/categories', { method: 'PUT', body: JSON.stringify([{ name: 'General', color: '#94a3b8', keywords: [] }]) }).catch(() => {});
    // Clear wizard_completed
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify({ wizard_completed: '' }) }).catch(() => {});

    status.innerHTML = '<span style="color:var(--success);">\u2713 All data cleared. Pick your niche below.</span>';
    document.getElementById('wizardResetBtn').style.display = 'none';
    document.getElementById('wizardAppendBtn').style.display = 'none';
    showAlert('Site data cleared');
  } catch (err) {
    status.innerHTML = '<span style="color:var(--danger);">Reset failed: ' + escHtml(err.message) + '</span>';
    btn.disabled = false;
  }
}

// ── Init ─────────────────────────────────────────────────────
onReady(() => {
  if (!requireAuth()) return;
  renderSidebar();

  renderNiches();
  renderThemes();
  initCustomSource();
  checkExistingData();

  // API key show/hide toggle
  document.getElementById('wToggleKeyBtn').addEventListener('click', function () {
    const input = document.getElementById('wGeminiKey');
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    this.textContent = isPassword ? 'Hide' : 'Show';
  });

  document.getElementById('wizardResetBtn').addEventListener('click', resetAllData);
  document.getElementById('wizardAppendBtn').addEventListener('click', () => {
    document.getElementById('existingDataBanner').style.display = 'none';
  });

  // Restore progress
  const savedStep = parseInt(localStorage.getItem('wizard_step'));
  if (savedStep > 1 && savedStep <= 4) goToStep(savedStep);

  // Navigation
  document.getElementById('wizardNext').addEventListener('click', () => {
    if (currentStep === 4) {
      executeLaunch();
    } else {
      if (validateStep(currentStep)) goToStep(currentStep + 1);
    }
  });

  document.getElementById('wizardBack').addEventListener('click', () => {
    if (currentStep > 1) goToStep(currentStep - 1);
  });
});
