'use strict';
(function(){
  const SUGGESTED_BY_NICHE = {
    'ai-tech': [
      { name: 'The Verge AI',           url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',    category: 'Tech Media' },
      { name: 'Wired AI',               url: 'https://www.wired.com/feed/category/artificial-intelligence/latest/rss', category: 'Tech Media' },
      { name: 'TechCrunch AI',          url: 'https://techcrunch.com/category/artificial-intelligence/feed/',          category: 'Tech Media' },
      { name: 'VentureBeat AI',         url: 'https://venturebeat.com/category/ai/feed/',                              category: 'Tech Media' },
      { name: 'Ars Technica',           url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',               category: 'Tech Media' },
      { name: 'MIT Technology Review',  url: 'https://www.technologyreview.com/feed/',                                  category: 'Research' },
      { name: 'Google AI Blog',         url: 'https://blog.google/technology/ai/rss/',                                  category: 'Company Blogs' },
      { name: 'OpenAI Blog',            url: 'https://openai.com/blog/rss.xml',                                         category: 'Company Blogs' },
      { name: 'Anthropic News',         url: 'https://www.anthropic.com/news/rss.xml',                                  category: 'Company Blogs' },
      { name: 'Meta AI Blog',           url: 'https://ai.meta.com/blog/rss/',                                           category: 'Company Blogs' },
      { name: 'DeepMind Blog',          url: 'https://deepmind.google/blog/rss.xml',                                    category: 'Company Blogs' },
      { name: 'Hugging Face Blog',      url: 'https://huggingface.co/blog/feed.xml',                                    category: 'Developer' },
      { name: 'NVIDIA AI Blog',         url: 'https://blogs.nvidia.com/blog/category/deep-learning/feed/',              category: 'Company Blogs' },
      { name: 'AI News',                url: 'https://www.artificialintelligence-news.com/feed/',                       category: 'Tech Media' },
      { name: 'The Batch (DeepLearning.AI)', url: 'https://www.deeplearning.ai/the-batch/rss/',                        category: 'Newsletters' },
      { name: 'Import AI (Jack Clark)', url: 'https://jack-clark.net/feed/',                                            category: 'Newsletters' },
    ],
    'crypto': [
      { name: 'CoinDesk',             url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',       category: 'News' },
      { name: 'The Block',            url: 'https://www.theblock.co/rss.xml',                       category: 'News' },
      { name: 'Decrypt',              url: 'https://decrypt.co/feed',                                category: 'News' },
      { name: 'CoinTelegraph',        url: 'https://cointelegraph.com/rss',                          category: 'News' },
      { name: 'DeFi Pulse Blog',      url: 'https://defipulse.com/blog/feed/',                       category: 'DeFi' },
      { name: 'Bankless',             url: 'https://newsletter.banklesshq.com/feed',                 category: 'Newsletters' },
      { name: 'Week in Ethereum',     url: 'https://weekinethereumnews.com/feed/',                   category: 'Ethereum' },
    ],
    'healthcare': [
      { name: 'STAT News',            url: 'https://www.statnews.com/feed/',                         category: 'News' },
      { name: 'Fierce Healthcare',    url: 'https://www.fiercehealthcare.com/rss/xml',               category: 'News' },
      { name: 'MobiHealthNews',       url: 'https://www.mobihealthnews.com/feed',                    category: 'Digital Health' },
      { name: 'Healthcare IT News',   url: 'https://www.healthcareitnews.com/feed',                  category: 'Health IT' },
      { name: 'Endpoints News',       url: 'https://endpts.com/feed/',                               category: 'Biotech' },
      { name: 'Fierce Biotech',       url: 'https://www.fiercebiotech.com/rss/xml',                  category: 'Biotech' },
    ],
    'climate': [
      { name: 'CleanTechnica',        url: 'https://cleantechnica.com/feed/',                        category: 'Clean Energy' },
      { name: 'Carbon Brief',         url: 'https://www.carbonbrief.org/feed/',                      category: 'Climate' },
      { name: 'Electrek',             url: 'https://electrek.co/feed/',                              category: 'EVs' },
      { name: 'Canary Media',         url: 'https://www.canarymedia.com/feed',                       category: 'Clean Energy' },
      { name: 'Grist',                url: 'https://grist.org/feed/',                                category: 'Climate' },
      { name: 'Inside Climate News',  url: 'https://insideclimatenews.org/feed/',                    category: 'Climate' },
    ],
    'fintech': [
      { name: 'Finextra',             url: 'https://www.finextra.com/rss/headlines.aspx',            category: 'News' },
      { name: 'TechCrunch Fintech',   url: 'https://techcrunch.com/category/fintech/feed/',          category: 'News' },
      { name: 'Finovate',             url: 'https://finovate.com/feed/',                             category: 'News' },
      { name: 'PaymentsSource',       url: 'https://www.paymentssource.com/feed',                    category: 'Payments' },
      { name: 'American Banker',      url: 'https://www.americanbanker.com/feed',                    category: 'Banking' },
    ],
    'cybersecurity': [
      { name: 'The Hacker News',      url: 'https://feeds.feedburner.com/TheHackersNews',            category: 'News' },
      { name: 'Krebs on Security',    url: 'https://krebsonsecurity.com/feed/',                      category: 'News' },
      { name: 'Dark Reading',         url: 'https://www.darkreading.com/rss.xml',                    category: 'News' },
      { name: 'BleepingComputer',     url: 'https://www.bleepingcomputer.com/feed/',                 category: 'News' },
      { name: 'Schneier on Security', url: 'https://www.schneier.com/feed/',                         category: 'Research' },
      { name: 'CISA Alerts',          url: 'https://www.cisa.gov/news.xml',                          category: 'Alerts' },
      { name: 'Threatpost',           url: 'https://threatpost.com/feed/',                           category: 'Threats' },
    ],
    'gaming': [
      { name: 'Kotaku',               url: 'https://kotaku.com/rss',                                 category: 'News' },
      { name: 'IGN',                  url: 'https://feeds.feedburner.com/ign/all',                   category: 'News' },
      { name: 'PC Gamer',             url: 'https://www.pcgamer.com/rss/',                           category: 'PC' },
      { name: 'Eurogamer',            url: 'https://www.eurogamer.net/feed',                         category: 'News' },
      { name: 'Rock Paper Shotgun',   url: 'https://www.rockpapershotgun.com/feed',                  category: 'PC' },
      { name: 'Polygon',              url: 'https://www.polygon.com/rss/index.xml',                  category: 'News' },
      { name: 'GamesIndustry.biz',    url: 'https://www.gamesindustry.biz/feed',                     category: 'Industry' },
    ],
  };
  // Fallback for custom or unknown niches
  SUGGESTED_BY_NICHE['custom'] = SUGGESTED_BY_NICHE['ai-tech'];


window.RSS_SUGGESTIONS=SUGGESTED_BY_NICHE;
})();
